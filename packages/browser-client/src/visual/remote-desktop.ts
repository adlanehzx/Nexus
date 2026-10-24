import crypto from "node:crypto";
import { uuidv7 } from "@nexus/shared";

export interface RemoteDesktopAuditEntry {
  entryId: string;
  timestamp: string;
  action: string;
  coordinates?: { x: number; y: number } | undefined;
  details?: Record<string, unknown> | undefined;
  permitted: boolean;
  blockedReason?: string | undefined;
}

export interface RemoteDesktopSession {
  sessionId: string;
  ownerId: string;
  authToken: string;
  targetScreenId: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  revocationReason?: string | undefined;
  allowedActions: Set<string>;
  auditTrail: RemoteDesktopAuditEntry[];
}

export class RemoteDesktopSecurityError extends Error {
  readonly code: string;
  constructor(message: string, code = "REMOTE_DESKTOP_SECURITY_ERROR") {
    super(message);
    this.name = "RemoteDesktopSecurityError";
    this.code = code;
  }
}

export class RemoteDesktopSessionManager {
  private sessions = new Map<string, RemoteDesktopSession>();
  private readonly defaultDurationMs = 15 * 60 * 1000; // 15 minutes default
  private readonly maxDurationMs = 60 * 60 * 1000; // 1 hour max

  createSession(options: {
    ownerId: string;
    targetScreenId: string;
    durationMs?: number;
    allowedActions?: string[];
  }): RemoteDesktopSession {
    if (!options.ownerId) {
      throw new RemoteDesktopSecurityError(
        "Remote desktop session requires an explicit owner identifier",
        "MISSING_OWNER",
      );
    }

    const duration = Math.min(options.durationMs ?? this.defaultDurationMs, this.maxDurationMs);
    const now = Date.now();
    const sessionId = `rdp-${uuidv7()}`;
    const authToken = crypto.randomBytes(32).toString("hex");

    const session: RemoteDesktopSession = {
      sessionId,
      ownerId: options.ownerId,
      authToken,
      targetScreenId: options.targetScreenId,
      createdAt: now,
      expiresAt: now + duration,
      revoked: false,
      allowedActions: new Set(options.allowedActions ?? ["click", "type", "scroll", "capture"]),
      auditTrail: [],
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  verifyAndAuditAction(
    sessionId: string,
    token: string,
    ownerId: string,
    action: string,
    coordinates?: { x: number; y: number },
    details?: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RemoteDesktopSecurityError(
        "Session not found or already terminated",
        "SESSION_NOT_FOUND",
      );
    }

    // 1. Cross-session ownership check
    if (session.ownerId !== ownerId) {
      const entry: RemoteDesktopAuditEntry = {
        entryId: uuidv7(),
        timestamp: new Date().toISOString(),
        action,
        coordinates,
        details,
        permitted: false,
        blockedReason: `Cross-session ownership violation: attempt by ${ownerId} on session owned by ${session.ownerId}`,
      };
      session.auditTrail.push(entry);
      throw new RemoteDesktopSecurityError(
        `Access denied: cross-session ownership violation`,
        "OWNERSHIP_VIOLATION",
      );
    }

    // 2. Authentication check
    if (session.authToken !== token) {
      throw new RemoteDesktopSecurityError("Invalid session authentication token", "INVALID_TOKEN");
    }

    // 3. Revocation check
    if (session.revoked) {
      throw new RemoteDesktopSecurityError(
        `Session is revoked: ${session.revocationReason ?? "revoked by user"}`,
        "SESSION_REVOKED",
      );
    }

    // 4. Expiration check
    if (Date.now() > session.expiresAt) {
      session.revoked = true;
      session.revocationReason = "Session expired";
      throw new RemoteDesktopSecurityError("Remote desktop session has expired", "SESSION_EXPIRED");
    }

    // 5. Allowed action check
    if (!session.allowedActions.has(action)) {
      const entry: RemoteDesktopAuditEntry = {
        entryId: uuidv7(),
        timestamp: new Date().toISOString(),
        action,
        coordinates,
        details,
        permitted: false,
        blockedReason: `Action '${action}' is not in session allowed actions`,
      };
      session.auditTrail.push(entry);
      throw new RemoteDesktopSecurityError(
        `Action '${action}' is not permitted in this remote desktop session`,
        "ACTION_NOT_PERMITTED",
      );
    }

    // Record audited action
    session.auditTrail.push({
      entryId: uuidv7(),
      timestamp: new Date().toISOString(),
      action,
      coordinates,
      details,
      permitted: true,
    });
  }

  revokeSession(sessionId: string, ownerId: string, reason = "Explicitly revoked"): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.ownerId !== ownerId) {
      throw new RemoteDesktopSecurityError(
        "Only the session owner can revoke this remote desktop session",
        "OWNERSHIP_VIOLATION",
      );
    }

    session.revoked = true;
    session.revocationReason = reason;
  }

  getSessionAuditTrail(sessionId: string, ownerId: string): RemoteDesktopAuditEntry[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RemoteDesktopSecurityError("Session not found", "SESSION_NOT_FOUND");
    }
    if (session.ownerId !== ownerId) {
      throw new RemoteDesktopSecurityError(
        "Cross-session ownership violation",
        "OWNERSHIP_VIOLATION",
      );
    }
    return [...session.auditTrail];
  }
}
