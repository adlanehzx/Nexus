import {
  HomeAssistantAuthError,
  HomeAssistantUnavailableError,
  normalizeHomeAssistantUrl,
  type HaSocket,
  type HaSocketFactory,
  type HomeAssistantClient,
} from "./homeassistant-client.js";

/**
 * Hands-free Home Assistant setup, so nobody has to open HA's UI to copy a
 * token:
 *
 * - `probeHomeAssistant` tells whether a URL is a Home Assistant and whether
 *   it still waits for its first owner (fresh install).
 * - `onboardHomeAssistant` completes the onboarding of a fresh install
 *   (owner account, core config, analytics opt-out, integration step) and
 *   returns a long-lived token for NEXUS.
 * - `loginHomeAssistant` signs in to an existing install with the owner's
 *   username / password (never stored) and returns a long-lived token.
 * - `listDiscoveredIntegrations` / `acceptDiscoveredIntegration` surface the
 *   devices HA found on the LAN (Hue, Cast, TVs, plugs…) and add them.
 *
 * The OAuth client id is HA's own origin, exactly as the HA frontend does, so
 * HA's IndieAuth client checks always pass.
 */

export interface HomeAssistantSetupOptions {
  readonly fetch?: typeof fetch;
  readonly socketFactory?: HaSocketFactory;
  readonly timeoutMs?: number;
  /** Name of the long-lived token, visible in the HA profile. */
  readonly tokenName?: string;
}

export interface HomeAssistantProbe {
  readonly url: string;
  readonly reachable: boolean;
  readonly isHomeAssistant: boolean;
  /** `false` = fresh install waiting for its owner; `null` = unknown. */
  readonly onboarded: boolean | null;
  readonly pendingSteps: readonly string[];
}

export class HomeAssistantSetupError extends Error {
  readonly reason: "mfa_required" | "already_onboarded" | "invalid_auth" | "protocol";
  constructor(reason: HomeAssistantSetupError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

async function call(
  options: HomeAssistantSetupOptions,
  url: string,
  init: { method: "GET" | "POST"; json?: unknown; form?: Record<string, string>; token?: string },
): Promise<{ status: number; body: unknown }> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  try {
    const response = await doFetch(url, {
      method: init.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      // non-JSON body
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    throw new HomeAssistantUnavailableError(
      controller.signal.aborted
        ? "request timed out"
        : error instanceof Error
          ? error.message.slice(0, 120)
          : "network error",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function probeHomeAssistant(
  rawUrl: string,
  options: HomeAssistantSetupOptions = {},
): Promise<HomeAssistantProbe> {
  const url = normalizeHomeAssistantUrl(rawUrl);
  try {
    const onboarding = await call(options, `${url}/api/onboarding`, { method: "GET" });
    if (onboarding.status === 200 && Array.isArray(onboarding.body)) {
      const steps = onboarding.body as { step?: unknown; done?: unknown }[];
      const pending = steps.filter((s) => s.done !== true).map((s) => String(s.step));
      return {
        url,
        reachable: true,
        isHomeAssistant: true,
        onboarded: pending.length === 0,
        pendingSteps: pending,
      };
    }
    // Onboarding view missing: still HA if the API answers 401 without a token.
    const api = await call(options, `${url}/api/`, { method: "GET" });
    const isHa =
      api.status === 401 ||
      (api.status === 200 && JSON.stringify(api.body).includes("API running"));
    return {
      url,
      reachable: true,
      isHomeAssistant: isHa,
      onboarded: isHa ? true : null,
      pendingSteps: [],
    };
  } catch {
    return { url, reachable: false, isHomeAssistant: false, onboarded: null, pendingSteps: [] };
  }
}

async function exchangeCode(
  options: HomeAssistantSetupOptions,
  url: string,
  code: string,
  clientId: string,
): Promise<string> {
  const token = await call(options, `${url}/auth/token`, {
    method: "POST",
    form: { grant_type: "authorization_code", code, client_id: clientId },
  });
  const accessToken = (token.body as { access_token?: unknown } | null)?.access_token;
  if (token.status !== 200 || typeof accessToken !== "string") {
    throw new HomeAssistantSetupError("protocol", "Home Assistant did not issue an access token.");
  }
  return accessToken;
}

/** Opens the WebSocket with a short-lived access token and mints a long-lived one. */
export function createLongLivedToken(
  url: string,
  accessToken: string,
  options: HomeAssistantSetupOptions = {},
): Promise<string> {
  const factory =
    options.socketFactory ??
    ((u: string) => {
      const Ctor = (globalThis as { WebSocket?: new (u: string) => HaSocket }).WebSocket;
      if (Ctor === undefined) throw new Error("No WebSocket implementation available.");
      return new Ctor(u);
    });
  return new Promise((resolve, reject) => {
    let socket: HaSocket;
    try {
      socket = factory(`${url.replace(/^http/, "ws")}/api/websocket`);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const finish = (error: Error | null, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close(1000, "done");
      } catch {
        // ignore
      }
      if (error !== null) reject(error);
      else resolve(token ?? "");
    };
    const timer = setTimeout(
      () => finish(new HomeAssistantUnavailableError("token creation timed out")),
      options.timeoutMs ?? 8_000,
    );
    socket.addEventListener("message", (event) => {
      const text =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: accessToken }));
      } else if (message.type === "auth_ok") {
        socket.send(
          JSON.stringify({
            id: 1,
            type: "auth/long_lived_access_token",
            client_name: options.tokenName ?? "NEXUS",
            lifespan: 3650,
          }),
        );
      } else if (message.type === "auth_invalid") {
        finish(new HomeAssistantAuthError());
      } else if (message.type === "result" && message.id === 1) {
        if (message.success === true && typeof message.result === "string")
          finish(null, message.result);
        else
          finish(
            new HomeAssistantSetupError("protocol", "Home Assistant refused to create a token."),
          );
      }
    });
    socket.addEventListener("close", () =>
      finish(new HomeAssistantUnavailableError("connection closed")),
    );
    socket.addEventListener("error", () => undefined);
  });
}

/**
 * Completes the onboarding of a fresh Home Assistant. The owner account is
 * the one the person will use to open HA's own UI; NEXUS keeps only the
 * long-lived token it creates for itself.
 */
export async function onboardHomeAssistant(
  rawUrl: string,
  owner: { name: string; username: string; password: string; language?: string },
  options: HomeAssistantSetupOptions = {},
): Promise<{ token: string }> {
  const url = normalizeHomeAssistantUrl(rawUrl);
  const clientId = `${url}/`;
  const created = await call(options, `${url}/api/onboarding/users`, {
    method: "POST",
    json: {
      client_id: clientId,
      name: owner.name,
      username: owner.username,
      password: owner.password,
      language: owner.language ?? "en",
    },
  });
  if (created.status === 403) {
    throw new HomeAssistantSetupError("already_onboarded", "Home Assistant already has an owner.");
  }
  const authCode = (created.body as { auth_code?: unknown } | null)?.auth_code;
  if (created.status !== 200 || typeof authCode !== "string") {
    throw new HomeAssistantSetupError(
      "protocol",
      `Onboarding failed (HTTP ${String(created.status)}).`,
    );
  }
  const accessToken = await exchangeCode(options, url, authCode, clientId);
  // Remaining steps. Each may already be done (403) on a partially onboarded HA.
  await call(options, `${url}/api/onboarding/core_config`, {
    method: "POST",
    json: {},
    token: accessToken,
  });
  await call(options, `${url}/api/onboarding/analytics`, {
    method: "POST",
    json: {},
    token: accessToken,
  });
  await call(options, `${url}/api/onboarding/integration`, {
    method: "POST",
    json: { client_id: clientId, redirect_uri: `${clientId}?auth_callback=1` },
    token: accessToken,
  });
  return { token: await createLongLivedToken(url, accessToken, options) };
}

/** Signs in to an onboarded Home Assistant with the owner's credentials (not stored). */
export async function loginHomeAssistant(
  rawUrl: string,
  credentials: { username: string; password: string },
  options: HomeAssistantSetupOptions = {},
): Promise<{ token: string }> {
  const url = normalizeHomeAssistantUrl(rawUrl);
  const clientId = `${url}/`;
  const flow = await call(options, `${url}/auth/login_flow`, {
    method: "POST",
    json: {
      client_id: clientId,
      handler: ["homeassistant", null],
      redirect_uri: `${clientId}?auth_callback=1`,
    },
  });
  const flowId = (flow.body as { flow_id?: unknown } | null)?.flow_id;
  if (flow.status !== 200 || typeof flowId !== "string") {
    throw new HomeAssistantSetupError("protocol", "Home Assistant login is unavailable.");
  }
  const step = await call(options, `${url}/auth/login_flow/${encodeURIComponent(flowId)}`, {
    method: "POST",
    json: { client_id: clientId, username: credentials.username, password: credentials.password },
  });
  const result = step.body as {
    type?: unknown;
    result?: unknown;
    step_id?: unknown;
    errors?: unknown;
  } | null;
  if (result?.type === "create_entry" && typeof result.result === "string") {
    const accessToken = await exchangeCode(options, url, result.result, clientId);
    return { token: await createLongLivedToken(url, accessToken, options) };
  }
  if (result?.step_id === "mfa") {
    throw new HomeAssistantSetupError(
      "mfa_required",
      "Two-factor authentication is enabled on this account: create a long-lived token in Home Assistant instead.",
    );
  }
  throw new HomeAssistantSetupError(
    "invalid_auth",
    "Home Assistant rejected the username or password.",
  );
}

export interface DiscoveredIntegration {
  readonly flowId: string;
  readonly domain: string;
  readonly source: string;
  readonly title: string;
}

const DISCOVERY_SOURCES = new Set([
  "zeroconf",
  "ssdp",
  "dhcp",
  "homekit",
  "bluetooth",
  "usb",
  "mqtt",
  "discovery",
  "hassio",
  "integration_discovery",
]);

/** Integrations Home Assistant found on the network and is waiting to set up. */
export async function listDiscoveredIntegrations(
  client: Pick<HomeAssistantClient, "command">,
): Promise<DiscoveredIntegration[]> {
  const flows = (await client.command("config_entries/flow/progress")) as {
    flow_id?: unknown;
    handler?: unknown;
    context?: { source?: unknown; title_placeholders?: Record<string, unknown> };
  }[];
  if (!Array.isArray(flows)) return [];
  return flows
    .filter((f) => typeof f.flow_id === "string" && typeof f.handler === "string")
    .filter((f) => typeof f.context?.source === "string" && DISCOVERY_SOURCES.has(f.context.source))
    .map((f) => {
      const placeholders = f.context?.title_placeholders ?? {};
      const name = Object.values(placeholders).find((v): v is string => typeof v === "string");
      return {
        flowId: f.flow_id as string,
        domain: f.handler as string,
        source: String(f.context?.source),
        title: name ?? (f.handler as string),
      };
    });
}

/**
 * Confirms a discovered integration. Many discoveries only need a confirm
 * click; those needing a pairing code or button press return `needs_input`
 * so the UI can say so instead of pretending it worked.
 */
export async function acceptDiscoveredIntegration(
  client: Pick<HomeAssistantClient, "configFlowStep">,
  flowId: string,
): Promise<{ status: "added" | "needs_input" | "aborted"; detail: string }> {
  const step = await client.configFlowStep(flowId, {});
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (step.type === "create_entry") return { status: "added", detail: text(step.title) };
  if (step.type === "abort") return { status: "aborted", detail: text(step.reason) };
  return { status: "needs_input", detail: text(step.step_id) };
}
