import { describe, it, expect } from "vitest";
import { OAuthFlowService } from "../src/services/oauth-flow.js";
import {
  NativeSessionManager,
  ApprovalDerivationError,
} from "../src/services/native-session.js";

describe("Accounts, OAuth and Native Sessions (LOT D)", () => {
  describe("OAuth PKCE & Device Authorization Flows", () => {
    it("generates cryptographic PKCE challenge and single-use verifier", () => {
      const oauth = new OAuthFlowService();
      const challenge = oauth.generatePkceChallenge("claude");

      expect(challenge.codeVerifier).toBeDefined();
      expect(challenge.codeChallenge).toBeDefined();
      expect(challenge.codeChallengeMethod).toBe("S256");
      expect(challenge.state).toBeDefined();

      // Successful consume
      const consumed = oauth.consumePkceVerifier(challenge.state, "claude");
      expect(consumed).toBe(challenge.codeVerifier);

      // Replay attempt must return null
      const replayed = oauth.consumePkceVerifier(challenge.state, "claude");
      expect(replayed).toBeNull();
    });

    it("polls device code flow until authorization token is returned", async () => {
      const oauth = new OAuthFlowService();
      const reg = oauth.registerDeviceCode("antigravity", {
        deviceCode: "dev-code-123",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.google.com/device",
        expiresInSeconds: 30,
        intervalSeconds: 0.01,
      });

      expect(reg.userCode).toBe("ABCD-EFGH");

      let pollAttempts = 0;
      const token = await oauth.pollDeviceToken("antigravity", "dev-code-123", async () => {
        pollAttempts++;
        if (pollAttempts < 2) {
          return { status: "pending" };
        }
        return {
          status: "success",
          token: {
            accessToken: "oauth_access_token_xyz",
            tokenType: "Bearer",
          },
        };
      });

      expect(token.accessToken).toBe("oauth_access_token_xyz");
      expect(pollAttempts).toBe(2);
    });
  });

  describe("Native Session Resumption & Guardrails", () => {
    it("records turn checkpoints and resumes latest checkpoint", () => {
      const sessionManager = new NativeSessionManager();
      const threadId = "thread-xyz-42";

      sessionManager.recordCheckpoint(threadId, 1, "commit-sha-1");
      sessionManager.recordCheckpoint(threadId, 2, "commit-sha-2");

      const latest = sessionManager.getLatestCheckpoint(threadId);
      expect(latest?.turnNumber).toBe(2);
      expect(latest?.commitHash).toBe("commit-sha-2");
    });

    it("rejects execution if arguments derive from what was approved", () => {
      const sessionManager = new NativeSessionManager();
      const toolCallId = "call-dangerous-delete";

      // User approved deleting test repo without force
      sessionManager.registerApproval(toolCallId, "delete_repo", {
        repo: "test-workspace",
        force: false,
      });

      // Attacker or drift modifies arguments to force: true
      expect(() => {
        sessionManager.consumeApproval(toolCallId, "delete_repo", {
          repo: "test-workspace",
          force: true,
        });
      }).toThrow(ApprovalDerivationError);

      // Consuming with the EXACT approved payload succeeds
      expect(() => {
        sessionManager.consumeApproval(toolCallId, "delete_repo", {
          repo: "test-workspace",
          force: false,
        });
      }).not.toThrow();

      // Second consumption (replay attack) is strictly blocked
      expect(() => {
        sessionManager.consumeApproval(toolCallId, "delete_repo", {
          repo: "test-workspace",
          force: false,
        });
      }).toThrow(ApprovalDerivationError);
    });
  });
});
