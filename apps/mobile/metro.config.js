// Metro charge ce fichier de configuration en CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require("expo/metro-config");

/**
 * Metro, pour des imports en style ESM.
 *
 * **Le monorepo n'est pas configuré ici**, et c'est délibéré : depuis le SDK 57,
 * `getDefaultConfig` surveille déjà chaque paquet de l'espace de travail
 * individuellement et déclare les deux `nodeModulesPaths`. Une version
 * antérieure de ce fichier remplaçait cette liste ciblée par la racine du dépôt.
 * Metro se mettait alors à surveiller tout — `node_modules`, environnements
 * Python, dossiers de build — dans une arborescence synchronisée par OneDrive.
 * Le surveillant expirait au démarrage (« Failed to start watch mode »), la
 * carte des fichiers restait vide, et chaque requête plantait ensuite sur un
 * `undefined` incompréhensible loin de la cause.
 */

const config = getDefaultConfig(__dirname);

/**
 * Les imports terminés par `.js` qui désignent du TypeScript.
 *
 * Tout le projet écrit `import { useNexus } from "../lib/nexus.js"`. C'est la
 * forme correcte pour TypeScript en résolution `NodeNext`, et c'est la même dans
 * les onze paquets du dépôt — la changer ici pour plaire à Metro ferait diverger
 * l'application mobile du reste, et le prochain fichier écrit à l'identique
 * casserait à nouveau.
 *
 * Metro, lui, ne fait pas cette correspondance : il cherche `lib/nexus.js`, ne
 * le trouve pas, et s'arrête. On lui donne donc la seconde chance qui lui
 * manque, **et seulement celle-là** : la résolution normale est tentée d'abord,
 * si bien qu'un vrai fichier `.js` — le `dist/` compilé de `@nexus/client-core`,
 * par exemple — continue d'être résolu comme avant. Le repli ne sert que là où
 * la résolution aurait échoué.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
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
