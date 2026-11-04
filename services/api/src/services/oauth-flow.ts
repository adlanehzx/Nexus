/**
 * NEXUS OAuth & Identity Flow Service (LOT D)
 *
 * Implements Authorization Code with PKCE (RFC 7636) and Device Authorization Flow (RFC 8628)
 * Guarantees zero credential leakage to LLM context.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes, createHash } from "node:crypto";
import { uuidv7 } from "@nexus/shared";

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresInSeconds?: number;
  scope?: string;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class OAuthFlowService {
  private readonly pendingPkceStates = new Map<
    string,
    { codeVerifier: string; expiresAt: number; provider: string }
  >();

  private readonly pendingDeviceFlows = new Map<
    string,
    { deviceCode: string; expiresAt: number; interval: number; provider: string }
  >();

  /**
   * Generates a cryptographic PKCE challenge for web Authorization Code flow.
   */
  generatePkceChallenge(provider: string, ttlMs = 600_000): PkceChallenge {
    const verifierBytes = randomBytes(32);
    const codeVerifier = base64UrlEncode(verifierBytes);

    const hash = createHash("sha256").update(codeVerifier).digest();
    const codeChallenge = base64UrlEncode(hash);

    const state = uuidv7();
    this.pendingPkceStates.set(state, {
      codeVerifier,
      expiresAt: Date.now() + ttlMs,
      provider,
    });

    return {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: "S256",
      state,
    };
  }

  /**
   * Verifies the state and retrieves the codeVerifier for token exchange.
   */
  consumePkceVerifier(state: string, provider: string): string | null {
    const entry = this.pendingPkceStates.get(state);
    if (!entry) return null;

    this.pendingPkceStates.delete(state);

    if (Date.now() > entry.expiresAt || entry.provider !== provider) {
      return null;
    }

    return entry.codeVerifier;
  }

  /**
   * Registers a Device Authorization code flow for headless/CLI login.
   */
  registerDeviceCode(
    provider: string,
    params: {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresInSeconds: number;
      intervalSeconds?: number;
    },
  ): DeviceCodeResponse {
    const intervalSeconds = params.intervalSeconds ?? 5;
    this.pendingDeviceFlows.set(params.deviceCode, {
      deviceCode: params.deviceCode,
      expiresAt: Date.now() + params.expiresInSeconds * 1000,
      interval: intervalSeconds,
      provider,
    });

    return {
      deviceCode: params.deviceCode,
      userCode: params.userCode,
      verificationUri: params.verificationUri,
      expiresInSeconds: params.expiresInSeconds,
      intervalSeconds,
    };
  }

  /**
   * Polls the provider device token endpoint until resolved or expired.
   */
  async pollDeviceToken(
    provider: string,
    deviceCode: string,
    fetchToken: (deviceCode: string) => Promise<
      | { status: "success"; token: OAuthTokenResult }
      | { status: "pending" }
      | { status: "slow_down" }
      | { status: "expired" | "denied"; error: string }
    >,
  ): Promise<OAuthTokenResult> {
    const entry = this.pendingDeviceFlows.get(deviceCode);
    if (!entry || entry.provider !== provider) {
      throw new Error("Invalid or unknown device code");
    }

    let intervalMs = entry.interval * 1000;

    while (Date.now() < entry.expiresAt) {
      await new Promise((r) => setTimeout(r, intervalMs));

      const pollResult = await fetchToken(deviceCode);
      if (pollResult.status === "success") {
        this.pendingDeviceFlows.delete(deviceCode);
        return pollResult.token;
      }
      if (pollResult.status === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (pollResult.status === "expired" || pollResult.status === "denied") {
        this.pendingDeviceFlows.delete(deviceCode);
        throw new Error(`Device code authorization failed: ${pollResult.error}`);
      }
    }

    this.pendingDeviceFlows.delete(deviceCode);
    throw new Error("Device code expired before authorization was completed");
  }
}
