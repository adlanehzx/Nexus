/**
 * Diagnostic reporting framework.
 *
 * A diagnostic is only valuable if it is trusted. Two core principles:
 *
 * First, a check never yields a bare boolean: it yields a status, factual detail,
 * and, when applicable, an actionable fix command.
 *
 * Second, `warn` is distinct from `fail`. An unauthenticated local setup works,
 * but with reduced protection. Conflating the two leads either to a permanently red
 * dashboard that gets ignored, or a permanently green one that asserts nothing.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  /** Checked item name. */
  name: string;
  status: CheckStatus;
  /** Factual observation: what was inspected, not inferred. */
  detail: string;
  /** Actionable command or instruction to remediate. */
  fix?: string;
}

export interface CheckGroup {
  title: string;
  results: CheckResult[];
}

const MARKS: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  skip: "–",
};

/**
 * Counts results by status.
 */
export function tally(groups: CheckGroup[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const group of groups) {
    for (const result of group.results) counts[result.status] += 1;
  }
  return counts;
}

/**
 * Diagnostic exit code: only `fail` exits with non-zero code.
 */
export function exitCodeFor(groups: CheckGroup[]): number {
  return tally(groups).fail > 0 ? 1 : 0;
}

/** Pure report renderer. */
export function renderReport(groups: CheckGroup[]): string {
  const lines: string[] = [];

  for (const group of groups) {
    if (group.results.length === 0) continue;
    lines.push("", group.title);
    const width = Math.max(...group.results.map((result) => result.name.length));
    for (const result of group.results) {
      lines.push(`  ${MARKS[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
      if (result.fix !== undefined) lines.push(`${" ".repeat(width + 7)}→ ${result.fix}`);
    }
  }

  const counts = tally(groups);
  lines.push(
    "",
    `${counts.ok} ok · ${counts.warn} warning · ${counts.fail} failed · ${counts.skip} skipped`,
  );
  return lines.join("\n");
}

export const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });

export const warn = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  status: "warn",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

export const fail = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  status: "fail",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

export const skip = (name: string, detail: string): CheckResult => ({
  name,
  status: "skip",
  detail,
});
