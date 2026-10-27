import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural assertions verifying dashboard isolation.
 *
 * The primary guarantee of reasoning non-disclosure is server-side: the projection
 * never reads transcripts, and the response schema contains no field to carry it.
 * A client cannot display what the server does not send.
 *
 * These tests act as a defense-in-depth barrier preventing regression from the UI side.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

function walkFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    if (statSync(filePath).isDirectory()) found.push(...walkFiles(filePath));
    else if (/\.tsx?$/.test(entry)) found.push(filePath);
  }

  return found;
}

/**
 * Strips comments and string literals to inspect AST tokens only.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const sources = walkFiles(join(root, "src")).map((filePath) => ({
  path: filePath.slice(root.length).replace(/\\/g, "/"),
  code: stripCommentsAndStrings(readFileSync(filePath, "utf8")),
  raw: readFileSync(filePath, "utf8"),
}));

describe("reasoning is never requested", () => {
  it("never reads transcript fields", () => {
    const forbidden = ["providerBlocks", "callSignatures", "pendingConfirmation", "thinking"];

    const violations = sources.filter((file) =>
      forbidden.some((field) => file.code.includes(field)),
    );

    expect(violations.map((file) => file.path)).toEqual([]);
  });

  it("agent run row type does not declare forbidden fields", () => {
    const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
    const block = /export interface AgentRunRow \{([\s\S]*?)\n\}/.exec(api);

    expect(block).not.toBeNull();

    for (const field of ["messages", "transcript", "providerBlocks", "content"]) {
      expect(block?.[1] ?? "").not.toContain(field);
    }
  });
});

describe("administration scope remains bounded", () => {
  it("all mutations go through authenticated client", () => {
    const source = readFileSync(join(root, "src/lib/api.ts"), "utf8");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("XMLHttpRequest");
    expect(source).toContain("authorizedRequest");
  });

  it("only calls explicitly permitted administrative routes", () => {
    const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
    const paths = [...api.matchAll(/"(\/api\/v1\/[^"`]*)"/g)].map((match) => match[1] ?? "");
    const templates = [...api.matchAll(/`(\/api\/v1\/[^`]*)`/g)].map((match) => match[1] ?? "");

    for (const route of [...paths, ...templates]) {
      expect(route, route).toMatch(
        /^\/api\/v1\/(dashboard|orchestrator|connections|devices|tasks|memory|notifications|mission-control|linkedin|osint|pause)(\/|$)/,
      );
    }
  });

  it("session is the only exception and delegates to client-core", () => {
    const client = readFileSync(join(root, "src/lib/api.ts"), "utf8");

    expect(client).toContain("SessionManager");
    expect(client).not.toContain("/api/v1/auth/login");
  });
});

describe("no embedded secrets", () => {
  it("package contains no hardcoded credentials", () => {
    for (const file of sources) {
      expect(
        /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}/i.test(file.code),
        file.path,
      ).toBe(false);
    }
  });

  it("tokens are never stored in permanent browser storage", () => {
    for (const file of sources) {
      expect(file.code, file.path).not.toContain("localStorage");
    }
    const api = readFileSync(join(root, "src/lib/api.ts"), "utf8");
    expect(api).toContain("sessionStorage");
  });
});
