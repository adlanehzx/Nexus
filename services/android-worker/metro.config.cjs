// Fichier en `.cjs` : le paquet declare `"type": "module"`, et Metro charge sa
// configuration en CommonJS. L'extension explicite evite d'avoir a choisir entre
// les deux pour tout le paquet.
const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * Metro, dans un dépôt pnpm.
 *
 * Deux ajustements, et seulement deux.
 *
 * 1. **`watchFolders`** — les paquets `@nexus/*` sont des liens symboliques vers
 *    la racine du dépôt. Sans cette ligne, Metro refuse de sortir du dossier du
 *    paquet et ne trouve ni `@nexus/worker-core`, ni `@nexus/protocol`.
 *
 * 2. **Les imports en `.js` vers des fichiers `.ts`** — le dépôt compile en
 *    modules ES avec résolution Node, ce qui impose d'écrire `./worker.js` même
 *    quand le fichier sur le disque est `worker.ts`. TypeScript comprend cette
 *    convention, Metro non. On la lui traduit ici plutôt que de renoncer à la
 *    convention dans le seul paquet Android.
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

    // Les modules integres de Node que le code partage utilise, rediriges vers
    // des adaptateurs locaux. Voir `shim/` : l'alea vient de `SecureRandom`,
    // et tout ce qui n'est pas implemente leve plutot que d'approximer.
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

      const relatif = moduleName.startsWith(".") || moduleName.startsWith("/");

      if (relatif && moduleName.endsWith(".js")) {
        try {
          // On tente d'abord sans extension : Metro essaiera alors `.ts`,
          // `.tsx`, puis `.js`, dans cet ordre.
          return context.resolveRequest(context, moduleName.slice(0, -3), platform);
        } catch {
          // Le fichier `.js` existe peut-être vraiment — `index.js` en est un.
        }
      }

      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
