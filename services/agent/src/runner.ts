import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { loadProfile } from "./profiles.js";

export interface RunRequest {
  profile: string;
  cwd: string;
  prompt: string;
  registryPath: string;
}

export interface RunResult {
  response: string;
  stopReason: string;
}

const PRIVATE_ENVIRONMENT = new Set(["LOCAL_BACKEND_API_KEY"]);

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !PRIVATE_ENVIRONMENT.has(key)),
  );
}

async function insideWorkspace(path: string, workspace: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  const root = await realpath(workspace);
  let candidate = resolve(path);
  for (;;) {
    try {
      candidate = await realpath(candidate);
      break;
    } catch {
      const parent = resolve(candidate, "..");
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
  const distance = relative(root, candidate);
  return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
}

async function permission(
  request: RequestPermissionRequest,
  workspace: string,
): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
  const locations = request.toolCall.locations ?? [];
  const locationsAllowed = (
    await Promise.all(locations.map((location) => insideWorkspace(location.path, workspace)))
  ).every(Boolean);
  const destructiveWithoutLocation = request.toolCall.kind === "delete" && locations.length === 0;
  if (locationsAllowed && !destructiveWithoutLocation) {
    const allow = request.options.find((option) => option.kind === "allow_once");
    if (allow !== undefined) {
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
  }
  const reject = request.options.find((option) => option.kind === "reject_once");
  return reject === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: reject.optionId } };
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  force.unref();
}

export async function runAcp(request: RunRequest): Promise<RunResult> {
  const workspace = await realpath(request.cwd);
  const profile = await loadProfile(request.registryPath, request.profile);
  const child = spawn(profile.command, profile.args, {
    cwd: workspace,
    env: cleanEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const client = acp
    .client({ name: "nexus-acp-runtime" })
    .onRequest(acp.methods.client.session.requestPermission, async (context) =>
      permission(context.params, workspace),
    );
  try {
    return await client.connectWith(stream, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { session: { configOptions: {} } },
        clientInfo: { name: "nexus-acp-runtime", version: "1.0.0" },
      });
      return context.buildSession(workspace).withSession(async (session) => {
        const supportsModel = session.newSessionResponse.configOptions?.some(
          (option) => option.id === "model",
        );
        if (profile.model !== undefined && supportsModel === true) {
          await context.request(acp.methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: "model",
            value: profile.model,
          });
        }
        void session.prompt(request.prompt);
        let response = "";
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === "stop") {
            return { response, stopReason: message.stopReason };
          }
          const update = message.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            response += update.content.text;
          }
        }
      });
    });
  } catch (error) {
    const combined = `${error instanceof Error ? error.message : String(error)} ${stderr}`;
    const normalized = combined.toLowerCase();
    if (/auth|credential|unauthorized|login/.test(normalized)) {
      throw new Error("agent_auth_required", { cause: error });
    }
    if (/quota|usage.?limit/.test(normalized)) {
      throw new Error("agent_quota_exhausted", { cause: error });
    }
    if (/rate.?limit|429/.test(normalized)) {
      throw new Error("agent_rate_limited", { cause: error });
    }
    throw new Error("agent_transport", { cause: error });
  } finally {
    terminate(child);
  }
}
