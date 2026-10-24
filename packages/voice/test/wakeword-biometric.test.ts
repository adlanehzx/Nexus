import { describe, expect, it, vi } from "vitest";
import {
  IrreversibleActionRequiresTouchConfirmationError,
  VoiceBiometricGuard,
  VoiceBiometricInsufficientError,
  type ActionToConfirm,
} from "../src/biometric.js";
import { LocalWakeWordDetector } from "../src/wakeword.js";

describe("Wake Word Detector and Voice Biometric Multi-Factor Guard", () => {
  it("transitions through hardware-visible states upon wake word detection", () => {
    const onStateChange = vi.fn();
    const onWake = vi.fn();
    const detector = new LocalWakeWordDetector({
      wakePhrases: ["hey nexus", "nexus"],
      onStateChange,
      onWake,
    });

    expect(detector.state).toBe("IDLE");

    // Unrelated speech -> no trigger
    const triggeredFalse = detector.evaluateTranscript("what is the weather today");
    expect(triggeredFalse).toBe(false);
    expect(detector.state).toBe("IDLE");

    // Speech with wake phrase -> triggers WAKE_DETECTED and then LISTENING
    const triggeredTrue = detector.evaluateTranscript("Hey Nexus, summarize my unread emails");
    expect(triggeredTrue).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(detector.state).toBe("LISTENING");

    // Transitions to speaking and then reset
    detector.setState("SPEAKING");
    expect(onStateChange).toHaveBeenCalledWith("SPEAKING");

    detector.reset();
    expect(detector.state).toBe("IDLE");
  });

  it("strictly enforces Rule 11: voice biometric is never the sole factor for sensitive actions", () => {
    const guard = new VoiceBiometricGuard({ minConfidence: 0.85 });

    const mediumAction: ActionToConfirm = {
      id: "act_deploy_worker",
      title: "Deploy Container Worker",
      impact: "medium",
      description: "Spin up a new headless worker node.",
    };

    // 1. Attempt with Voice ONLY (no second factor) -> MUST FAIL CLOSED
    expect(() =>
      guard.evaluateConfirmation({
        action: mediumAction,
        speakerId: "spk_adlane",
        voiceConfidence: 0.96, // very high confidence
        secondFactor: undefined, // NO SECOND FACTOR
      }),
    ).toThrowError(VoiceBiometricInsufficientError);

    // 2. Attempt with Voice + Valid Second Factor (PIN/Password) -> SUCCEEDS
    const validResult = guard.evaluateConfirmation({
      action: mediumAction,
      speakerId: "spk_adlane",
      voiceConfidence: 0.94,
      secondFactor: { type: "PIN_OR_PASSWORD", verified: true },
    });
    expect(validResult.confirmed).toBe(true);
    expect(validResult.secondFactorUsed).toBe("PIN_OR_PASSWORD");

    const audit = guard.auditLog;
    expect(audit.length).toBe(2);
    expect(audit[0]?.outcome).toBe("rejected");
    expect(audit[1]?.outcome).toBe("approved");
  });

  it("rejects voice confirmation for irreversible actions even with high confidence and PIN", () => {
    const guard = new VoiceBiometricGuard();

    const irreversibleAction: ActionToConfirm = {
      id: "act_drop_db",
      title: "Drop Production Database",
      impact: "irreversible",
      description: "Permanently delete the database.",
    };

    // Irreversible actions strictly require deliberate physical touch on screen
    expect(() =>
      guard.evaluateConfirmation({
        action: irreversibleAction,
        speakerId: "spk_adlane",
        voiceConfidence: 0.99,
        secondFactor: { type: "PIN_OR_PASSWORD", verified: true },
      }),
    ).toThrowError(IrreversibleActionRequiresTouchConfirmationError);

    const audit = guard.auditLog;
    const lastAudit = audit[audit.length - 1];
    expect(lastAudit?.outcome).toBe("rejected");
    expect(lastAudit?.reason).toContain("require physical on-screen touch");
  });
});
