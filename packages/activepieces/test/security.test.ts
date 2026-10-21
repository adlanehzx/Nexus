import { describe, expect, it } from "vitest";
import { isSensitiveSaaSAction, summarizeSaaSAction } from "../src/security.js";

describe("Activepieces SaaS action security and filtering", () => {
  it("detects sensitive external write actions as requiring confirmation", () => {
    // Slack / Discord message
    expect(
      isSensitiveSaaSAction("slack", "send_channel_message", {
        channel: "#general",
        text: "Hello",
      }),
    ).toBe(true);

    // Stripe financial
    expect(
      isSensitiveSaaSAction("stripe", "create_charge", { amount: 5000, currency: "usd" }),
    ).toBe(true);

    // Deletion
    expect(isSensitiveSaaSAction("notion", "delete_database_item", { pageId: "page-123" })).toBe(
      true,
    );

    // Explicit flag
    expect(isSensitiveSaaSAction("custom_piece", "read_data", { isSensitive: true })).toBe(true);
  });

  it("permits read-only actions without blocking confirmation", () => {
    expect(isSensitiveSaaSAction("notion", "get_database_item", { pageId: "page-123" })).toBe(
      false,
    );

    expect(isSensitiveSaaSAction("airtable", "list_records", { baseId: "app123" })).toBe(false);

    expect(
      isSensitiveSaaSAction("github", "get_repository", { owner: "nexus", repo: "nexus" }),
    ).toBe(false);
  });

  it("generates clear summaries for human confirmation", () => {
    const slackSummary = summarizeSaaSAction("slack", "send_message", { channel: "#general" });
    expect(slackSummary).toContain('channel "#general"');

    const stripeSummary = summarizeSaaSAction("stripe", "charge", { amount: "$150" });
    expect(stripeSummary).toContain("$150");
  });
});
