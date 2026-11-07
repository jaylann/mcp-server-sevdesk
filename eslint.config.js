// ESLint flat config. Layering (later entries win):
//   1. @eslint/js recommended
//   2. typescript-eslint strict-type-checked (type-aware via projectService)
//   3. import sorting + project rules
//   4. eslint-config-prettier LAST: turns off formatting rules so Prettier owns formatting.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/**", "coverage/**", "node_modules/**", "spec/**"]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // The stdio transport owns stdout; anything else written there corrupts the protocol.
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },

  {
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },

  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
