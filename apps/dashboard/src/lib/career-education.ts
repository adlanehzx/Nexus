import { FakeCareerEducationClient, type CareerEducationClient } from "@nexus/client-core";

/**
 * Shared singleton instance of the contract-backed CareerEducationClient.
 * Serves as the typed boundary between the dashboard presentation layer
 * and the domain engine. This local adapter intentionally starts empty; test
 * suites opt into deterministic demo fixtures explicitly.
 */
// The dashboard starts from a neutral state. Rich deterministic fixtures remain
// available to tests, but no fictional developer profile may leak into a real
// user's career workspace.
export const careerEducationClient: CareerEducationClient = new FakeCareerEducationClient({
  seedDemoData: false,
});
