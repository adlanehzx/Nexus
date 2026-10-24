import { describe, expect, it } from "vitest";
import {
  WatchCompanionManager,
  WatchSecurityError,
  type WatchAction,
  type WatchApprovalRequest,
} from "../src/companion/watch.js";

describe("WatchCompanionManager", () => {
  it("issues, validates, and expires scoped watch sessions", () => {
    const manager = new WatchCompanionManager({ defaultTtlMs: 3600_000 });
    const now = 1_700_000_000_000;

    const session = manager.issueSession({
      watchId: "apple_watch_ultra_1",
      platform: "apple_watch",
      phoneDeviceId: "iphone_15_pro",
      now,
    });

    expect(session.watchId).toBe("apple_watch_ultra_1");
    expect(session.scopedToken).toMatch(/^wtoken_/);
    expect(session.expiresAt).toBe(now + 3600_000);

    // Valid immediately
    expect(manager.validateSession(session, now + 1000)).toBe(true);

    // Invalid after TTL
    expect(manager.validateSession(session, now + 3600_001)).toBe(false);

    // Revocation works immediately
    manager.revokeSession("apple_watch_ultra_1");
    expect(manager.validateSession(session, now + 1000)).toBe(false);
  });

  it("builds bounded glance state for complications", () => {
    const manager = new WatchCompanionManager();
    const glance = manager.buildGlanceState({
      platform: "wear_os",
      task: {
        id: "task_456",
        title: "Backup PostgreSQL",
        status: "waiting_for_confirmation",
        progressPercent: 75,
      },
      pendingApprovals: 1,
    });

    expect(glance.status).toBe("waiting_confirmation");
    expect(glance.pendingApprovals).toBe(1);
    expect(glance.progressPercent).toBe(75);
    expect(glance.taskId).toBe("task_456");
  });

  it("permits low and medium severity approvals on watch", async () => {
    const manager = new WatchCompanionManager();
    const now = 1_700_000_000_000;
    const session = manager.issueSession({
      watchId: "pixel_watch_2",
      platform: "wear_os",
      phoneDeviceId: "pixel_8_pro",
      now,
    });

    const approvalReq: WatchApprovalRequest = {
      id: "req_low_1",
      taskId: "task_456",
      actionDescription: "Allow read access to /var/log/nginx.log",
      severity: "low",
      requiresTouch: true,
      expiresAt: now + 60_000,
    };

    const action: WatchAction = {
      type: "APPROVE_STEP",
      requestId: "req_low_1",
      taskId: "task_456",
      timestamp: now + 500,
    };

    const result = await manager.dispatchWatchAction(session, action, {
      approvalRequest: approvalReq,
      now: now + 500,
    });

    expect(result.success).toBe(true);
    expect(result.result).toContain("Step approved via smartwatch");

    const audit = manager.getAuditLog();
    expect(audit.length).toBe(1);
    expect(audit[0]?.allowed).toBe(true);
    expect(audit[0]?.actionType).toBe("APPROVE_STEP");
  });

  it("rejects high and critical severity approvals on watch", async () => {
    const manager = new WatchCompanionManager();
    const now = 1_700_000_000_000;
    const session = manager.issueSession({
      watchId: "apple_watch_series_9",
      platform: "apple_watch",
      phoneDeviceId: "iphone_14",
      now,
    });

    const criticalReq: WatchApprovalRequest = {
      id: "req_crit_1",
      taskId: "task_999",
      actionDescription: "Permanently drop database production_db",
      severity: "critical",
      requiresTouch: true,
      expiresAt: now + 60_000,
    };

    const action: WatchAction = {
      type: "APPROVE_STEP",
      requestId: "req_crit_1",
      taskId: "task_999",
      timestamp: now + 500,
    };

    const result = await manager.dispatchWatchAction(session, action, {
      approvalRequest: criticalReq,
      now: now + 500,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("must be confirmed on phone or desktop");

    const audit = manager.getAuditLog();
    expect(audit.length).toBe(1);
    expect(audit[0]?.allowed).toBe(false);
  });

  it("allows emergency abort and reject actions anytime", async () => {
    const manager = new WatchCompanionManager();
    const session = manager.issueSession({
      watchId: "apple_watch_se",
      platform: "apple_watch",
      phoneDeviceId: "iphone_13",
    });

    const abortAction: WatchAction = {
      type: "ABORT_MISSION",
      taskId: "task_123",
      timestamp: Date.now(),
    };

    const result = await manager.dispatchWatchAction(session, abortAction);
    expect(result.success).toBe(true);
    expect(result.result).toBe("Mission aborted.");
  });

  it("rejects unauthorized or revoked sessions", async () => {
    const manager = new WatchCompanionManager();
    const session = manager.issueSession({
      watchId: "apple_watch_revoked",
      platform: "apple_watch",
      phoneDeviceId: "iphone_12",
    });
    manager.revokeSession("apple_watch_revoked");

    const action: WatchAction = {
      type: "ABORT_MISSION",
      timestamp: Date.now(),
    };

    await expect(manager.dispatchWatchAction(session, action)).rejects.toThrowError(
      WatchSecurityError,
    );
  });
});
