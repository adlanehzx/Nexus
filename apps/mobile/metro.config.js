// Metro loads this configuration file via CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require("expo/metro-config");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

/**
 * Metro configuration for ESM-style imports.
 *
 * **The monorepo is not manually configured here**, and this is deliberate: since SDK 57,
 * `getDefaultConfig` already monitors each workspace package individually and declares
 * the two `nodeModulesPaths`. An earlier version of this file replaced that targeted
 * list with the root of the repo. Metro would then watch everything — `node_modules`,
 * Python virtualenvs, build folders — within a tree synchronized by cloud providers.
 * The watcher would time out at startup ("Failed to start watch mode"), the file map
 * remained empty, and every request subsequently crashed with an incomprehensible
 * `undefined` far from the root cause.
 */

const config = getDefaultConfig(__dirname);

/**
 * Handle `.js` import specifiers that target TypeScript files.
 *
 * The whole project uses `import { useNexus } from "../lib/nexus.js"`. This is the
 * correct form for TypeScript `NodeNext` resolution across monorepo packages. Changing
 * it here just to satisfy Metro would cause mobile to diverge from the rest of the codebase.
 *
 * Metro does not map `.js` to `.ts` automatically: it looks for `lib/nexus.js`, fails to
 * find it, and stops. We give it a targeted fallback: normal resolution is tried first,
 * so compiled `.js` files (like `@nexus/client-core/dist`) continue to resolve as expected.
 * The fallback activates only when standard resolution fails.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  /**
   * `@nexus/client-core` re-exports its peer-sync module, which imports `node:crypto`.
   * The mobile app does not use that module, but the barrel makes Metro bundle it, and
   * Metro has no such builtin: without this the app does not build at all. The shim
   * throws if anything ever calls it, so a future use fails loudly instead of quietly
   * running without encryption. See docs/BACKEND-GAPS.md.
   */
  if (moduleName === "node:crypto") {
    return { type: "sourceFile", filePath: path.join(__dirname, "lib/shims/node-crypto.ts") };
  }

  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
      return context.resolveRequest(context, moduleName.slice(0, -".js".length), platform);
    }
    throw error;
  }
};

module.exports = config;
