/**
 * Write `tokens.css` from the compiled token module.
 *
 * Run by `pnpm --filter @nexus/design build` after tsc. The output is committed
 * so the web apps can import it without a build step on a clean checkout.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { renderTokensCss } = await import(join(here, "..", "dist", "css.js"));

const target = join(here, "..", "tokens.css");
writeFileSync(target, renderTokensCss(), "utf8");
process.stdout.write(`design: wrote ${target}\n`);
