import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OsintService } from "../src/services/osint-service.js";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";

describe("OSINT durable service", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("restores cases, evidence snapshots and watches after a process restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-osint-"));
    const runtime = new RuntimeConfigurationStore(directory);
    const first = new OsintService({ runtime });
    const record = await first.create("owner-a", {
      title: "Durable public case",
      kind: "organization",
      target: "Example Industries",
      objective: "Verify public ownership and registry information before procurement.",
      maxSources: 12,
      lawfulPurposeConfirmed: true,
    });
    await first.addEvidence("owner-a", record.id, {
      url: "https://example.org/source",
      title: "Registry source",
      excerpt: "Public record",
      reliability: "primary",
      content: "archived source bytes",
    });
    await first.addWatch("owner-a", record.id, "https://example.org/updates", 60);

    const restarted = new OsintService({ runtime });
    const restored = await restarted.get("owner-a", record.id);
    expect(restored?.evidence[0]?.contentSnapshot).toBe("archived source bytes");
    expect(restored?.watches).toHaveLength(1);
    expect(await restarted.get("owner-b", record.id)).toBeUndefined();
  });
});
