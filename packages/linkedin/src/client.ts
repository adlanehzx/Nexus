import {
  linkedInMutationResultSchema,
  linkedInProfileSchema,
  type LinkedInMutationResult,
  type LinkedInProfile,
} from "./types.js";

/**
 * A non-2xx answer from LinkedIn. The status is kept so callers can tell an
 * expired token (401) or a missing scope (403) from an outage (5xx); the
 * response body is deliberately not kept, because it can echo request data.
 */
export class LinkedInApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`LinkedIn API request failed (${String(status)})`);
    this.name = "LinkedInApiError";
    this.status = status;
  }
}

export class LinkedInClient {
  readonly #getToken: () => Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #version: string;

  constructor(input: {
    accessToken: string | (() => Promise<string>);
    fetchFn?: typeof fetch;
    version?: string;
  }) {
    this.#getToken =
      typeof input.accessToken === "string"
        ? () => Promise.resolve(input.accessToken as string)
        : input.accessToken;
    this.#fetch = input.fetchFn ?? fetch;
    this.#version = input.version ?? "202610";
  }

  async getProfile(signal?: AbortSignal): Promise<LinkedInProfile> {
    const value = await this.#request("https://api.linkedin.com/v2/userinfo", {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
    return linkedInProfileSchema.parse(value);
  }

  /** The member URN posts are authored as, derived from the OpenID `sub`. */
  async getAuthorUrn(signal?: AbortSignal): Promise<string> {
    const profile = await this.getProfile(signal);
    return `urn:li:person:${profile.sub}`;
  }

  async createTextPost(input: {
    authorUrn: string;
    text: string;
    visibility?: "PUBLIC" | "CONNECTIONS";
    signal?: AbortSignal;
  }): Promise<LinkedInMutationResult> {
    const response = await this.#rawRequest("https://api.linkedin.com/rest/posts", {
      method: "POST",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      body: JSON.stringify({
        author: input.authorUrn,
        commentary: input.text,
        visibility: input.visibility ?? "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    return linkedInMutationResultSchema.parse({
      id: response.headers.get("x-restli-id"),
      created: true,
    });
  }

  async createComment(input: {
    actorUrn: string;
    postUrn: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<LinkedInMutationResult> {
    const target = encodeURIComponent(input.postUrn);
    const response = await this.#rawRequest(
      `https://api.linkedin.com/rest/socialActions/${target}/comments`,
      {
        method: "POST",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        body: JSON.stringify({
          actor: input.actorUrn,
          object: input.postUrn,
          message: { text: input.text },
        }),
      },
    );
    return linkedInMutationResultSchema.parse({
      id: response.headers.get("x-restli-id"),
      created: true,
    });
  }

  async #request(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.#rawRequest(url, init);
    return response.json();
  }

  async #rawRequest(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.#getToken()}`);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("LinkedIn-Version", this.#version);
    headers.set("X-Restli-Protocol-Version", "2.0.0");
    const response = await this.#fetch(url, { ...init, headers });
    if (!response.ok) throw new LinkedInApiError(response.status);
    return response;
  }
}
