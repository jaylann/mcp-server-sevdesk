import { z } from "zod";

/**
 * Spread into the input of every write tool (`write`, `commit`, `external`); read tools must not
 * have it. `validateToolDefinition` enforces both. The framework handles the flag: tools never
 * read it.
 */
export const dryRunInputShape = {
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Preview only: check the action and return exactly what it would do, without changing " +
        "anything in sevDesk and without asking the user. Defaults to false.",
    ),
};

/** The argument name the framework reserves for dry runs. */
export const DRY_RUN_ARGUMENT = "dryRun";
