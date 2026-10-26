import {
  FakeCareerEducationClient,
  type CareerEducationClient,
} from "@nexus/client-core";

/**
 * Shared singleton instance of the contract-backed CareerEducationClient.
 * Serves as the typed boundary between the dashboard presentation layer
 * and the domain engine (using the fake adapter until Claude's backend exists).
 */
export const careerEducationClient: CareerEducationClient = new FakeCareerEducationClient();
