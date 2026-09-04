/**
 * Exporte le contrat en JSON Schema pour le worker Python.
 *
 * C'est ce fichier que le test de contrat côté Python valide : une divergence
 * entre les deux mondes casse le build, pas la production (cf. R7).
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
process.stdout.write(`contrat écrit : ${out}\n`);
