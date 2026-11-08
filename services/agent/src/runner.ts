import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
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

async function insideWorkspace(path: string, roots: string[]): Promise<boolean> {
  if (!isAbsolute(path)) return false;
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
  return roots.some((root) => {
    const distance = relative(root, candidate);
    return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
  });
}

async function permission(
  request: RequestPermissionRequest,
  roots: string[],
): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
  const locations = request.toolCall.locations ?? [];
  const locationsAllowed = (
    await Promise.all(locations.map((location) => insideWorkspace(location.path, roots)))
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

function extractOptionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const result: string[] = [];
  for (const item of options) {
    if (typeof item === "object" && item !== null) {
      if ("value" in item && typeof (item as { value: unknown }).value === "string") {
        result.push((item as { value: string }).value);
      } else if ("options" in item && Array.isArray((item as { options: unknown }).options)) {
        result.push(...extractOptionValues((item as { options: unknown }).options));
      }
    }
  }
  return result;
}

export async function runAcp(request: RunRequest): Promise<RunResult> {
  const workspace = await realpath(request.cwd);
  const profile = await loadProfile(request.registryPath, request.profile);
  if (profile.additional_dirs.some((path) => !isAbsolute(path))) {
    throw new Error("additional_directory_must_be_absolute");
  }
  const roots = [
    workspace,
    ...(await Promise.all(profile.additional_dirs.map((path) => realpath(path)))),
  ];

  const customEnv: NodeJS.ProcessEnv = {};
  if (profile.session_dir !== undefined) {
    await mkdir(profile.session_dir, { recursive: true, mode: 0o700 });
    customEnv.CLAUDE_CONFIG_DIR = profile.session_dir;
    customEnv.ANTIGRAVITY_CONFIG_DIR = profile.session_dir;
    customEnv.CODEX_CONFIG_DIR = profile.session_dir;
    customEnv.XDG_CONFIG_HOME = profile.session_dir;
  }
  for (const [key, val] of Object.entries(profile.env)) {
    customEnv[key] = val;
  }

  const child = spawn(profile.command, profile.args, {
    cwd: workspace,
    env: { ...cleanEnvironment(), ...customEnv },
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
      permission(context.params, roots),
    );
  try {
    return await client.connectWith(stream, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { session: { configOptions: {} } },
        clientInfo: { name: "nexus-acp-runtime", version: "1.0.0" },
      });
      return context.buildSession(workspace).withSession(async (session) => {
        let cleanPrompt = request.prompt;
        let dynamicModel: string | undefined = profile.model;
        let dynamicEffort: string | undefined = profile.reasoning_effort;

        const modelMatch = /\[Model Target:\s*([^\]]+)\]/i.exec(cleanPrompt);
        if (modelMatch?.[1]) {
          dynamicModel = modelMatch[1].trim();
          cleanPrompt = cleanPrompt.replace(/\[Model Target:\s*[^\]]+\]/gi, "").trim();
        }

        const effortMatch = /\[Reasoning Effort:\s*([^\]]+)\]/i.exec(cleanPrompt);
        if (effortMatch?.[1]) {
          dynamicEffort = effortMatch[1].trim();
          cleanPrompt = cleanPrompt.replace(/\[Reasoning Effort:\s*[^\]]+\]/gi, "").trim();
        }

        const supportedOptions = new Set(
          session.newSessionResponse.configOptions?.map((option) => option.id) ?? [],
        );
        const modelConfig = session.newSessionResponse.configOptions?.find(
          (option) => option.id === "model",
        );
        if (modelConfig && dynamicModel) {
          const allowedValues = extractOptionValues(
            "options" in modelConfig ? modelConfig.options : [],
          );
          let targetValue = dynamicModel;
          if (allowedValues.length > 0 && !allowedValues.includes(targetValue)) {
            const norm = targetValue.toLowerCase();
            if (norm.includes("sonnet") && allowedValues.includes("sonnet")) {
              targetValue = "sonnet";
            } else if (
              norm.includes("opus") &&
              !norm.includes("1m") &&
              allowedValues.includes("opus")
            ) {
              targetValue = "opus";
            } else if (
              norm.includes("opus") &&
              norm.includes("1m") &&
              allowedValues.includes("opus[1m]")
            ) {
              targetValue = "opus[1m]";
            } else if (norm.includes("haiku") && allowedValues.includes("haiku")) {
              targetValue = "haiku";
            } else if (norm.includes("fable") && allowedValues.includes("claude-fable-5[1m]")) {
              targetValue = "claude-fable-5[1m]";
            } else if (
              (norm.includes("astra") || norm.includes("o1") || norm.includes("o3")) &&
              allowedValues.includes("gpt-6-astra")
            ) {
              targetValue = "gpt-6-astra";
            } else if (norm.includes("sol") && allowedValues.includes("gpt-5.6-sol")) {
              targetValue = "gpt-5.6-sol";
            } else if (norm.includes("terra") && allowedValues.includes("gpt-5.6-terra")) {
              targetValue = "gpt-5.6-terra";
            } else if (norm.includes("luna") && allowedValues.includes("gpt-5.6-luna")) {
              targetValue = "gpt-5.6-luna";
            }
          }
          if (allowedValues.length === 0 || allowedValues.includes(targetValue)) {
            try {
              await context.request(acp.methods.agent.session.setConfigOption, {
                sessionId: session.sessionId,
                configId: "model",
                value: targetValue,
              });
            } catch {
              // Ignore if agent rejects specific model value
            }
          }
        }

        const configuredOptions = { ...profile.config_options };
        if (dynamicEffort !== undefined && dynamicEffort !== "auto") {
          const reasoningOption = session.newSessionResponse.configOptions?.find((option) =>
            ["reasoning_effort", "effort", "reasoning", "thought_level"].includes(option.id),
          );
          if (reasoningOption) {
            let effortValue = dynamicEffort;
            if (effortValue === "minimal") effortValue = "low";
            const allowedEfforts = extractOptionValues(
              "options" in reasoningOption ? reasoningOption.options : [],
            );
            if (allowedEfforts.length === 0 || allowedEfforts.includes(effortValue)) {
              configuredOptions[reasoningOption.id] = effortValue;
            }
          }
        }
        for (const [configId, value] of Object.entries(configuredOptions)) {
          if (!supportedOptions.has(configId)) continue;
          try {
            await context.request(acp.methods.agent.session.setConfigOption, {
              sessionId: session.sessionId,
              configId,
              value,
            });
          } catch {
            // Ignore if option fails
          }
        }
        const prompt =
          profile.system_prompt === undefined
            ? cleanPrompt
            : `${profile.system_prompt.trim()}\n\nUser mission:\n${cleanPrompt}`;
        void session.prompt(prompt);
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
