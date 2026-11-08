import { DashboardCareerClient } from "./career-api-client.js";
import {
  FakeCareerEducationClient,
  type CareerEducationClient,
  type SessionManager,
} from "@nexus/client-core";

/**
 * Creates a CareerEducationClient instance.
 * When an authenticated SessionManager is provided, it connects directly
 * to the Fastify API /api/v1/career/* routes.
 */
const clients = new WeakMap<SessionManager, CareerEducationClient>();

export function createCareerEducationClient(session?: SessionManager): CareerEducationClient {
  if (session !== undefined) {
    let client = clients.get(session);
    if (!client) {
      client = new DashboardCareerClient(session);
      clients.set(session, client);
    }
    return client;
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
