import type { RiskLevel } from "@nexus/tools";
import type { McpManifest } from "../manifest.js";
import type {
  AcpAgentManifest,
  PackageAnalysisResult,
  PackageFinding,
  WorkerCatalogManifest,
  WorkflowCatalogManifest,
} from "./types.js";

const SUSPICIOUS_SHELL_PATTERNS = [
  /(\/bin\/sh|\/bin\/bash|\bcmd\.exe\b|\bpowershell\.exe\b)/i,
  /(`|\$\(.*\)|;\s*rm\s+-rf)/i,
  /\b(curl|wget)\b.*\|\s*(sh|bash)/i,
];

const SENSITIVE_PATHS = [
  /\/etc\/(passwd|shadow)/i,
  /~?\/\.(ssh|gnupg|aws|kube|env)/i,
  /\/var\/run\/docker\.sock/i,
];

const PRIVATE_OR_METADATA_HOSTS = [
  "169.254.169.254",
  "metadata.google.internal",
  "127.0.0.1",
  "localhost",
  "0.0.0.0",
];

/**
 * Analyzes an MCP server, ACP agent, worker, or workflow package statically and behaviorally.
 */
export function analyzePackage(
  manifest:
    | Record<string, unknown>
    | McpManifest
    | AcpAgentManifest
    | WorkerCatalogManifest
    | WorkflowCatalogManifest,
  rawSourceCode?: string,
): PackageAnalysisResult {
  const findings: PackageFinding[] = [];
  const egressTargets: string[] = [];
  const declaredPermissions: string[] = [];

  // 1. Analyze manifest fields
  if (
    "runtime" in manifest &&
    manifest.runtime === "remote" &&
    "url" in manifest &&
    typeof manifest.url === "string"
  ) {
    egressTargets.push(manifest.url);
    for (const badHost of PRIVATE_OR_METADATA_HOSTS) {
      if (manifest.url.includes(badHost)) {
        findings.push({
          severity: "CRITICAL",
          code: "ILLEGAL_REMOTE_TARGET",
          message: `Manifest specifies forbidden loopback or metadata egress target: ${badHost}`,
        });
      }
    }
  }

  // Check command & args
  const argsToCheck: string[] = [];
  if ("args" in manifest && Array.isArray(manifest.args)) {
    for (const a of manifest.args) {
      if (typeof a === "string") argsToCheck.push(a);
    }
  }
  if ("command" in manifest && typeof manifest.command === "string") {
    argsToCheck.push(manifest.command);
  }

  for (const arg of argsToCheck) {
    for (const shellPattern of SUSPICIOUS_SHELL_PATTERNS) {
      if (shellPattern.test(arg)) {
        findings.push({
          severity: "CRITICAL",
          code: "SHELL_INJECTION_RISK",
          message: `Suspicious shell or command execution pattern in arguments: ${arg}`,
        });
      }
    }
    for (const sensitivePath of SENSITIVE_PATHS) {
      if (sensitivePath.test(arg)) {
        findings.push({
          severity: "HIGH",
          code: "SENSITIVE_PATH_TRAVERSAL",
          message: `Reference to sensitive system path detected in arguments: ${arg}`,
        });
      }
    }
  }

  // Check permissions
  if ("defaultPermissions" in manifest && Array.isArray(manifest.defaultPermissions)) {
    for (const p of manifest.defaultPermissions) {
      if (typeof p === "string") declaredPermissions.push(p);
    }
  }
  if ("requiredPermissions" in manifest && Array.isArray(manifest.requiredPermissions)) {
    for (const p of manifest.requiredPermissions) {
      if (typeof p === "string") declaredPermissions.push(p);
    }
  }
  if ("declaredTools" in manifest && Array.isArray(manifest.declaredTools)) {
    for (const rawTool of manifest.declaredTools) {
      if (typeof rawTool === "object" && rawTool !== null) {
        const tool = rawTool as {
          name?: string;
          permissions?: string[];
          risk?: string;
          requiresConfirmation?: boolean;
        };
        if (Array.isArray(tool.permissions)) {
          for (const perm of tool.permissions) {
            if (typeof perm === "string") declaredPermissions.push(perm);
          }
        }
        if (tool.risk === "CRITICAL" && !tool.requiresConfirmation) {
          findings.push({
            severity: "CRITICAL",
            code: "UNCONFIRMED_CRITICAL_TOOL",
            message: `Tool ${tool.name ?? "unnamed"} is CRITICAL risk but has requiresConfirmation=false`,
          });
        }
      }
    }
  }

  // Check high-risk permission combinations
  const hasFilesystemWrite = declaredPermissions.some((p) => p.includes("filesystem.write"));
  const hasNetworkEgress = declaredPermissions.some(
    (p) => p.includes("network") || p.includes("fetch") || p.includes("http"),
  );
  if (hasFilesystemWrite && hasNetworkEgress) {
    findings.push({
      severity: "MEDIUM",
      code: "ELEVATED_CAPABILITY_COMBINATION",
      message: "Package requests both filesystem write and network egress capabilities",
    });
  }

  // 2. Analyze source code if provided
  if (rawSourceCode) {
    if (/\beval\s*\(/.test(rawSourceCode)) {
      findings.push({
        severity: "CRITICAL",
        code: "DYNAMIC_EVAL_USAGE",
        message: "Source code contains dynamic 'eval()' invocation",
      });
    }
    if (/new\s+Function\s*\(/.test(rawSourceCode)) {
      findings.push({
        severity: "CRITICAL",
        code: "FUNCTION_CONSTRUCTOR_USAGE",
        message: "Source code contains dynamic 'Function' constructor instantiation",
      });
    }
    if (/child_process/i.test(rawSourceCode)) {
      findings.push({
        severity: "HIGH",
        code: "RAW_CHILD_PROCESS_ACCESS",
        message: "Source code attempts direct import of 'child_process'",
      });
    }
  }

  // Deduplicate permissions & targets
  const uniquePermissions = Array.from(new Set(declaredPermissions));
  const uniqueEgress = Array.from(new Set(egressTargets));

  // Determine overall static risk
  let staticRisk: RiskLevel = "SAFE";
  const hasCritical = findings.some((f) => f.severity === "CRITICAL");
  const hasHigh = findings.some((f) => f.severity === "HIGH");
  const hasMedium = findings.some((f) => f.severity === "MEDIUM");

  if (hasCritical) {
    staticRisk = "CRITICAL";
  } else if (hasHigh) {
    staticRisk = "HIGH";
  } else if (hasMedium) {
    staticRisk = "MEDIUM";
  } else if (uniquePermissions.length > 0) {
    staticRisk = "LOW";
  }

  return {
    passed: !hasCritical,
    staticRisk,
    findings,
    egressTargets: uniqueEgress,
    declaredPermissions: uniquePermissions,
  };
}
