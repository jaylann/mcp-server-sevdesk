// ESLint flat config. Layering (later entries win):
//   1. @eslint/js recommended
//   2. typescript-eslint strict-type-checked (type-aware via projectService)
//   3. import sorting + project rules
//   4. the layers of src/ (tools → domain → sevdesk client), see below
//   5. eslint-config-prettier LAST: turns off formatting rules so Prettier owns formatting.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

// ---------------------------------------------------------------------------------------------
// Layers of src/ (docs/architecture.md): tools → domain → sevdesk client, each calling only the
// one to its right; src/safety/ is used by all three. Imports inside src/ are relative, so a
// layer is recognized by its path segment ("../sevdesk/…", "../../tools/…").
// ---------------------------------------------------------------------------------------------

/** A `no-restricted-imports` pattern for every import from one of `layers` (directories of src/). */
function importsFrom(layers, message) {
  return { regex: `^(?:\\.\\./)+(?:${layers.join("|")})/`, message };
}

/**
 * `no-restricted-imports` for a tool file. From the client layer a tool may import only the
 * modules in `sevdeskModules`: what it needs to report errors, handle dates and name the client
 * type. Requests, paths, the envelope and wire schemas are the domain layer's business. The file
 * system is reached through `ToolContext.files` (src/safety/) only.
 */
function toolImports(sevdeskModules) {
  const fileSystem =
    "Tools read and hand out files only through ToolContext.files (src/safety/file-access.ts).";
  return [
    "error",
    {
      paths: [
        { name: "node:fs", message: fileSystem },
        { name: "node:fs/promises", message: fileSystem },
      ],
      patterns: [
        {
          regex: `^(?:\\.\\./)+sevdesk/(?!(?:${sevdeskModules.join("|")})\\.js$)`,
          message:
            "Layering: tools call src/domain/, which calls the sevDesk client. From src/sevdesk/ a " +
            `tool may import only ${sevdeskModules.map((name) => `${name}.js`).join(", ")}; put ` +
            "requests, paths and wire parsing into a domain function.",
        },
      ],
    },
  ];
}

/** What a tool may import from src/sevdesk/: error class and helpers, date helpers, types. */
const TOOL_SEVDESK_MODULES = ["errors", "dates", "types"];

const CLIENT_CALL_MESSAGE =
  "Layering: tools never call the sevDesk client. Pass ctx.client to a function in src/domain/ " +
  "that builds and sends the request.";
const CLIENT_METHODS = "/^(request|list|listAll|download)$/";

const layering = [
  {
    name: "layering/tools",
    files: ["src/tools/**/*.ts"],
    rules: {
      "no-restricted-imports": toolImports(TOOL_SEVDESK_MODULES),
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Layering: only src/sevdesk/ sends HTTP requests to sevDesk." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // ctx.client.request(…), deps.client.list(…)
          selector: `CallExpression[callee.property.name=${CLIENT_METHODS}][callee.object.property.name='client']`,
          message: CLIENT_CALL_MESSAGE,
        },
        {
          // client.request(…)
          selector: `CallExpression[callee.property.name=${CLIENT_METHODS}][callee.object.name='client']`,
          message: CLIENT_CALL_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message: "Layering: only src/sevdesk/ sends HTTP requests to sevDesk.",
        },
      ],
    },
  },
  {
    // The write flow is the one place that wraps the client per call: read-only for `prepare`,
    // scoped to the tool's tier for `execute`.
    name: "layering/tools-write-flow",
    files: ["src/tools/write-flow.ts"],
    rules: {
      "no-restricted-imports": toolImports([...TOOL_SEVDESK_MODULES, "scoped-client"]),
    },
  },
  {
    name: "layering/domain",
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            importsFrom(
              ["tools"],
              "Layering: src/domain/ does not import from src/tools/ (types included). Types " +
                "both need are in src/safety/write-types.ts.",
            ),
          ],
        },
      ],
    },
  },
  {
    name: "layering/safety",
    files: ["src/safety/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            importsFrom(
              ["tools", "domain"],
              "Layering: src/safety/ is used by tools, domain and the client; it imports from " +
                "neither src/tools/ nor src/domain/ (types included).",
            ),
          ],
        },
      ],
    },
  },
  {
    name: "layering/sevdesk",
    files: ["src/sevdesk/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            importsFrom(
              ["tools", "domain"],
              "Layering: src/sevdesk/ is the HTTP client and knows nothing about tools or the " +
                "domain layer (types included).",
            ),
          ],
        },
      ],
    },
  },
];

export default defineConfig(
  globalIgnores([
    "dist/**",
    "build/**",
    "coverage/**",
    "node_modules/**",
    "spec/**",
    // Generated by `pnpm pages:assets`: base64 of the page fonts and icon.
    "src/pages/assets.generated.ts",
  ]),

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

  ...layering,

  prettier,
);
