import { createSocket, type Socket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

/**
 * Minimal multicast DNS (RFC 6762 / DNS-SD RFC 6763), no dependency.
 *
 * - `MdnsResponder` advertises NEXUS as `_nexus._tcp.local` so a freshly
 *   flashed ESP32 finds the API on any LAN without typing an address.
 * - `mdnsBrowse` looks for a service type, e.g. `_home-assistant._tcp.local`,
 *   so NEXUS finds Home Assistant by itself.
 *
 * Only what those two jobs need: PTR, SRV, TXT, A (AAAA decoded), no
 * conflict resolution beyond answering for our own unique instance name.
 */

export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 } as const;

export interface DnsQuestion {
  name: string;
  type: number;
}

export type DnsRecord =
  | { name: string; type: 1; ttl: number; data: string }
  | { name: string; type: 28; ttl: number; data: string }
  | { name: string; type: 12; ttl: number; data: string }
  | { name: string; type: 16; ttl: number; data: Record<string, string> }
  | { name: string; type: 33; ttl: number; data: { port: number; target: string } };

export interface DnsMessage {
  id: number;
  response: boolean;
  questions: DnsQuestion[];
  answers: DnsRecord[];
}

// ── Codec ────────────────────────────────────────────────────────────────

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  const chunks: Buffer[] = [];
  for (const label of parts) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function encodeRdata(record: DnsRecord): Buffer {
  switch (record.type) {
    case TYPE.A:
      return Buffer.from(record.data.split(".").map(Number));
    case TYPE.AAAA: {
      const out = Buffer.alloc(16);
      const halves = record.data.split("::");
      const head = (halves[0] ?? "").split(":").filter(Boolean);
      const tail = (halves[1] ?? "").split(":").filter(Boolean);
      const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
      groups.forEach((g, i) => out.writeUInt16BE(Number.parseInt(g, 16), i * 2));
      return out;
    }
    case TYPE.PTR:
      return encodeName(record.data);
    case TYPE.TXT: {
      const entries = Object.entries(record.data).map(([k, v]) => {
        const bytes = Buffer.from(`${k}=${v}`, "utf8");
        return Buffer.concat([Buffer.from([Math.min(255, bytes.length)]), bytes.subarray(0, 255)]);
      });
      return entries.length === 0 ? Buffer.from([0]) : Buffer.concat(entries);
    }
    case TYPE.SRV: {
      const head = Buffer.alloc(6);
      head.writeUInt16BE(0, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(record.data.port, 4);
      return Buffer.concat([head, encodeName(record.data.target)]);
    }
  }
}

export function encodeMessage(message: DnsMessage): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.id, 0);
  header.writeUInt16BE(message.response ? 0x8400 : 0, 2);
  header.writeUInt16BE(message.questions.length, 4);
  header.writeUInt16BE(message.answers.length, 6);
  const parts: Buffer[] = [header];
  for (const q of message.questions) {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(1, 2);
    parts.push(encodeName(q.name), tail);
  }
  for (const record of message.answers) {
    const rdata = encodeRdata(record);
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(record.type, 0);
    // Cache-flush bit for unique records (everything but shared PTR).
    meta.writeUInt16BE(record.type === TYPE.PTR ? 1 : 0x8001, 2);
    meta.writeUInt32BE(record.ttl, 4);
    meta.writeUInt16BE(rdata.length, 8);
    parts.push(encodeName(record.name), meta, rdata);
  }
  return Buffer.concat(parts);
}

function decodeName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  for (let guard = 0; guard < 128; guard += 1) {
    const len = buf.readUInt8(pos);
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const pointer = buf.readUInt16BE(pos) & 0x3fff;
      if (next === -1) next = pos + 2;
      pos = pointer;
      continue;
    }
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join("."), next: next === -1 ? pos : next };
}

/** Decodes a packet; malformed input throws (callers ignore the packet). */
export function decodeMessage(buf: Buffer): DnsMessage {
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qd; i += 1) {
    const { name, next } = decodeName(buf, pos);
    questions.push({ name, type: buf.readUInt16BE(next) });
    pos = next + 4;
  }
  const answers: DnsRecord[] = [];
  for (let i = 0; i < an; i += 1) {
    const { name, next } = decodeName(buf, pos);
    const type = buf.readUInt16BE(next);
    const ttl = buf.readUInt32BE(next + 4);
    const length = buf.readUInt16BE(next + 8);
    const start = next + 10;
    const end = start + length;
    if (type === TYPE.A && length === 4) {
      answers.push({ name, type: TYPE.A, ttl, data: [...buf.subarray(start, end)].join(".") });
    } else if (type === TYPE.AAAA && length === 16) {
      const groups: string[] = [];
      for (let g = 0; g < 8; g += 1) groups.push(buf.readUInt16BE(start + g * 2).toString(16));
      answers.push({ name, type: TYPE.AAAA, ttl, data: groups.join(":") });
    } else if (type === TYPE.PTR) {
      answers.push({ name, type: TYPE.PTR, ttl, data: decodeName(buf, start).name });
    } else if (type === TYPE.SRV) {
      answers.push({
        name,
        type: TYPE.SRV,
        ttl,
        data: { port: buf.readUInt16BE(start + 4), target: decodeName(buf, start + 6).name },
      });
    } else if (type === TYPE.TXT) {
      const data: Record<string, string> = {};
      let p = start;
      while (p < end) {
        const len = buf.readUInt8(p);
        const entry = buf.toString("utf8", p + 1, p + 1 + len);
        const eq = entry.indexOf("=");
        if (eq > 0) data[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
        p += 1 + len;
      }
      answers.push({ name, type: TYPE.TXT, ttl, data });
    }
    pos = end;
  }
  return { id, response: (flags & 0x8000) !== 0, questions, answers };
}

// ── Advertising ──────────────────────────────────────────────────────────

export interface ServiceAdvertisement {
  /** e.g. `_nexus._tcp.local` */
  readonly type: string;
  /** Instance label, e.g. `NEXUS on studio` */
  readonly instance: string;
  readonly port: number;
  readonly txt: Record<string, string>;
  /** `<host>.local` */
  readonly host: string;
  readonly addresses: readonly string[];
}

const lower = (s: string) => s.toLowerCase().replace(/\.$/, "");

/** Records answering `questions` for `service`, or none. Pure; unit-tested. */
export function answersFor(
  questions: readonly DnsQuestion[],
  service: ServiceAdvertisement,
): DnsRecord[] {
  const instanceName = `${service.instance}.${service.type}`;
  const ptr: DnsRecord = { name: service.type, type: TYPE.PTR, ttl: 4_500, data: instanceName };
  const srv: DnsRecord = {
    name: instanceName,
    type: TYPE.SRV,
    ttl: 120,
    data: { port: service.port, target: service.host },
  };
  const txt: DnsRecord = { name: instanceName, type: TYPE.TXT, ttl: 4_500, data: service.txt };
  const a: DnsRecord[] = service.addresses.map((ip) => ({
    name: service.host,
    type: TYPE.A,
    ttl: 120,
    data: ip,
  }));
  const out: DnsRecord[] = [];
  for (const q of questions) {
    const name = lower(q.name);
    const any = q.type === TYPE.ANY;
    if (name === lower(service.type) && (q.type === TYPE.PTR || any)) out.push(ptr, srv, txt, ...a);
    else if (name === "_services._dns-sd._udp.local" && (q.type === TYPE.PTR || any)) {
      out.push({
        name: "_services._dns-sd._udp.local",
        type: TYPE.PTR,
        ttl: 4_500,
        data: service.type,
      });
    } else if (name === lower(instanceName)) {
      if (q.type === TYPE.SRV || any) out.push(srv, ...a);
      if (q.type === TYPE.TXT || any) out.push(txt);
    } else if (name === lower(service.host) && (q.type === TYPE.A || any)) out.push(...a);
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.name}|${String(r.type)}|${JSON.stringify(r.data)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address);
    }
  }
  return out;
}

export function defaultHostLabel(): string {
  const label =
    hostname()
      .split(".")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, "-") ?? "nexus";
  return label === "" ? "nexus" : label;
}

export class MdnsResponder {
  readonly #service: () => ServiceAdvertisement;
  #socket: Socket | undefined;
  readonly #onError: (error: unknown) => void;

  constructor(
    service: () => ServiceAdvertisement,
    onError: (error: unknown) => void = () => undefined,
  ) {
    this.#service = service;
    this.#onError = onError;
  }

  start(): void {
    if (this.#socket !== undefined) return;
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.#socket = socket;
    socket.on("error", (error) => this.#onError(error));
    socket.on("message", (packet, rinfo) => {
      let message: DnsMessage;
      try {
        message = decodeMessage(packet);
      } catch {
        return;
      }
      if (message.response || message.questions.length === 0) return;
      const answers = answersFor(message.questions, this.#service());
      if (answers.length === 0) return;
      if (rinfo.port !== MDNS_PORT) {
        // Legacy unicast query (RFC 6762 §6.7): answer the sender directly,
        // echoing id and questions.
        this.#send(
          { id: message.id, response: true, questions: message.questions, answers },
          rinfo.address,
          rinfo.port,
        );
        return;
      }
      this.#send({ id: 0, response: true, questions: [], answers });
    });
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
        socket.setMulticastTTL(255);
      } catch (error) {
        this.#onError(error);
      }
      // Unsolicited announcement (RFC 6762 §8.3), twice, one second apart.
      const announce = () =>
        this.#send({
          id: 0,
          response: true,
          questions: [],
          answers: answersFor([{ name: this.#service().type, type: TYPE.PTR }], this.#service()),
        });
      announce();
      setTimeout(announce, 1_000).unref();
    });
  }

  stop(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  #send(message: DnsMessage, address = MDNS_ADDRESS, port = MDNS_PORT): void {
    try {
      this.#socket?.send(encodeMessage(message), port, address);
    } catch (error) {
      this.#onError(error);
    }
  }
}

// ── Browsing ─────────────────────────────────────────────────────────────

export interface DiscoveredService {
  readonly instance: string;
  readonly host: string | null;
  readonly port: number | null;
  readonly addresses: string[];
  readonly txt: Record<string, string>;
}

/** Folds mDNS answers into services of `type`. Pure; unit-tested. */
export function collectServices(type: string, records: readonly DnsRecord[]): DiscoveredService[] {
  const wanted = lower(type);
  const instances = new Set(
    records
      .filter((r) => r.type === TYPE.PTR && lower(r.name) === wanted)
      .map((r) => lower(r.data as string)),
  );
  return [...instances].map((instance) => {
    const srv = records.find((r) => r.type === TYPE.SRV && lower(r.name) === instance);
    const txt = records.find((r) => r.type === TYPE.TXT && lower(r.name) === instance);
    const host = srv?.type === TYPE.SRV ? lower(srv.data.target) : null;
    const addresses = records
      .filter((r) => r.type === TYPE.A && host !== null && lower(r.name) === host)
      .map((r) => r.data as string);
    return {
      instance,
      host,
      port: srv?.type === TYPE.SRV ? srv.data.port : null,
      addresses: [...new Set(addresses)],
      txt: txt?.type === TYPE.TXT ? txt.data : {},
    };
  });
}

/** One-shot multicast query. Resolves with whatever answered within `timeoutMs`. */
export function mdnsBrowse(type: string, timeoutMs = 2_000): Promise<DiscoveredService[]> {
  return new Promise((resolve) => {
    const records: DnsRecord[] = [];
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const finish = () => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(collectServices(type, records));
    };
    socket.on("error", finish);
    socket.on("message", (packet) => {
      try {
        const message = decodeMessage(packet);
        if (message.response) records.push(...message.answers);
      } catch {
        // ignore malformed packets
      }
    });
    socket.bind(0, () => {
      try {
        socket.send(
          encodeMessage({
            id: 0,
            response: false,
            questions: [{ name: type, type: TYPE.PTR }],
            answers: [],
          }),
          MDNS_PORT,
          MDNS_ADDRESS,
        );
      } catch {
        finish();
        return;
      }
      setTimeout(finish, timeoutMs).unref();
    });
  });
}
