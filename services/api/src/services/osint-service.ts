import { resolveAny, lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect } from "node:tls";
import {
  InMemoryOsintCaseStore,
  importEvidenceDataset,
  osintInvestigationSchema,
  queryShodan,
  queryVirusTotal,
  renderOsintMarkdown,
  renderOsintPdf,
  type ArchivedEvidence,
  type OsintAlert,
  type OsintCaseRecord,
  type OsintEntity,
  type OsintInvestigation,
  type OsintRelation,
  type OsintWatch,
} from "@nexus/osint";
import type { KeyringVault, RuntimeConfigurationStore } from "./runtime-configuration.js";

export type OsintEnrichmentProvider =
  "dns" | "rdap" | "certificate" | "company_registry" | "virustotal" | "shodan";

export class OsintService {
  readonly #runtime: RuntimeConfigurationStore | undefined;
  readonly #vault: KeyringVault | undefined;
  #store: InMemoryOsintCaseStore | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { runtime?: RuntimeConfigurationStore; vault?: KeyringVault } = {}) {
    this.#runtime = options.runtime;
    this.#vault = options.vault;
  }

  async list(ownerId: string): Promise<OsintCaseRecord[]> {
    return (await this.#load()).list(ownerId);
  }

  async get(ownerId: string, caseId: string): Promise<OsintCaseRecord | undefined> {
    return (await this.#load()).get(ownerId, caseId);
  }

  create(ownerId: string, investigation: OsintInvestigation): Promise<OsintCaseRecord> {
    return this.#mutate((store) =>
      store.create(ownerId, osintInvestigationSchema.parse(investigation)),
    );
  }

  addEvidence(
    ownerId: string,
    caseId: string,
    input: Omit<
      ArchivedEvidence,
      "id" | "caseId" | "contentHash" | "contentSnapshot" | "observedAt"
    > & {
      content: string;
    },
  ): Promise<ArchivedEvidence> {
    return this.#mutate((store) => store.addEvidence(ownerId, caseId, input));
  }

  async importEvidence(
    ownerId: string,
    caseId: string,
    dataset: string,
  ): Promise<ArchivedEvidence[]> {
    const rows = importEvidenceDataset(dataset);
    if (rows.length > 500) throw new Error("A dataset may contain at most 500 evidence rows.");
    return this.#mutate((store) => rows.map((row) => store.addEvidence(ownerId, caseId, row)));
  }

  addEntity(ownerId: string, caseId: string, input: Omit<OsintEntity, "id">): Promise<OsintEntity> {
    return this.#mutate((store) => store.addEntity(ownerId, caseId, input));
  }

  addRelation(
    ownerId: string,
    caseId: string,
    input: Omit<OsintRelation, "id">,
  ): Promise<OsintRelation> {
    return this.#mutate((store) => store.addRelation(ownerId, caseId, input));
  }

  addWatch(
    ownerId: string,
    caseId: string,
    query: string,
    intervalMinutes: number,
  ): Promise<OsintWatch> {
    return this.#mutate((store) => store.addWatch(ownerId, caseId, query, intervalMinutes));
  }

  evaluateWatch(
    ownerId: string,
    caseId: string,
    watchId: string,
    content: string,
  ): Promise<OsintAlert | undefined> {
    return this.#mutate((store) => store.evaluateWatch(ownerId, caseId, watchId, content));
  }

  acknowledgeAlert(ownerId: string, caseId: string, alertId: string): Promise<OsintAlert> {
    return this.#mutate((store) => store.acknowledgeAlert(ownerId, caseId, alertId));
  }

  async report(
    ownerId: string,
    caseId: string,
    format: "markdown" | "pdf",
  ): Promise<string | Uint8Array> {
    const record = await this.#required(ownerId, caseId);
    return format === "pdf" ? renderOsintPdf(record) : renderOsintMarkdown(record);
  }

  async enrich(
    ownerId: string,
    caseId: string,
    provider: OsintEnrichmentProvider,
    query: string,
    secretRef?: string,
  ): Promise<ArchivedEvidence> {
    await this.#required(ownerId, caseId);
    const normalized = query.trim().toLowerCase();
    let raw: unknown;
    let title: string;
    if (provider === "dns") {
      await resolvePublicAddress(normalized);
      raw = await resolveAny(normalized);
      title = `DNS records for ${normalized}`;
    } else if (provider === "rdap") {
      await resolvePublicAddress(normalized);
      raw = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(normalized)}`);
      title = `RDAP registration for ${normalized}`;
    } else if (provider === "certificate") {
      const address = await resolvePublicAddress(normalized);
      raw = await readCertificate(normalized, address);
      title = `TLS certificate for ${normalized}`;
    } else if (provider === "company_registry") {
      if (normalized.length < 2 || normalized.length > 200)
        throw new Error("A company name or registration number is required.");
      raw = {
        query: normalized,
        officialSearches: [
          `https://annuaire-entreprises.data.gouv.fr/rechercher?terme=${encodeURIComponent(normalized)}`,
          `https://find-and-update.company-information.service.gov.uk/search?q=${encodeURIComponent(normalized)}`,
          "https://e-justice.europa.eu/topics/registers-business-insolvency-land/business-registers-search-company-eu/general-information-find-company_en",
        ],
        note: "Discovery links only. Verify every selected registry record before treating it as evidence.",
      };
      title = `Official company registry searches for ${normalized}`;
    } else {
      if (secretRef === undefined || this.#vault === undefined)
        throw new Error("This provider requires a configured vault secret reference.");
      const apiKey = await this.#vault.get(secretRef);
      if (apiKey === undefined) throw new Error("The configured enrichment secret is unavailable.");
      const finding =
        provider === "virustotal"
          ? await queryVirusTotal(normalized, apiKey)
          : await queryShodan(normalized, apiKey);
      raw = finding.raw;
      title = `${provider === "virustotal" ? "VirusTotal" : "Shodan"} enrichment for ${normalized}`;
    }
    const content = JSON.stringify(raw);
    return this.addEvidence(ownerId, caseId, {
      url: enrichmentSourceUrl(provider, normalized),
      title,
      excerpt: content.slice(0, 800),
      reliability:
        provider === "rdap" || provider === "dns" || provider === "certificate"
          ? "primary"
          : provider === "company_registry"
            ? "unverified"
            : "corroborated",
      content,
    });
  }

  async runDueWatches(now = new Date()): Promise<{ checked: number; alerts: number }> {
    const store = await this.#load();
    const due = store.snapshot().flatMap((record) =>
      record.watches
        .filter((watch) => {
          if (!watch.enabled) return false;
          const last = watch.lastCheckedAt === undefined ? 0 : Date.parse(watch.lastCheckedAt);
          return now.getTime() - last >= watch.intervalMinutes * 60_000;
        })
        .map((watch) => ({ ownerId: record.ownerId, caseId: record.id, watch })),
    );
    let checked = 0;
    let alerts = 0;
    for (const item of due) {
      try {
        const url = new URL(item.watch.query);
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "") continue;
        const address = await resolvePublicAddress(url.hostname);
        const alert = await this.evaluateWatch(
          item.ownerId,
          item.caseId,
          item.watch.id,
          await readPinnedPublicPage(url, address),
        );
        checked += 1;
        if (alert !== undefined) alerts += 1;
      } catch {
        // A single unavailable source must not stop the remaining watches.
      }
    }
    return { checked, alerts };
  }

  async #load(): Promise<InMemoryOsintCaseStore> {
    if (this.#store !== undefined) return this.#store;
    this.#store = new InMemoryOsintCaseStore((await this.#runtime?.loadOsintCases()) ?? []);
    return this.#store;
  }

  async #required(ownerId: string, caseId: string): Promise<OsintCaseRecord> {
    const record = await this.get(ownerId, caseId);
    if (record === undefined) throw new Error("OSINT case not found.");
    return record;
  }

  #mutate<T>(operation: (store: InMemoryOsintCaseStore) => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue = this.#queue.then(async () => {
        try {
          const store = await this.#load();
          const result = operation(store);
          await this.#runtime?.saveOsintCases(store.snapshot());
          resolve(result);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("OSINT operation failed."));
        }
      });
    });
  }
}

async function resolvePublicAddress(hostname: string): Promise<string> {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname))
    throw new Error("A valid public hostname is required.");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address)))
    throw new Error("Private, loopback, link-local, and unresolved targets are not allowed.");
  return addresses[0]!.address;
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const normalized = address.toLowerCase();
  return (
    isIP(address) === 6 &&
    !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:")
    )
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Public registry request failed (${response.status}).`);
  return response.json();
}

function readCertificate(hostname: string, address: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host: address, port: 443, servername: hostname, timeout: 8_000 },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        resolve({
          subject: certificate.subject,
          issuer: certificate.issuer,
          subjectaltname: certificate.subjectaltname,
          valid_from: certificate.valid_from,
          valid_to: certificate.valid_to,
          fingerprint256: certificate.fingerprint256,
        });
      },
    );
    socket.once("timeout", () => socket.destroy(new Error("TLS certificate lookup timed out.")));
    socket.once("error", reject);
  });
}

function readPinnedPublicPage(url: URL, address: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: address,
        servername: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host, "user-agent": "NEXUS-OSINT-Watch/1.0" },
        timeout: 15_000,
      },
      (response) => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          response.resume();
          reject(new Error(`Public watch request failed (${response.statusCode ?? 0}).`));
          return;
        }
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > 1_000_000) {
          response.destroy(new Error("Public watch response exceeds one megabyte."));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > 1_000_000)
            response.destroy(new Error("Public watch response exceeds one megabyte."));
          else chunks.push(chunk);
        });
        response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.once("error", reject);
      },
    );
    request.once("timeout", () => request.destroy(new Error("Public watch request timed out.")));
    request.once("error", reject);
    request.end();
  });
}

function enrichmentSourceUrl(provider: OsintEnrichmentProvider, query: string): string {
  if (provider === "rdap") return `https://rdap.org/domain/${encodeURIComponent(query)}`;
  if (provider === "virustotal")
    return `https://www.virustotal.com/gui/domain/${encodeURIComponent(query)}`;
  if (provider === "shodan") return `https://www.shodan.io/host/${encodeURIComponent(query)}`;
  if (provider === "company_registry")
    return `https://annuaire-entreprises.data.gouv.fr/rechercher?terme=${encodeURIComponent(query)}`;
  return `https://${query}/`;
}
