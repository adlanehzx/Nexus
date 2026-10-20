import { describe, expect, it } from "vitest";
import { isSensitiveSaaSAction, summarizeSaaSAction } from "../src/security.js";

describe("Sécurité et filtrage des actions SaaS Activepieces", () => {
  it("détecte les actions d'écriture externes sensibles comme exigeant confirmation", () => {
    // Slack / Discord message
    expect(
      isSensitiveSaaSAction("slack", "send_channel_message", { channel: "#general", text: "Hello" }),
    ).toBe(true);

    // Stripe financial
    expect(
      isSensitiveSaaSAction("stripe", "create_charge", { amount: 5000, currency: "eur" }),
    ).toBe(true);

    // Deletion
    expect(
      isSensitiveSaaSAction("notion", "delete_database_item", { pageId: "page-123" }),
    ).toBe(true);

    // Flag explicite
    expect(
      isSensitiveSaaSAction("custom_piece", "read_data", { isSensitive: true }),
    ).toBe(true);
  });

  it("laisse les actions de consultation sans confirmation bloquante", () => {
    expect(
      isSensitiveSaaSAction("notion", "get_database_item", { pageId: "page-123" }),
    ).toBe(false);

    expect(
      isSensitiveSaaSAction("airtable", "list_records", { baseId: "app123" }),
    ).toBe(false);

    expect(
      isSensitiveSaaSAction("github", "get_repository", { owner: "nexus", repo: "nexus" }),
    ).toBe(false);
  });

  it("génère des résumés clairs pour les confirmations humaines", () => {
    const slackSummary = summarizeSaaSAction("slack", "send_message", { channel: "#general" });
    expect(slackSummary).toContain("canal « #general »");

    const stripeSummary = summarizeSaaSAction("stripe", "charge", { amount: "150€" });
    expect(stripeSummary).toContain("150€");
  });
});
