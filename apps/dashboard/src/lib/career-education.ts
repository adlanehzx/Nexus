import { DashboardCareerClient } from "./career-api-client.js";
import { Lab1Client } from "./lab1-client.js";
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
/** Lab 1 (autonomy, LinkedIn) clients, keyed by the career client they accompany. */
const lab1Clients = new WeakMap<CareerEducationClient, Lab1Client>();

/**
 * The autonomy / LinkedIn client for a career client, or `null` for the
 * offline demo client — whose panels then show an explicit "unavailable" state
 * rather than pretending to work.
 */
export function lab1ClientFor(client: CareerEducationClient): Lab1Client | null {
  return lab1Clients.get(client) ?? null;
}

export function createCareerEducationClient(session?: SessionManager): CareerEducationClient {
  if (session !== undefined) {
    let client = clients.get(session);
    if (!client) {
      client = new DashboardCareerClient(session);
      clients.set(session, client);
      lab1Clients.set(client, new Lab1Client(session));
    }
    return client;
  }
  return new FakeCareerEducationClient({ seedDemoData: false });
}

/**
 * Offline demo/test singleton backed by in-memory data. The app never uses it:
 * authenticated screens must go through createCareerEducationClient(session).
 */
export const careerEducationClient: CareerEducationClient = new FakeCareerEducationClient({
  seedDemoData: false,
});
