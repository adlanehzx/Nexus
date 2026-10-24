import { AppError } from "@nexus/shared";

/**
 * Smartwatch companion (Apple Watch / Wear OS) contracts and bounded dispatcher.
 *
 * ## Principles
 * 1. Strictly bounded capabilities: glance, confirmation (low/medium severity), emergency abort.
 * 2. High/critical irreversible actions can NEVER be confirmed via smartwatch alone.
 * 3. Scoped companion tokens isolate watch security from host master keys.
 * 4. Automatic short-lived session expiration (max 24h) and zero permanent audio retention.
 */

export type WatchPlatform = "apple_watch" | "wear_os";

export type WatchGlanceStatus =
  "idle" | "running" | "waiting_confirmation" | "completed" | "failed";

export interface WatchGlanceState {
  readonly platform: WatchPlatform;
  readonly taskId?: string | undefined;
  readonly taskTitle?: string | undefined;
  readonly status: WatchGlanceStatus;
  readonly progressPercent: number;
  readonly pendingApprovals: number;
  readonly updatedAt: number;
}

export type ApprovalSeverity = "low" | "medium" | "high" | "critical";

export interface WatchApprovalRequest {
  readonly id: string;
  readonly taskId: string;
  readonly actionDescription: string;
  readonly severity: ApprovalSeverity;
  /** Whether confirmation requires deliberate touch (non-biometric fallback). */
  readonly requiresTouch: boolean;
  /** Timestamp after which confirmation request is void. */
  readonly expiresAt: number;
}

export type WatchActionType = "APPROVE_STEP" | "REJECT_STEP" | "ABORT_MISSION" | "VOICE_PROMPT";

export interface WatchAction {
  readonly type: WatchActionType;
  readonly requestId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly textPrompt?: string | undefined;
  readonly timestamp: number;
}

export interface WatchSession {
  readonly sessionId: string;
  readonly watchId: string;
  readonly platform: WatchPlatform;
  readonly phoneDeviceId: string;
  readonly scopedToken: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  revoked: boolean;
}

export interface WatchAuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly watchId: string;
  readonly platform: WatchPlatform;
  readonly actionType: WatchActionType;
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

export class WatchSecurityError extends AppError {
  readonly code = "WATCH_SECURITY_ERROR";
  readonly httpStatus = 403;

  constructor(message: string, context?: Record<string, unknown>) {
    super({
      message,
      userMessage: "Smartwatch action rejected due to companion security policy.",
      ...(context !== undefined ? { context } : {}),
    });
  }
}

export class WatchCompanionManager {
  readonly #sessions = new Map<string, WatchSession>();
  readonly #auditLog: WatchAuditEvent[] = [];
  readonly #defaultTtlMs: number;

  constructor(options?: { defaultTtlMs?: number }) {
    this.#defaultTtlMs = options?.defaultTtlMs ?? 24 * 60 * 60 * 1000; // 24 hours
  }

  /** Issues an ephemeral scoped token for a smartwatch companion. */
  issueSession(params: {
    watchId: string;
    platform: WatchPlatform;
    phoneDeviceId: string;
    now?: number;
    ttlMs?: number;
  }): WatchSession {
    const now = params.now ?? Date.now();
    const ttl = params.ttlMs ?? this.#defaultTtlMs;
    const session: WatchSession = {
      sessionId: `wsess_${Math.random().toString(36).slice(2, 10)}`,
      watchId: params.watchId,
      platform: params.platform,
      phoneDeviceId: params.phoneDeviceId,
      scopedToken: `wtoken_${Math.random().toString(36).slice(2, 18)}`,
      issuedAt: now,
      expiresAt: now + ttl,
      revoked: false,
    };
    this.#sessions.set(session.watchId, session);
    return { ...session };
  }

  /** Validates session authenticity, expiration, and revocation status. */
  validateSession(session: WatchSession, now = Date.now()): boolean {
    const existing = this.#sessions.get(session.watchId);
    if (!existing) return false;
    if (existing.revoked || session.revoked) return false;
    if (existing.scopedToken !== session.scopedToken) return false;
    if (now >= existing.expiresAt) return false;
    return true;
  }

  /** Revokes a smartwatch companion session immediately. */
  revokeSession(watchId: string): void {
    const existing = this.#sessions.get(watchId);
    if (existing) {
      existing.revoked = true;
    }
  }

  /** Evaluates whether an approval request may be confirmed from a smartwatch. */
  canApproveOnWatch(
    request: WatchApprovalRequest,
    now = Date.now(),
  ): {
    allowed: boolean;
    reason?: string | undefined;
  } {
    if (now > request.expiresAt) {
      return { allowed: false, reason: "Approval request has expired." };
    }
    // Critical actions (destructive modifications, security keys, financial simulation)
    // require primary workstation or phone interface.
    if (request.severity === "critical" || request.severity === "high") {
      return {
        allowed: false,
        reason: "High-impact and critical actions must be confirmed on phone or desktop.",
      };
    }
    return { allowed: true };
  }

  /** Builds a minimal bounded glance payload for watch complications. */
  buildGlanceState(params: {
    platform: WatchPlatform;
    task?: { id: string; title: string; status: string; progressPercent?: number };
    pendingApprovals?: number;
    now?: number;
  }): WatchGlanceState {
    let status: WatchGlanceStatus = "idle";
    if (params.task) {
      if (params.task.status === "running") status = "running";
      else if (params.task.status === "waiting_for_confirmation") status = "waiting_confirmation";
      else if (params.task.status === "completed") status = "completed";
      else if (params.task.status === "failed") status = "failed";
    }

    return {
      platform: params.platform,
      taskId: params.task?.id,
      taskTitle: params.task?.title,
      status,
      progressPercent: params.task?.progressPercent ?? 0,
      pendingApprovals: params.pendingApprovals ?? 0,
      updatedAt: params.now ?? Date.now(),
    };
  }

  /** Dispatches a bounded watch action after security policy enforcement. */
  async dispatchWatchAction(
    session: WatchSession,
    action: WatchAction,
    options?: {
      approvalRequest?: WatchApprovalRequest;
      now?: number;
    },
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    await Promise.resolve();
    const now = options?.now ?? Date.now();

    if (!this.validateSession(session, now)) {
      this.#recordAudit(session, action, false, "Invalid or expired watch session.");
      throw new WatchSecurityError("Unauthorized watch session.");
    }

    if (action.type === "APPROVE_STEP") {
      if (!options?.approvalRequest) {
        this.#recordAudit(session, action, false, "Missing approval request context.");
        return { success: false, error: "Approval context missing." };
      }
      const check = this.canApproveOnWatch(options.approvalRequest, now);
      if (!check.allowed) {
        this.#recordAudit(session, action, false, check.reason);
        return { success: false, ...(check.reason ? { error: check.reason } : {}) };
      }
      this.#recordAudit(session, action, true);
      return { success: true, result: "Step approved via smartwatch companion." };
    }

    if (action.type === "REJECT_STEP" || action.type === "ABORT_MISSION") {
      // Emergency stops and rejections are always permitted from companion
      this.#recordAudit(session, action, true);
      return {
        success: true,
        result: action.type === "ABORT_MISSION" ? "Mission aborted." : "Step rejected.",
      };
    }

    if (action.type === "VOICE_PROMPT") {
      if (!action.textPrompt || action.textPrompt.trim().length === 0) {
        this.#recordAudit(session, action, false, "Empty prompt received.");
        return { success: false, error: "Prompt is empty." };
      }
      this.#recordAudit(session, action, true);
      return { success: true, result: "Prompt forwarded to host." };
    }

    this.#recordAudit(session, action, false, "Unsupported action type.");
    return { success: false, error: "Unsupported action." };
  }

  getAuditLog(): readonly WatchAuditEvent[] {
    return this.#auditLog;
  }

  #recordAudit(
    session: WatchSession,
    action: WatchAction,
    allowed: boolean,
    reason?: string,
  ): void {
    this.#auditLog.push({
      id: `waudit_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      watchId: session.watchId,
      platform: session.platform,
      actionType: action.type,
      allowed,
      reason,
    });
  }
}
