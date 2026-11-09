import { resolveAny } from "node:dns/promises";
import { setTimeout as delay } from "node:timers/promises";
import { SafeWebFetcher, SearxngClient, assertPublicWebUrl } from "@nexus/web-search";
import type { OsintCollectorId, OsintMissionInput, OsintTarget } from "@nexus/osint";
import { fetchOsintPublicText } from "./osint-service.js";

export interface OsintFinding {
  url: string;
  title: string;
  content: string;
  targets: OsintTarget[];
  confidence: number;
}
export interface OsintCollector {
  id: OsintCollectorId;
  category: OsintMissionInput["config"]["sourceCategories"][number];
  minIntervalMs: number;
  supports(target: OsintTarget): boolean;
  collect(
    target: OsintTarget,
    config: OsintMissionInput["config"],
    signal: AbortSignal,
  ): Promise<OsintFinding[]>;
}

export function extractOsintTargets(content: string): OsintTarget[] {
  const emails = [...content.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi)].map(
    (m) => ({ type: "email" as const, value: m[0].toLowerCase() }),
  );
  const domains = [
    ...content.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi),
  ].map((m) => ({ type: "domain" as const, value: m[0].toLowerCase() }));
  return [
    ...new Map([...emails, ...domains].map((t) => [`${t.type}:${t.value}`, t])).values(),
  ].slice(0, 30);
}

export function createOsintCollectors(): OsintCollector[] {
  const pages = new SafeWebFetcher({ maxBytes: 1_000_000 });
  const domain = (t: OsintTarget) => t.type === "domain";
  const registry = (id: "rdap" | "crt", url: (v: string) => string): OsintCollector => ({
    id,
    category: "registry",
    minIntervalMs: 1500,
    supports: domain,
    async collect(t, _config, signal) {
      const source = url(encodeURIComponent(t.value));
      const content = await fetchOsintPublicText(source, signal);
      return [
        {
          url: source,
          title: `${id}: ${t.value}`,
          content,
          targets: extractOsintTargets(content),
          confidence: 0.85,
        },
      ];
    },
  });
  return [
    {
      id: "search",
      category: "web",
      minIntervalMs: 1000,
      supports: () => true,
      async collect(t, _config, signal) {
        const client = new SearxngClient({
          baseUrl: process.env.SEARXNG_URL ?? "http://127.0.0.1:18080",
        });
        const result = await client.search({ query: `"${t.value}"`, limit: 5 }, signal);
        const findings: OsintFinding[] = [];
        for (const item of result.results) {
          await assertPublicWebUrl(item.url);
          findings.push({
            url: item.url,
            title: item.title || item.url,
            content: item.snippet,
            targets: [{ type: "url", value: item.url }],
            confidence: 0.35,
          });
        }
        return findings;
      },
    },
    {
      id: "dns",
      category: "technical",
      minIntervalMs: 500,
      supports: domain,
      async collect(t, _config, signal) {
        signal.throwIfAborted();
        await assertPublicWebUrl(`https://${t.value}/`);
        const records = await resolveAny(t.value);
        return [
          {
            url: `https://dns.google/resolve?name=${encodeURIComponent(t.value)}`,
            title: `DNS: ${t.value}`,
            content: JSON.stringify(records),
            targets: records.flatMap((r) =>
              "address" in r ? [{ type: "ip" as const, value: r.address }] : [],
            ),
            confidence: 0.95,
          },
        ];
      },
    },
    registry("rdap", (v) => `https://rdap.org/domain/${v}`),
    registry("crt", (v) => `https://crt.sh/?q=${v}&output=json`),
    {
      id: "page",
      category: "web",
      minIntervalMs: 1000,
      supports: (t) => t.type === "url",
      async collect(t, _config, signal) {
        const doc = await pages.fetch({ url: t.value }, signal);
        return [
          {
            url: doc.finalUrl,
            title: doc.metadata.title,
            content: doc.content,
            targets: extractOsintTargets(doc.content),
            confidence: 0.5,
          },
        ];
      },
    },
    {
      id: "username",
      category: "social",
      minIntervalMs: 1500,
      supports: (t) => t.type === "username",
      async collect(t, config, signal) {
        const findings: OsintFinding[] = [];
        for (const template of config.usernameSites) {
          signal.throwIfAborted();
          // Every site request is throttled and validated, including redirects.
          await delay(1500, undefined, { signal });
          const url = template.replaceAll(
            "{username}",
            encodeURIComponent(t.value.replace(/^@/, "")),
          );
          try {
            const doc = await pages.fetch({ url }, signal);
            findings.push({
              url: doc.finalUrl,
              title: `Possible public profile: ${t.value}`,
              content: doc.content,
              targets: [],
              confidence: 0.3,
            });
          } catch (error) {
            // 404 means absent; all other failures remain visible to the mission.
            if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
          }
        }
        return findings;
      },
    },
    {
      id: "correlation",
      category: "technical",
      minIntervalMs: 0,
      supports: (t) => t.type === "email",
      // eslint-disable-next-line @typescript-eslint/require-await -- must stay async so validation errors reject instead of throwing synchronously
      async collect(t) {
        const value = t.value.split("@")[1];
        if (!value) throw new Error("Invalid email target");
        return [
          {
            url: `https://${value}/`,
            title: `Email domain correlation: ${t.value}`,
            content: `The supplied email ${t.value} uses domain ${value}. This does not establish ownership.`,
            targets: [{ type: "domain", value }],
            confidence: 0.95,
          },
        ];
      },
    },
  ];
}
