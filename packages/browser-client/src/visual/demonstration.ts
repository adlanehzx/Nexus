import { redactText, uuidv7 } from "@nexus/shared";
import type { RiskLevel } from "@nexus/tools";

export interface DemonstrationRawEvent {
  type: "click" | "type" | "navigate" | "hotkey" | "scroll";
  targetElement?: string | undefined;
  coordinates?: { x: number; y: number } | undefined;
  value?: string | undefined;
  isPassword?: boolean | undefined;
  timestamp: number;
}

export interface DemonstrationPlanStep {
  stepIndex: number;
  action: "click" | "type" | "navigate" | "hotkey" | "scroll";
  description: string;
  targetElement?: string | undefined;
  coordinates?: { x: number; y: number } | undefined;
  safeValue?: string | undefined;
  requiredPermissions: string[];
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
}

export interface DemonstrationPlan {
  planId: string;
  title: string;
  createdAt: string;
  totalSteps: number;
  steps: DemonstrationPlanStep[];
  requiredPermissions: string[];
  requiresConfirmationCount: number;
  markdownSummary: string;
}

/**
 * Secret-safe user demonstration recorder and plan compiler.
 * Converts recorded user demonstrations into reviewable, permission-scoped execution plans,
 * never opaque code.
 */
export class DemonstrationPlanCompiler {
  private events: DemonstrationRawEvent[] = [];

  recordEvent(event: DemonstrationRawEvent): void {
    // Secret-safe filtering: if it's a password field or contains secrets, redact immediately
    let safeValue = event.value;
    if (event.isPassword) {
      safeValue = "[REDACTED_PASSWORD]";
    } else if (safeValue) {
      safeValue = redactText(safeValue);
    }

    this.events.push({
      ...event,
      value: safeValue,
    });
  }

  clear(): void {
    this.events = [];
  }

  compilePlan(title: string): DemonstrationPlan {
    const planId = `plan-${uuidv7()}`;
    const steps: DemonstrationPlanStep[] = [];
    const allPermissions = new Set<string>();
    let requiresConfirmationCount = 0;

    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i]!;
      let actionDesc = "";
      const stepPerms: string[] = [];
      let stepRisk: RiskLevel = "SAFE";
      let requiresConfirmation = false;

      switch (ev.type) {
        case "click":
          actionDesc = `Click at (${ev.coordinates?.x ?? 0}, ${ev.coordinates?.y ?? 0})${ev.targetElement ? ` on "${ev.targetElement}"` : ""}`;
          stepPerms.push("desktop.click");
          stepRisk = "LOW";
          break;
        case "type":
          actionDesc = `Type input text: "${ev.value ?? ""}"`;
          stepPerms.push("desktop.type");
          stepRisk = "MEDIUM";
          // If typing into terminal or command line, require confirmation
          if (ev.targetElement?.toLowerCase().includes("terminal") || ev.value?.includes("rm ")) {
            requiresConfirmation = true;
            stepRisk = "HIGH";
          }
          break;
        case "navigate":
          actionDesc = `Navigate to URL: "${ev.value ?? ""}"`;
          stepPerms.push("browser.navigate");
          stepRisk = "SAFE";
          break;
        case "hotkey":
          actionDesc = `Press keyboard hotkey combination: "${ev.value ?? ""}"`;
          stepPerms.push("desktop.hotkey");
          stepRisk = "MEDIUM";
          if (
            ev.value?.includes("Ctrl+C") ||
            ev.value?.includes("Ctrl+W") ||
            ev.value?.includes("Alt+F4")
          ) {
            requiresConfirmation = true;
          }
          break;
        case "scroll":
          actionDesc = `Scroll viewport`;
          stepPerms.push("desktop.scroll");
          stepRisk = "SAFE";
          break;
      }

      for (const p of stepPerms) allPermissions.add(p);
      if (requiresConfirmation) requiresConfirmationCount++;

      steps.push({
        stepIndex: i + 1,
        action: ev.type,
        description: actionDesc,
        targetElement: ev.targetElement,
        coordinates: ev.coordinates,
        safeValue: ev.value,
        requiredPermissions: stepPerms,
        riskLevel: stepRisk,
        requiresConfirmation,
      });
    }

    const markdownSummary = this.generateMarkdownSummary(title, steps, Array.from(allPermissions));

    return {
      planId,
      title,
      createdAt: new Date().toISOString(),
      totalSteps: steps.length,
      steps,
      requiredPermissions: Array.from(allPermissions),
      requiresConfirmationCount,
      markdownSummary,
    };
  }

  private generateMarkdownSummary(
    title: string,
    steps: DemonstrationPlanStep[],
    permissions: string[],
  ): string {
    const lines: string[] = [];
    lines.push(`# Execution Plan: ${title}`);
    lines.push("");
    lines.push(`**Total Steps**: ${steps.length}`);
    lines.push(
      `**Required Permissions**: ${permissions.map((p) => `\`${p}\``).join(", ") || "None"}`,
    );
    lines.push("");
    lines.push("### Step-by-Step Actions");
    lines.push("");
    for (const step of steps) {
      const confirmTag = step.requiresConfirmation ? " ⚠️ [REQUIRES CONFIRMATION]" : "";
      lines.push(
        `${step.stepIndex}. **${step.action.toUpperCase()}** — ${step.description} (${step.riskLevel})${confirmTag}`,
      );
    }
    return lines.join("\n");
  }
}
