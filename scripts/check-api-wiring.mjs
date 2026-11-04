import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * Fails when an HTTP route has no caller.
 *
 * Seventy-one of this API's routes had no client when they were counted for the
 * first time. None of them arrived that way deliberately: they accumulated
 * because nothing counted. A route with no caller is either a feature with no
 * interface or an interface that was removed and left its endpoint behind, and
 * both are cheap to find and expensive to discover later.
 *
 * Routes that legitimately have no in-repo caller — a hardware contract, an
 * endpoint called by the Python engine, an infrastructure probe — are declared
 * in docs/api-wiring-allowlist.json with a reason. The allowlist is checked
 * too: an entry that no longer matches any route is itself a failure, so the
 * file cannot rot into a list of excuses.
 */

const ROUTE_ROOT = "services/api/src/routes";
const CALLER_ROOTS = ["apps", "packages", "services"];
const CALLER_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".kt", ".swift"]);
const ALLOWLIST = "docs/api-wiring-allowlist.json";

const SKIP = /(^|\/)(node_modules|dist|build|\.next|\.venv|coverage|generated)(\/|$)/;
const IS_TEST = /(^|\/)(test|tests|__tests__|e2e)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/;

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (SKIP.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

/** `:id` and `${expr}` are the same thing to a caller: one path segment. */
function normalise(path) {
  return path
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/\{[^}]*\}/g, ":p")
    .replace(/:[A-Za-z_$][\w$]*/g, ":p")
    .split("?")[0]
    .replace(/\/+$/, "");
}

const declared = new Map();
for (const file of walk(ROUTE_ROOT)) {
  if (!file.endsWith(".ts") || IS_TEST.test(file)) continue;
  const source = readFileSync(file, "utf8");
  const prefix = file.includes(`${posix.sep}v1${posix.sep}`) ? "/api/v1" : "/api";
  const pattern = /\bapp\.(get|post|put|patch|delete)\s*\(\s*\n?\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(pattern)) {
    const route = `${match[1].toUpperCase()} ${normalise(prefix + match[3])}`;
    if (!declared.has(route)) {
      declared.set(route, `${file}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
}

const called = new Set();
for (const root of CALLER_ROOTS) {
  for (const file of walk(root)) {
    if (file.startsWith(ROUTE_ROOT) || IS_TEST.test(file)) continue;
    if (!CALLER_EXTENSIONS.has(file.slice(file.lastIndexOf(".")))) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/['"`]([^'"`\n]*\/api\/(?:v1\/)?[^'"`\n]*)['"`]/g)) {
      const raw = match[1];
      const start = raw.indexOf("/api/");
      if (start < 0) continue;
      called.add(normalise(raw.slice(start)));
    }
  }
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
const matchers = allowlist.map((entry) => {
  if (typeof entry.route !== "string" || typeof entry.reason !== "string" || !entry.reason.trim()) {
    throw new Error(`${ALLOWLIST}: every entry needs a route and a non-empty reason`);
  }
  const [method, path] = entry.route.split(" ");
  const prefix = path.endsWith("*") ? path.slice(0, -1) : undefined;
  return {
    entry,
    used: false,
    test: (route) => {
      const [candidateMethod, candidatePath] = route.split(" ");
      if (method !== "*" && method !== candidateMethod) return false;
      return prefix === undefined ? path === candidatePath : candidatePath.startsWith(prefix);
    },
  };
});

const failures = [];
const orphans = [];
for (const [route, where] of declared) {
  const path = route.split(" ")[1];
  if (called.has(path)) continue;
  const matcher = matchers.find((candidate) => candidate.test(route));
  if (matcher === undefined) {
    orphans.push(`${route}  (${where})`);
    continue;
  }
  matcher.used = true;
}

for (const matcher of matchers) {
  if (!matcher.used) {
    failures.push(`${ALLOWLIST}: "${matcher.entry.route}" matches no uncalled route — remove it`);
  }
}

if (orphans.length > 0) {
  failures.push(
    `routes with no caller (add a client, or declare them in ${ALLOWLIST} with a reason):\n    ` +
      orphans.sort().join("\n    "),
  );
}

if (failures.length > 0) {
  console.error(`API wiring check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `API wiring check passed (${declared.size} routes, ` +
    `${matchers.length} allowlisted, ${declared.size - matchers.length} with callers).`,
);
