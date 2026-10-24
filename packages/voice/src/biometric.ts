import { AppError } from "@nexus/shared";

/**
 * Voice Biometric Multi-Factor Confirmation Guard.
 *
 * ## Principles
 * 1. Rule 11: Biometric voice MUST NEVER become the sole factor authorizing a sensitive action.
 * 2. Medium severity actions: Requires voice match (confidence >= threshold) PLUS a secondary factor.
 * 3. Irreversible / High-Impact actions (money movements, data deletion, credential export):
 *    Voice confirmation is strictly INSUFFICIENT. A deliberate physical touch confirmation is required.
 * 4. Every validation attempt produces an immutable audit record.
 */

export type ActionImpact = "low" | "medium" | "high" | "irreversible";

export interface ActionToConfirm {
  readonly id: string;
  readonly title: string;
  readonly impact: ActionImpact;
  readonly description: string;
}

export type SecondFactor =
  | { type: "PIN_OR_PASSWORD"; verified: boolean }
  | { type: "ACTIVE_DEVICE_TOUCH"; verified: boolean }
  | { type: "SESSION_PRE_AUTH"; validUntil: number };

export interface BiometricConfirmationResult {
  readonly confirmed: boolean;
  readonly actionId: string;
  readonly speakerId?: string | undefined;
  readonly voiceConfidence: number;
  readonly secondFactorUsed?: string | undefined;
  readonly error?: string | undefined;
}

export interface BiometricAuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly actionId: string;
  readonly impact: ActionImpact;
  readonly speakerId?: string | undefined;
  readonly voiceConfidence: number;
  readonly secondFactorType?: string | undefined;
  readonly outcome: "approved" | "rejected";
  readonly reason: string;
}

export class IrreversibleActionRequiresTouchConfirmationError extends AppError {
  readonly code = "IRREVERSIBLE_ACTION_REQUIRES_TOUCH";
  readonly httpStatus = 403;

  constructor(actionTitle: string) {
    super({
      message: `Action '${actionTitle}' is irreversible and cannot be approved by voice. Deliberate physical touch confirmation required.`,
      userMessage: `This sensitive action cannot be confirmed with voice. Please confirm directly on your screen.`,
      context: { actionTitle },
    });
  }
}

export class VoiceBiometricInsufficientError extends AppError {
  readonly code = "VOICE_BIOMETRIC_INSUFFICIENT";
  readonly httpStatus = 403;

  constructor(reason: string) {
    super({
      message: `Voice biometric authorization rejected: ${reason}`,
      userMessage: `Voice confirmation could not be verified: ${reason}`,
    });
  }
}

export class VoiceBiometricGuard {
  readonly #minConfidence: number;
  readonly #auditLog: BiometricAuditEvent[] = [];

  constructor(options?: { minConfidence?: number }) {
    this.#minConfidence = options?.minConfidence ?? 0.85;
  }

  get auditLog(): readonly BiometricAuditEvent[] {
    return this.#auditLog;
  }

  /**
   * Evaluates confirmation of a sensitive action.
   * Enforces multi-factor rule and irreversible action touch requirement.
   */
  evaluateConfirmation(params: {
    action: ActionToConfirm;
    speakerId?: string | undefined;
    voiceConfidence: number;
    secondFactor?: SecondFactor | undefined;
    now?: number;
  }): BiometricConfirmationResult {
    const now = params.now ?? Date.now();

    // 1. Irreversible and critical actions can NEVER be confirmed via voice alone or voice + pin
    if (params.action.impact === "irreversible" || params.action.impact === "high") {
      this.#recordAudit(
        params.action,
        params.speakerId,
        params.voiceConfidence,
        params.secondFactor?.type,
        "rejected",
        "Irreversible actions require physical on-screen touch confirmation (Rule 11).",
      );
      throw new IrreversibleActionRequiresTouchConfirmationError(params.action.title);
    }

    // 2. Low impact actions
    if (params.action.impact === "low") {
      if (params.voiceConfidence >= 0.6) {
        this.#recordAudit(
          params.action,
          params.speakerId,
          params.voiceConfidence,
          undefined,
          "approved",
          "Low-impact voice confirmation accepted.",
        );
        return {
          confirmed: true,
          actionId: params.action.id,
          speakerId: params.speakerId,
          voiceConfidence: params.voiceConfidence,
        };
      }
      this.#recordAudit(
        params.action,
        params.speakerId,
        params.voiceConfidence,
        undefined,
        "rejected",
        "Voice confidence too low for low-impact action.",
      );
      return {
        confirmed: false,
        actionId: params.action.id,
        voiceConfidence: params.voiceConfidence,
        error: "Voice confidence below threshold.",
      };
    }

    // 3. Medium impact actions: Rule 11 strictly applies:
    // "Biometric voice must never become the sole factor authorizing a sensitive action."
    if (!params.secondFactor) {
      this.#recordAudit(
        params.action,
        params.speakerId,
        params.voiceConfidence,
        undefined,
        "rejected",
        "Second factor missing (voice biometric cannot be the sole factor).",
      );
      throw new VoiceBiometricInsufficientError(
        "A second authentication factor is required for this action.",
      );
    }

    let secondFactorOk = false;
    if (params.secondFactor.type === "PIN_OR_PASSWORD" && params.secondFactor.verified) {
      secondFactorOk = true;
    } else if (params.secondFactor.type === "ACTIVE_DEVICE_TOUCH" && params.secondFactor.verified) {
      secondFactorOk = true;
    } else if (
      params.secondFactor.type === "SESSION_PRE_AUTH" &&
      params.secondFactor.validUntil > now
    ) {
      secondFactorOk = true;
    }

    if (!secondFactorOk) {
      this.#recordAudit(
        params.action,
        params.speakerId,
        params.voiceConfidence,
        params.secondFactor.type,
        "rejected",
        "Second factor verification failed or expired.",
      );
      throw new VoiceBiometricInsufficientError("Second factor verification failed or expired.");
    }

    if (params.voiceConfidence < this.#minConfidence || !params.speakerId) {
      this.#recordAudit(
        params.action,
        params.speakerId,
        params.voiceConfidence,
        params.secondFactor.type,
        "rejected",
        `Voice confidence ${params.voiceConfidence} is below minimum threshold ${this.#minConfidence}.`,
      );
      throw new VoiceBiometricInsufficientError("Speaker voice match confidence is insufficient.");
    }

    // Both voice biometric AND second factor verified
    this.#recordAudit(
      params.action,
      params.speakerId,
      params.voiceConfidence,
      params.secondFactor.type,
      "approved",
      "Multi-factor voice biometric verification succeeded.",
    );

    return {
      confirmed: true,
      actionId: params.action.id,
      speakerId: params.speakerId,
      voiceConfidence: params.voiceConfidence,
      secondFactorUsed: params.secondFactor.type,
    };
  }

  #recordAudit(
    action: ActionToConfirm,
    speakerId: string | undefined,
    voiceConfidence: number,
    secondFactorType: string | undefined,
    outcome: "approved" | "rejected",
    reason: string,
  ): void {
    this.#auditLog.push({
      id: `bioaudit_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      actionId: action.id,
      impact: action.impact,
      ...(speakerId ? { speakerId } : {}),
      voiceConfidence,
      ...(secondFactorType ? { secondFactorType } : {}),
      outcome,
      reason,
    });
  }
}
