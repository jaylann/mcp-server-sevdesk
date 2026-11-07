import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Live tests hit the real sevDesk API and evals call a model: both are opt-in via their own scripts.
    exclude: ["test/live/**", "test/evals/**", "node_modules/**", "dist/**"],
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.test.ts"],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
});
