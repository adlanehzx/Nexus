import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { makeApi, createAccount, type ApiHarness, type Account } from "./harness.js";

describe("Unified Fusion Routes (/api/v1)", () => {
  let harness: ApiHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await makeApi();
    account = await createAccount(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("Authentication & Path Security Enforcement", () => {
    it("rejects unauthenticated requests with 401 UNAUTHENTICATED", async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/providers/models",
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHENTICATED");
    });

    it("strictly blocks requests targeting system paths like /etc with 403", async () => {
      const res = await harness.app.inject({
        method: "POST",
        url: "/api/v1/checkpoints",
        headers: account.authorization,
        payload: {
          threadId: "thread-attack",
          turnNumber: 1,
          cwd: "/etc",
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });
  });

  describe("Providers & Catalog Routes", () => {
    it("GET /api/v1/providers/models returns canonical model catalog for authenticated user", async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/providers/models",
        headers: account.authorization,
      });

      if (res.statusCode !== 200) {
        console.error("GET /providers/models ERROR:", res.payload);
      }
      expect(res.statusCode).toBe(200);
      const body = res.json<{ models: { id: string }[] }>();
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.some((m) => m.id.includes("claude-3-7"))).toBe(true);
    });

    it("GET /api/v1/providers/capabilities returns supported drivers for authenticated user", async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/providers/capabilities",
        headers: account.authorization,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ providers: { id: string }[] }>();
      const driverIds = body.providers.map((p) => p.id);
      expect(driverIds).toContain("acp");
      expect(driverIds).toContain("claude");
      expect(driverIds).toContain("cursor");
      expect(driverIds).toContain("grok");
    });
  });

  describe("Source Control & PR Guides Routes", () => {
    it("POST and GET /api/v1/source-control/links with authenticated user", async () => {
      const createRes = await harness.app.inject({
        method: "POST",
        url: "/api/v1/source-control/links",
        headers: account.authorization,
        payload: {
          provider: "github",
          repoUrl: "https://github.com/adlanehzx/Nexus",
          pullRequestNumber: 42,
          branch: "feat/fusion",
          threadId: "test-thread-1",
        },
      });

      if (createRes.statusCode !== 201) {
        console.error("POST /source-control/links ERROR:", createRes.payload);
      }
      expect(createRes.statusCode).toBe(201);
      const createBody = createRes.json();
      expect(createBody.link.pullRequestNumber).toBe(42);

      const listRes = await harness.app.inject({
        method: "GET",
        url: "/api/v1/source-control/links?threadId=test-thread-1",
        headers: account.authorization,
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json();
      expect(listBody.links.length).toBeGreaterThan(0);
      expect(listBody.links[0].pullRequestNumber).toBe(42);
    });

    it("POST and GET /api/v1/source-control/guides with authenticated user", async () => {
      const createRes = await harness.app.inject({
        method: "POST",
        url: "/api/v1/source-control/guides",
        headers: account.authorization,
        payload: {
          repoUrl: "https://github.com/adlanehzx/Nexus",
          prNumber: 99,
          summary: "Architectural Guide for Fusion: Key changes and security implications.",
          architectureNotes: "Detailed architectural notes.",
        },
      });

      if (createRes.statusCode !== 201) {
        console.error("POST /source-control/guides ERROR:", createRes.payload);
      }
      expect(createRes.statusCode).toBe(201);
      const createBody = createRes.json();
      expect(createBody.guide.prNumber).toBe(99);

      const getRes = await harness.app.inject({
        method: "GET",
        url: "/api/v1/source-control/guides/99",
        headers: account.authorization,
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json();
      expect(getBody.guide.summary).toContain("Architectural Guide");
    });
  });

  describe("Checkpoints Routes", () => {
    it("captures checkpoint via POST /api/v1/checkpoints and retrieves it", async () => {
      const tmpTestDir = path.join(os.tmpdir(), `nexus-api-test-${Date.now()}`);
      await fs.mkdir(tmpTestDir, { recursive: true });

      const postRes = await harness.app.inject({
        method: "POST",
        url: "/api/v1/checkpoints",
        headers: account.authorization,
        payload: {
          threadId: "api-thread-1",
          turnNumber: 0,
          cwd: tmpTestDir,
          description: "Initial turn snapshot",
        },
      });

      expect(postRes.statusCode).toBe(201);
      const postBody = postRes.json();
      expect(postBody.checkpoint.turnNumber).toBe(0);

      const listRes = await harness.app.inject({
        method: "GET",
        url: "/api/v1/checkpoints/api-thread-1",
        headers: account.authorization,
      });

      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json();
      expect(listBody.checkpoints.length).toBeGreaterThanOrEqual(1);

      await fs.rm(tmpTestDir, { recursive: true, force: true });
    });
  });
});
