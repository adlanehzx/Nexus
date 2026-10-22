#!/usr/bin/env node
/**
 * Local deterministic ACP agent for end-to-end integration scenarios.
 *
 * This is a real agent communicating via ACP on stdin/stdout.
 * Instead of calling an external LLM API, it drives decisions via `--mode`:
 *
 *   --mode succeed          requests tool in workspace, then succeeds
 *   --mode refuse-outside   requests path outside workspace, verifying permission rejection
 *   --mode crash            terminates immediately to test profile fallback
 *   --mode review           returns strict JSON quality review verdict
 *
 * Standard output is strictly reserved for the ACP protocol stream.
 * Diagnostics are written to stderr.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const MODE = option("mode", "succeed");
const MARKER = option("marker", "no-marker");

/** Path deliberately outside any workspace. */
const FOREIGN_PATH = "/nexus-e2e-forbidden-path/elsewhere.txt";

/**
 * Extract upstream task keys and markers from injected dependency results.
 */
function upstream(text) {
  const block = /<DEPENDENCY_RESULTS>([\s\S]*?)<\/DEPENDENCY_RESULTS>/.exec(text);
  if (block === null) return { keys: [], markers: [] };
  const body = block[1];
  const keys = [...body.matchAll(/"task_key"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  const markers = [...body.matchAll(/(?:MARKER|MARQUEUR)=([a-z0-9_-]+)/gi)].map(
    (match) => match[1],
  );
  return { keys, markers };
}

function promptText(params) {
  return (params.prompt ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function requestPermission(cx, sessionId, path) {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Write file",
      kind: "edit",
      status: "pending",
      locations: [{ path }],
    },
  });
  const decision = await cx.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: {
      toolCallId: "tool-1",
      title: "Write file",
      kind: "edit",
      status: "pending",
      locations: [{ path }],
    },
    options: [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ],
  });
  if (decision.outcome.outcome === "cancelled") return "cancelled";
  return decision.outcome.optionId === "allow" ? "allowed" : "rejected";
}

async function say(cx, sessionId, text) {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

const sessions = new Set();

if (MODE === "crash") {
  process.stderr.write(`agent ${MARKER}: simulated transport failure\n`);
  process.exit(1);
}

acp
  .agent({ name: `nexus-e2e-${MODE}` })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => {
    const sessionId = `e2e-${MARKER}-${sessions.size + 1}`;
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest("authenticate", () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId } = ctx.params;
    const instruction = promptText(ctx.params);
    const { keys, markers } = upstream(instruction);

    if (MODE === "review") {
      await say(
        ctx.client,
        sessionId,
        JSON.stringify({
          verdict: "pass",
          summary: `review of ${keys.length} upstream task(s), markers ${markers.join("+") || "none"}`,
          corrective_instruction: "",
        }),
      );
      return { stopReason: "end_turn" };
    }

    const path = MODE === "refuse-outside" ? FOREIGN_PATH : `${process.cwd()}/note.txt`;
    const permission = await requestPermission(ctx.client, sessionId, path);

    await say(ctx.client, sessionId, `MARQUEUR=${MARKER} `);
    await say(
      ctx.client,
      sessionId,
      `PERMISSION=${permission} AMONT=${keys.join("+") || "none"} ` +
        `MARQUEURS_AMONT=${markers.join("+") || "none"}`,
    );
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => undefined)
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
