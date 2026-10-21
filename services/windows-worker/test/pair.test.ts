import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairWorker } from "../src/pair.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("appairage guide du worker", () => {
  it("envoie seulement la cle publique et produit une configuration utilisable", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-pair-"));
    temporary.push(root);
    const keyPath = join(root, "device.key");
    const envPath = join(root, "worker.env");
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("corps JSON attendu");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.token).toBe("ticket-secret-a-usage-unique");
      expect(String(body.publicKeyPem)).toContain("BEGIN PUBLIC KEY");
      expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "device-123" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const result = await pairWorker({
      apiUrl: "https://nexus.example.test/",
      token: "ticket-secret-a-usage-unique",
      name: "PC bureau",
      keyPath,
      envPath,
      allowedPaths: ["C:\\Projets"],
      fetchImpl: request,
    });

    expect(result.deviceId).toBe("device-123");
    expect(readFileSync(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("DEVICE_ID=device-123");
    expect(env).toContain("NEXUS_BACKEND_URL=https://nexus.example.test");
    expect(env).toContain("NEXUS_WORKER_PLATFORM=WINDOWS");
    expect(env).not.toContain("ticket-secret-a-usage-unique");
    expect(request).toHaveBeenCalledOnce();
  });

  it("enregistre un worker Linux sans changer le protocole de preuve", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-pair-linux-"));
    temporary.push(root);
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("corps JSON attendu");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body).toMatchObject({ type: "LINUX", platform: "LINUX", role: "WORKER" });
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "linux-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await pairWorker({
      apiUrl: "https://nexus.example.test",
      token: "ticket-secret-a-usage-unique",
      name: "Raspberry Pi",
      keyPath: join(root, "device.key"),
      envPath: join(root, "worker.env"),
      allowedPaths: ["/workspace"],
      platform: "LINUX",
      fetchImpl: request,
    });
    expect(readFileSync(join(root, "worker.env"), "utf8")).toContain("NEXUS_WORKER_PLATFORM=LINUX");
  });

  it("refuse le HTTP distant avant de creer une cle", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-pair-"));
    temporary.push(root);
    await expect(
      pairWorker({
        apiUrl: "http://192.168.1.20:3000",
        token: "ticket",
        name: "PC",
        keyPath: join(root, "device.key"),
        envPath: join(root, "worker.env"),
        allowedPaths: [],
      }),
    ).rejects.toThrow("https://");
  });

  it("ne remplace jamais une identite existante", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-pair-"));
    temporary.push(root);
    const keyPath = join(root, "device.key");
    const envPath = join(root, "worker.env");
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { id: "device-123" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await pairWorker({
      apiUrl: "http://127.0.0.1:3000",
      token: "first",
      name: "PC",
      keyPath,
      envPath,
      allowedPaths: [],
      fetchImpl: request,
    });
    await expect(
      pairWorker({
        apiUrl: "http://127.0.0.1:3000",
        token: "second",
        name: "PC",
        keyPath,
        envPath,
        allowedPaths: [],
        fetchImpl: request,
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
});
