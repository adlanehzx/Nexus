import { describe, expect, it } from "vitest";
import { en } from "../src/ui/i18n/locales/en.js";
import { fr } from "../src/ui/i18n/locales/fr.js";

describe("Dashboard Multi-lingual & i18n Coverage", () => {
  it("enforces key parity between English and French actions", () => {
    const enActions = Object.keys(en.common.actions).sort();
    const frActions = Object.keys(fr.common.actions).sort();
    expect(frActions).toEqual(enActions);
  });

  it("enforces key parity between English and French status labels", () => {
    const enStates = Object.keys(en.common.states).sort();
    const frStates = Object.keys(fr.common.states).sort();
    expect(frStates).toEqual(enStates);
  });

  it("enforces complete navigation coverage in French and English", () => {
    const enItems = Object.keys(en.nav.items).sort();
    const frItems = Object.keys(fr.nav.items).sort();
    expect(frItems).toEqual(enItems);
    expect(enItems.length).toBeGreaterThanOrEqual(27);
  });

  it("provides comprehensive localized titles and descriptions for all views", () => {
    const enPages = Object.keys(en.meta).sort();
    const frPages = Object.keys(fr.meta).sort();
    expect(frPages).toEqual(enPages);
    for (const key of enPages) {
      expect(en.meta[key]!.title.length).toBeGreaterThan(0);
      expect(fr.meta[key]!.title.length).toBeGreaterThan(0);
      expect(en.meta[key]!.description.length).toBeGreaterThan(0);
      expect(fr.meta[key]!.description.length).toBeGreaterThan(0);
    }
  });

  it("accurately localizes Trading Lab, OSINT and Mission Control terms in French", () => {
    expect(fr.tradingLab.badge).toContain("Simulation");
    expect(fr.tradingLab.badge).toContain("fonds réel");
    expect(fr.tradingLab.disclaimer).toContain("financière réelle");
    expect(fr.supervision.missionControl.auditChain).toBe("Chaîne d'audit");
    expect(fr.common.messages.liveApi).toBe("API en direct");
  });
});
