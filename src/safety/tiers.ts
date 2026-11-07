/**
 * Permission tiers. Every tool belongs to exactly one tier; tools above the allowed tiers are
 * never registered, re-checked by the dispatcher, and blocked again by the HTTP client.
 *
 * Ordered from least to most consequential.
 */
export const TIERS = ["read", "write", "commit", "external"] as const;

/**
 * - `read`: list, get, search, reports and previews; no changes in sevDesk.
 * - `write`: create or change reversible things (contacts, parts, drafts).
 * - `commit`: legally binding or hard-to-undo bookkeeping (finalize, book, cancel, enshrine,
 *   reset); requires human confirmation.
 * - `external`: reaches third parties, e.g. emailing an invoice; requires human confirmation.
 */
export type Tier = (typeof TIERS)[number];

/** Every tier that changes something in sevDesk. */
export type WriteTier = Exclude<Tier, "read">;

const WRITE_TIERS: readonly WriteTier[] = ["write", "commit", "external"];

/**
 * Tiers whose tools run only after a human approved the exact action (elicitation or the local
 * approval page, see `SEVDESK_CONFIRM`). A `confirm: true` argument is never a substitute: the
 * model would set it itself.
 */
const CONFIRMED_TIERS: ReadonlySet<Tier> = new Set<Tier>(["commit", "external"]);

/** One-line explanations, used in instructions, errors and the docs. */
export const TIER_DESCRIPTIONS: Readonly<Record<Tier, string>> = {
  read: "reads only; changes nothing in sevDesk",
  write: "creates or changes reversible records (contacts, parts, drafts)",
  commit:
    "legally binding or hard-to-undo bookkeeping (finalize, book payments, cancel, enshrine); " +
    "asks a human first",
  external: "reaches third parties, e.g. emails a document to a customer; asks a human first",
};

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export function isWriteTier(value: string): value is WriteTier {
  return (WRITE_TIERS as readonly string[]).includes(value);
}

/** Whether tools of `tier` need human confirmation. */
export function requiresConfirmation(tier: Tier): boolean {
  return CONFIRMED_TIERS.has(tier);
}

/** Position in {@link TIERS}; a higher rank may do everything a lower one may. */
function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** Whether a tool of `tier` may make a request that needs at least `required`. */
export function tierCovers(tier: Tier, required: Tier): boolean {
  return tierRank(tier) >= tierRank(required);
}
