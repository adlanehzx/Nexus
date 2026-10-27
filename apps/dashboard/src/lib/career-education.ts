import {
  FakeCareerEducationClient,
  HttpCareerEducationClient,
  type CareerEducationClient,
  type SessionManager,
} from "@nexus/client-core";

/**
 * Creates a CareerEducationClient instance.
 * When an authenticated SessionManager is provided, it connects directly
 * to the Fastify API /api/v1/career/* routes.
 */
export function createCareerEducationClient(session?: SessionManager): CareerEducationClient {
  if (session !== undefined) {
    return new HttpCareerEducationClient(session, { seedDemoData: false });
  }
  return new FakeCareerEducationClient({ seedDemoData: false });
}

/**
 * Shared singleton instance of the contract-backed CareerEducationClient.
 * Serves as the typed boundary between the dashboard presentation layer
 * and the domain engine.
 */
export const careerEducationClient: CareerEducationClient = new FakeCareerEducationClient({
  seedDemoData: false,
});
