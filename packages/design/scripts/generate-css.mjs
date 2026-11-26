/**
 * Write `tokens.css` (Signal) and `cadran.css` (Cadran) from the compiled token modules.
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

// Cadran: the identity of the redesigned web dashboard, same variable names.
const { renderCadranCss } = await import(join(here, "..", "dist", "cadran-css.js"));
const cadranTarget = join(here, "..", "cadran.css");
writeFileSync(cadranTarget, renderCadranCss(), "utf8");
process.stdout.write(`design: wrote ${cadranTarget}\n`);
