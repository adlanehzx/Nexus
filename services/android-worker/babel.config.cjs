/**
 * Babel pour React Native.
 *
 * Le préréglage officiel, sans ajout : ce paquet ne contient ni décorateurs, ni
 * transformation exotique. Le code TypeScript est celui que Vitest exécute déjà.
 */
module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    // `zod` publie `export * as core from "..."`. Le prereglage de React Native
    // ne transforme pas cette forme, et Metro s'arrete dessus. Zod est une
    // dependance directe du worker — validation des entrees de chaque capacite —
    // et n'est donc pas contournable.
    "@babel/plugin-transform-export-namespace-from",
  ],
};
