import { defineConfig } from "vitest/config";

/**
 * `pnpm test:live`: tests against a real sevDesk account (test/live/**). Excluded from the normal
 * suite and from coverage. Without SEVDESK_API_TOKEN every test is skipped with the reason; the
 * write scenario also needs SEVDESK_LIVE_LIFECYCLE=1 and SEVDESK_LIVE_I_UNDERSTAND_WRITES=1.
 * Files and tests run one after another: they share one account and its pacing.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    reporters: ["verbose"],
  },
});
