// ESLint 10 — configuration plate, partagée par tout le monorepo.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/src/generated/**",
      "**/*.d.ts",
      // Serveur MCP de test : exécuté comme processus enfant, hors projet TS.
      "**/test/*.mjs",
      // Interface React Native du worker Android et adaptateurs vers le moteur
      // JavaScript d'Android. Ils sont compilés par Metro, avec le préréglage
      // Babel de React Native et sa résolution de modules — pas par le projet
      // TypeScript du dépôt, dont ils ne suivent ni la résolution `NodeNext`
      // ni la contrainte `erasableSyntaxOnly`. Le code métier, lui, est dans
      // `src/` et reste vérifié ici.
      "services/android-worker/ui/**",
      "services/android-worker/shim/**",
      "services/android-worker/index.js",
      "services/android-worker/metro.config.cjs",
      "services/android-worker/babel.config.cjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Une variable inutilisée est un bug en puissance ; le préfixe _ est l'échappatoire explicite.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Les imports de types doivent être effaçables (cf. erasableSyntaxOnly).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // On veut savoir quand une promesse n'est pas attendue : c'est la source nº 1
      // de bugs silencieux dans un serveur.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },

  // Les tests ont le droit d'être plus souples sur les assertions de type.
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },

  // Fichiers de configuration à la racine des paquets : hors projet TS.
  {
    files: ["**/*.config.js", "**/*.config.ts", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    /**
     * Scripts de scénario, hors projet TypeScript.
     *
     * Ils sont exécutés par Node, pas compilés, et ne figurent donc dans aucun
     * `tsconfig` — le service de projet ne peut pas les typer. Plutôt que de les
     * exclure du lint, on y désactive les seules règles qui exigent un type :
     * les erreurs ordinaires, elles, restent attrapées.
     */
    files: ["**/scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false },
    },
  },

  prettier,
);
