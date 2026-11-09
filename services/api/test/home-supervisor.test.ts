import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEC,
  HomeAssistantSupervisor,
  supervisorHandler,
  validateSpec,
  type DockerEngine,
} from "../src/home-supervisor/supervisor.js";
import { SupervisorSocketClient } from "../src/services/domotique/bundled-home-assistant.js";

/** In-memory Docker Engine: one image registry, one container. */
class FakeDocker implements DockerEngine {
  readonly calls: string[] = [];
  imagePresent = false;
  container: { running: boolean; body: Record<string, unknown> } | null = null;
  refuseStart = false;
  readonly created: Record<string, unknown>[] = [];

  call(method: "GET" | "POST", path: string, body?: unknown) {
    this.calls.push(`${method} ${path}`);
    const reply = (status: number, value: unknown = null) =>
      Promise.resolve({ status, body: value });
    if (method === "GET" && path.startsWith("/images/"))
      return reply(this.imagePresent ? 200 : 404);
    if (method === "GET" && path === "/containers/nexus-homeassistant/json") {
      return this.container === null
        ? reply(404)
        : reply(200, {
            State: { Running: this.container.running, StartedAt: "2026-11-10T08:00:00Z" },
          });
    }
    if (method === "GET" && path.startsWith("/containers/nexus-homeassistant/stats")) {
      return reply(200, {
        memory_stats: { usage: 300 * 1024 * 1024, stats: { inactive_file: 20 * 1024 * 1024 } },
      });
    }
    if (method === "POST" && path === "/containers/create?name=nexus-homeassistant") {
      this.created.push(body as Record<string, unknown>);
      this.container = { running: false, body: body as Record<string, unknown> };
      return reply(201, { Id: "abc" });
    }
    if (method === "POST" && path === "/containers/nexus-homeassistant/start") {
      if (this.refuseStart) return reply(500, { message: "port in use" });
      if (this.container) this.container.running = true;
      return reply(204);
    }
    if (method === "POST" && path.startsWith("/containers/nexus-homeassistant/stop")) {
      if (this.container === null) return reply(404);
      const was = this.container.running;
      this.container.running = false;
      return reply(was ? 204 : 304);
    }
    return reply(404);
  }

  async stream(_method: "POST", path: string, onLine: (line: Record<string, unknown>) => void) {
    this.calls.push(`POST ${path}`);
    onLine({ status: "Downloading", id: "layer1", progressDetail: { current: 50, total: 100 } });
    onLine({ status: "Downloading", id: "layer2", progressDetail: { current: 10, total: 300 } });
    await Promise.resolve();
    this.imagePresent = true;
    return 200;
  }
}

describe("home supervisor (bundled Home Assistant on/off)", () => {
  it("rejects specs that could be abused", () => {
    expect(() => validateSpec({ ...DEFAULT_SPEC, image: "evil image; rm -rf /" })).toThrow();
    expect(() => validateSpec({ ...DEFAULT_SPEC, containerName: "../x" })).toThrow();
    expect(() => validateSpec({ ...DEFAULT_SPEC, memoryLimitBytes: 1 })).toThrow();
  });

  it("downloads, creates with host networking + memory cap, starts, then reports memory use", async () => {
    const docker = new FakeDocker();
    const supervisor = new HomeAssistantSupervisor(docker);
    expect((await supervisor.status()).state).toBe("absent");

    const first = await supervisor.enable();
    expect(["pulling", "starting"]).toContain(first.state);
    await vi.waitFor(async () => expect((await supervisor.status()).state).toBe("running"));

    expect(docker.calls).toContain(
      "POST /images/create?fromImage=ghcr.io%2Fhome-assistant%2Fhome-assistant&tag=2026.10.4",
    );
    expect(docker.created[0]).toMatchObject({
      Image: "ghcr.io/home-assistant/home-assistant:2026.10.4",
      HostConfig: {
        NetworkMode: "host",
        RestartPolicy: { Name: "unless-stopped" },
        Binds: ["nexus_homeassistant-config:/config", "/etc/localtime:/etc/localtime:ro"],
        Memory: 1024 * 1024 * 1024,
      },
    });
    const status = await supervisor.status();
    expect(status.memoryUsageBytes).toBe(280 * 1024 * 1024);
    expect(status.memoryLimitBytes).toBe(1024 * 1024 * 1024);
  });

  it("stops on disable and keeps the container (configuration volume untouched)", async () => {
    const docker = new FakeDocker();
    docker.imagePresent = true;
    docker.container = { running: true, body: {} };
    const supervisor = new HomeAssistantSupervisor(docker);
    const stopped = await supervisor.disable();
    expect(stopped.state).toBe("stopped");
    expect(stopped.memoryUsageBytes).toBeNull();
    expect(docker.container).not.toBeNull();
    expect(docker.calls.some((c) => c.includes("DELETE") || c.includes("remove"))).toBe(false);
    // Re-enabling only starts it again: no new download, no second container.
    await supervisor.enable();
    await vi.waitFor(async () => expect((await supervisor.status()).state).toBe("running"));
    expect(docker.created).toHaveLength(0);
    expect(docker.calls.some((c) => c.startsWith("POST /images/create"))).toBe(false);
  });

  it("reports Docker refusals as an error state", async () => {
    const docker = new FakeDocker();
    docker.imagePresent = true;
    docker.refuseStart = true;
    const supervisor = new HomeAssistantSupervisor(docker);
    await supervisor.enable();
    await vi.waitFor(async () => expect((await supervisor.status()).state).toBe("error"));
    expect((await supervisor.status()).error).toMatch(/refused to start/);
  });
});

describe("API client over the private Unix socket", () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(() => {
    server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("drives the supervisor through its three fixed routes only", async () => {
    dir = mkdtempSync(join(tmpdir(), "nexus-home-"));
    const socketPath = join(dir, "supervisor.sock");
    const docker = new FakeDocker();
    docker.imagePresent = true;
    server = createServer(supervisorHandler(new HomeAssistantSupervisor(docker)));
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

    const client = new SupervisorSocketClient(socketPath);
    expect(await client.status()).toMatchObject({ available: true, state: "absent" });
    await client.setEnabled(true);
    await vi.waitFor(async () => expect(await client.status()).toMatchObject({ state: "running" }));
    expect(await client.setEnabled(false)).toMatchObject({ available: true, state: "stopped" });

    const other = await new Promise<number>((resolve) => {
      const req = request({ socketPath, method: "POST", path: "/containers/create" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(other).toBe(404);
  });

  it("reports 'unavailable' when no supervisor runs", async () => {
    const client = new SupervisorSocketClient("/nonexistent/nexus-home.sock");
    expect(await client.status()).toMatchObject({ available: false });
  });
});
