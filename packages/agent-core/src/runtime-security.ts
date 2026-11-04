/**
 * NEXUS Unified Agent Runtime - Security, Sandbox Containment & Permission Enforcement
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { RiskLevel } from "@nexus/tools";

export type PermissionDisposition = "allow" | "ask" | "deny";

export interface HumanConfirmationRequest {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  description: string;
  targetPath?: string;
  commandLine?: string;
  createdAt: string;
}

export interface SecurityEvaluation {
  disposition: PermissionDisposition;
  reason?: string;
  confirmationRequest?: HumanConfirmationRequest;
}

/**
 * Robust, symlink-aware filesystem path containment checker.
 * Defends against symlink attacks, relative traversal (`..`), and non-canonical path exploits.
 */
export class SymlinkAwarePathChecker {
  /**
   * Evaluates if `targetPath` is strictly contained within `workspaceRoot`.
   * Follows realpath resolution on existing ancestors to prevent symlink bypasses.
   */
  static isContained(targetPath: string, workspaceRoot: string): boolean {
    const trimmedTarget = targetPath.trim();
    const trimmedRoot = workspaceRoot.trim();
    if (!trimmedTarget || !trimmedRoot) {
      return false;
    }

    try {
      const canonicalRoot =
        this.resolveCanonicalPath(trimmedRoot, process.cwd()) ?? NodePath.resolve(trimmedRoot);
      const canonicalTarget = this.resolveCanonicalPath(trimmedTarget, canonicalRoot);
      if (!canonicalTarget) {
        return false;
      }

      const relative = NodePath.relative(canonicalRoot, canonicalTarget);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${NodePath.sep}`) &&
          !NodePath.isAbsolute(relative))
      );
    } catch {
      // Fail closed on any FS or resolution error
      return false;
    }
  }

  private static resolveCanonicalPath(
    pathToCheck: string,
    fallbackRoot: string,
  ): string | undefined {
    let candidate = NodePath.isAbsolute(pathToCheck)
      ? pathToCheck
      : NodePath.resolve(fallbackRoot, pathToCheck);

    const missingSuffix: string[] = [];

    while (true) {
      try {
        const resolved = NodeFS.realpathSync.native(candidate);
        return NodePath.resolve(resolved, ...missingSuffix);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          return undefined;
        }
      }

      const parent = NodePath.dirname(candidate);
      if (parent === candidate) {
        return undefined;
      }

      missingSuffix.unshift(NodePath.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Evaluates tool calls against security policies and workspace containment.
 */
export class ToolSecurityPolicyEvaluator {
  private readonly workspaceRoot: string;
  private readonly autoApproveMaxRisk: RiskLevel;

  constructor(workspaceRoot: string, autoApproveMaxRisk: RiskLevel = "LOW") {
    this.workspaceRoot = workspaceRoot;
    this.autoApproveMaxRisk = autoApproveMaxRisk;
  }

  private static readonly SYSTEM_CRITICAL_PREFIXES = [
    "/etc",
    "/sys",
    "/proc",
    "/dev",
    "/boot",
    "/root",
    "/var/run",
  ];

  private static readonly DANGEROUS_COMMAND_PATTERNS = [
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+[/*]/,
    /\bmkfs(\.[a-z0-9]+)?\b/,
    /\bdd\s+if=/,
    /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+\//,
    /\b(curl|wget)\b.*\|\s*(bash|sh|zsh)\b/,
    />\s*\/dev\/([sh]d[a-z]|nvme)/,
  ];

  private static readonly PATH_KEYS = [
    "path",
    "targetPath",
    "filePath",
    "targetFile",
    "directory",
    "dir",
    "file",
    "cwd",
    "worktreePath",
    "workspaceRoot",
    "snapshotRoot",
    "sourcePath",
    "destinationPath",
    "from",
    "to",
  ];

  evaluateToolCall(
    toolName: string,
    args: Record<string, unknown>,
    declaredRisk: RiskLevel = "LOW",
  ): SecurityEvaluation {
    // 1. Filesystem inspection for all known path keys and array of paths
    const pathsToInspect: string[] = [];
    for (const key of ToolSecurityPolicyEvaluator.PATH_KEYS) {
      const val = args[key];
      if (typeof val === "string" && val.trim().length > 0) {
        pathsToInspect.push(val.trim());
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.trim().length > 0) {
            pathsToInspect.push(item.trim());
          }
        }
      }
    }

    for (const pathArg of pathsToInspect) {
      // Check for forbidden root/system directories -> outright DENY
      const normalized = NodePath.normalize(pathArg);
      if (
        normalized === "/" ||
        ToolSecurityPolicyEvaluator.SYSTEM_CRITICAL_PREFIXES.some(
          (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
        )
      ) {
        return {
          disposition: "deny",
          reason: `Access to system-critical directory '${pathArg}' is strictly prohibited.`,
        };
      }

      // Check workspace containment
      const isContained = SymlinkAwarePathChecker.isContained(pathArg, this.workspaceRoot);
      if (!isContained) {
        return {
          disposition: "ask",
          reason: `Tool '${toolName}' requested access to path '${pathArg}' outside workspace root '${this.workspaceRoot}'.`,
          confirmationRequest: {
            id: `sec-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            toolName,
            riskLevel: "HIGH",
            description: `Access to external path: ${pathArg}`,
            targetPath: pathArg,
            createdAt: new Date().toISOString(),
          },
        };
      }
    }

    // 2. Command execution inspection
    const cmdArg = (args.command ?? args.commandLine ?? args.cmd ?? args.script) as
      string | undefined;
    if (typeof cmdArg === "string" && cmdArg.length > 0) {
      // Check for destructive shell patterns -> outright DENY
      for (const pattern of ToolSecurityPolicyEvaluator.DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(cmdArg)) {
          return {
            disposition: "deny",
            reason: `Execution of potentially destructive shell command is strictly forbidden.`,
          };
        }
      }

      // Shell execution always requires confirmation unless autoApprove is configured for HIGH
      if (
        this.isRiskHigher(declaredRisk, this.autoApproveMaxRisk) ||
        declaredRisk === "HIGH" ||
        declaredRisk === "CRITICAL"
      ) {
        return {
          disposition: "ask",
          reason: `Command execution requires user confirmation.`,
          confirmationRequest: {
            id: `sec-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            toolName,
            riskLevel: declaredRisk,
            description: `Execute command: ${cmdArg.slice(0, 100)}`,
            commandLine: cmdArg,
            createdAt: new Date().toISOString(),
          },
        };
      }
    }

    // 3. Risk level threshold check
    if (this.isRiskHigher(declaredRisk, this.autoApproveMaxRisk)) {
      return {
        disposition: "ask",
        reason: `Risk level ${declaredRisk} exceeds auto-approve threshold ${this.autoApproveMaxRisk}.`,
        confirmationRequest: {
          id: `sec-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          toolName,
          riskLevel: declaredRisk,
          description: `Tool ${toolName} with risk level ${declaredRisk}`,
          createdAt: new Date().toISOString(),
        },
      };
    }

    return { disposition: "allow" };
  }

  private isRiskHigher(a: RiskLevel, b: RiskLevel): boolean {
    const weights: Record<RiskLevel, number> = {
      SAFE: 0,
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      CRITICAL: 4,
    };
    return (weights[a] ?? 0) > (weights[b] ?? 0);
  }
}
