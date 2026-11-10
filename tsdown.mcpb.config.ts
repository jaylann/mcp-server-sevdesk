import { defineConfig } from "tsdown";

/**
 * The server inside the `.mcpb` bundle (Claude Desktop extension): one self-contained ESM file with
 * every runtime dependency bundled in, because a bundle ships no `node_modules`. `dist/`
 * (tsdown.config.ts) keeps its dependencies external for npm. Built by `pnpm mcpb`
 * (scripts/build-mcpb.ts), which also checks that the output imports nothing but Node built-ins
 * and writes THIRD_PARTY_LICENSES.txt for the bundled packages.
 *
 * `.mjs`, because the bundle has no package.json to declare `"type": "module"`.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "build/mcpb/server",
  fixedExtension: true,
  clean: true,
  sourcemap: false,
  dts: false,
  deps: {
    alwaysBundle: () => true,
    // Bundling every dependency is the point; no hint about it.
    onlyBundle: false,
  },
  outputOptions: { codeSplitting: false },
});
