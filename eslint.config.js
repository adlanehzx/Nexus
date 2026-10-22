// ESLint 10 flat configuration shared by the entire monorepo.
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
      // MCP test server executed as a child process outside the TS project.
      "**/test/*.mjs",
      // Android React Native UI and JavaScript engine adapters are compiled by
      // Metro and Babel, not by the repository's NodeNext TypeScript project.
      // Business logic remains checked under src/.
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
      // Unused variables are errors; an underscore is the explicit escape hatch.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Type imports must remain erasable.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Unawaited promises are a primary source of silent server failures.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },

  // Tests may use looser type assertions.
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },

  // Root package configuration files live outside package TS projects.
  {
    files: ["**/*.config.js", "**/*.config.ts", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    /**
     * Scenario scripts outside the TypeScript project.
     *
     * Node executes these scripts directly, so no tsconfig can provide type
     * information. Disable only type-aware rules and retain ordinary linting.
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
