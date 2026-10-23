import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogService,
} from "../src/services/connection-manager.js";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const detectedCodex: ConnectionCatalogEntry = {
  providerId: "codex",
  displayName: "Codex",
  kind: "acp",
  platforms: ["linux", "darwin"],
  supportedOnThisHost: true,
  actions: ["detect", "test", "open_docs"],
  docsUrl: "https://developers.openai.com/codex/cli/",
  adapter: {
    provenance: "unknown",
    provenanceEvidence: "No publisher provenance has been established.",
  },
  observation: {
    id: "acp:codex",
    providerId: "codex",
    kind: "acp",
    displayName: "Codex",
    state: "detected",
    version: "1.2.3",
    executablePath: "/usr/bin/codex",
    capabilities: [],
    availableActions: ["test", "open_docs"],
    platform: "linux",
    lastCheckedAt: "2026-10-22T10:00:00.000Z",
    lastSuccessAt: "2026-10-22T10:00:00.000Z",
    authStatus: "unknown",
    errorCategory: null,
    userMessage: null,
    requiresHumanAction: false,
    adapter: {
      availability: "unknown",
      provenance: "unknown",
      provenanceEvidence: "No publisher provenance has been established.",
    },
  },
};

const catalog = [detectedCodex];
const disconnectedCodex = { ...detectedCodex, observation: null };
const fakeConnections = {
  list: vi.fn(() => catalog),
  detectAll: vi.fn(() => Promise.resolve(catalog)),
  test: vi.fn(() => Promise.resolve(detectedCodex)),
  connect: vi.fn(() => Promise.resolve(detectedCodex)),
  disconnect: vi.fn(() => Promise.resolve(disconnectedCodex)),
} satisfies ConnectionCatalogService;

let harness: ApiHarness;
let admin: Account;
let member: Account;

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await makeApi({ connectionManager: fakeConnections });
  admin = await createAccount(harness, "admin-connections@example.test");
  member = await createAccount(harness, "member-connections@example.test");
});

afterEach(async () => harness.close());

describe("connection routes", () => {
  it("reserves connection discovery for administrators", async () => {
    const anonymous = await harness.app.inject({ method: "GET", url: "/api/v1/connections" });
    expect(anonymous.statusCode).toBe(401);

    const forbidden = await harness.app.inject({
      method: "GET",
      url: "/api/v1/connections",
      headers: member.authorization,
    });
    expect(forbidden.statusCode).toBe(403);

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/connections",
      headers: admin.authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ connections: catalog });
  });

  it("runs only the server-declared scan and provider test", async () => {
    const scan = await harness.app.inject({
      method: "POST",
      url: "/api/v1/connections/detect",
      headers: admin.authorization,
    });
    expect(scan.statusCode).toBe(200);
    expect(fakeConnections.detectAll).toHaveBeenCalledOnce();

    const test = await harness.app.inject({
      method: "POST",
      url: "/api/v1/connections/codex/test",
      headers: admin.authorization,
    });
    expect(test.statusCode).toBe(200);
    expect(fakeConnections.test).toHaveBeenCalledWith("codex");

    const connect = await harness.app.inject({
      method: "POST",
      url: "/api/v1/connections/codex/connect",
      headers: admin.authorization,
    });
    expect(connect.statusCode).toBe(200);
    expect(fakeConnections.connect).toHaveBeenCalledWith("codex");

    const disconnect = await harness.app.inject({
      method: "POST",
      url: "/api/v1/connections/codex/disconnect",
      headers: admin.authorization,
    });
    expect(disconnect.statusCode).toBe(200);
    expect(fakeConnections.disconnect).toHaveBeenCalledWith("codex");
  });

  it("rejects command-shaped provider identifiers before reaching the service", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/connections/codex%3Btouch%20tmp/test",
      headers: admin.authorization,
    });
    expect(response.statusCode).toBe(400);
    expect(fakeConnections.test).not.toHaveBeenCalled();
  });
});
