// This package declares `"type": "module"`, while Metro loads its configuration
// as CommonJS. The explicit extension keeps both behaviors unambiguous.
const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * Metro configuration for a pnpm workspace.
 *
 * Two adjustments are required.
 *
 * 1. `watchFolders`: `@nexus/*` packages are symlinks into the workspace root.
 *
 * 2. `.js` imports targeting `.ts` sources: TypeScript understands this Node ESM
 *    convention, but Metro needs an explicit fallback.
 */

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const config = {
  watchFolders: [workspaceRoot],

  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(workspaceRoot, "node_modules"),
    ],

    // Redirect the Node built-ins used by shared code to local React Native shims.
    extraNodeModules: {
      crypto: path.resolve(projectRoot, "shim/node-crypto.js"),
    },

    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === "node:crypto" || moduleName === "crypto") {
        return {
          filePath: path.resolve(projectRoot, "shim/node-crypto.js"),
          type: "sourceFile",
        };
      }

      const relative = moduleName.startsWith(".") || moduleName.startsWith("/");

      if (relative && moduleName.endsWith(".js")) {
        try {
          // Without an extension, Metro tries `.ts`, `.tsx`, and then `.js`.
          return context.resolveRequest(context, moduleName.slice(0, -3), platform);
        } catch {
          // The `.js` file may genuinely exist, such as `index.js`.
        }
      }

      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
