import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryConfirmationStore, type ConfirmationRequest } from "@nexus/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIRMATION_STORE_FILE_ENV,
  FileConfirmationStore,
  createConfirmationStore,
} from "../src/services/file-confirmation-store.js";

const request = (overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest => ({
  id: "c1",
  runId: "run-1",
  userId: "user-1",
  tool: "terminal.execute",
  toolCallId: "call-1",
  action: "run",
  description: "d",
  riskLevel: "HIGH",
  payloadHash: "a".repeat(64),
  status: "pending",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-01T00:10:00Z"),
  decidedAt: null,
  ...overrides,
});

describe("confirmation store selection", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nexus-conf-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists pending confirmations across store instances", async () => {
    const file = join(dir, "confirmations.json");
    await new FileConfirmationStore(file).save(request());
    const reopened = new FileConfirmationStore(file);
    const got = await reopened.get("c1");
    expect(got?.createdAt).toBeInstanceOf(Date);
    expect(await reopened.listPendingForUser("user-1")).toHaveLength(1);
  });

  it("uses the file store only when the env variable is set", () => {
    expect(createConfirmationStore({})).toBeInstanceOf(InMemoryConfirmationStore);
    expect(
      createConfirmationStore({ [CONFIRMATION_STORE_FILE_ENV]: join(dir, "x.json") }),
    ).toBeInstanceOf(FileConfirmationStore);
  });
});
