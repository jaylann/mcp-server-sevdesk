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
 *   delete); requires human confirmation (M3).
 * - `external`: reaches third parties, e.g. emailing an invoice; requires human confirmation (M3).
 */
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}
