import { defineConfig } from "vitest/config";

/**
 * `pnpm evals` / `pnpm evals:record`: tool-selection evals (test/evals/**, see its README).
 * Excluded from the normal suite and from coverage. `pnpm evals` replays recorded model answers
 * (cassettes) and never calls a model; `pnpm evals:record` (`--mode record`, or EVALS_MODE=record)
 * calls the Anthropic API for cases without a current cassette and needs ANTHROPIC_API_KEY.
 * Cases run one after another, so recording reuses the prompt cache.
 */
export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    include: ["test/evals/**/*.eval.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    // Up to three API attempts of two minutes each while recording.
    testTimeout: 400_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    reporters: ["vitest-evals/reporter"],
    env: {
      EVALS_MODE: mode === "record" ? "record" : (process.env["EVALS_MODE"] ?? "replay"),
    },
  },
}));
