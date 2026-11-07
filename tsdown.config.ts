import { defineConfig } from "tsdown";

// One ESM bundle for the `mcp-server-sevdesk` bin. Runtime dependencies stay external (they are
// installed from package.json); the shebang in src/index.ts is preserved.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  fixedExtension: false,
  clean: true,
  sourcemap: true,
  dts: false,
});
