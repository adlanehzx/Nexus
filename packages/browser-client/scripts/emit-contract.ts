/**
 * Exports contract as JSON Schema for the Python worker.
 *
 * This file is validated by the contract tests on the Python side:
 * a mismatch breaks the build, not production (see R7).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BROWSER_PROTOCOL_VERSION,
  browserEventSchema,
  createSessionRequestSchema,
  healthSchema,
  runTaskRequestSchema,
  sessionSchema,
  taskSchema,
} from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../services/browser-worker/contract/browser-protocol.json");

const contract = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  generatedFrom: "@nexus/browser-client/src/protocol.ts",
  schemas: {
    CreateSessionRequest: z.toJSONSchema(createSessionRequestSchema, { io: "input" }),
    Session: z.toJSONSchema(sessionSchema, { io: "output" }),
    RunTaskRequest: z.toJSONSchema(runTaskRequestSchema, { io: "input" }),
    Task: z.toJSONSchema(taskSchema, { io: "output" }),
    BrowserEvent: z.toJSONSchema(browserEventSchema, { io: "output" }),
    Health: z.toJSONSchema(healthSchema, { io: "output" }),
  },
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
process.stdout.write(`contract written: ${out}\n`);
