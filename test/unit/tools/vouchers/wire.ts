/**
 * Real-HTTP-client setup for the voucher regressions (B2, B5, B6): the client sends exactly what
 * goes on the wire, answered by scripted replies built from the fixtures.
 */
import type { Tier } from "../../../../src/safety/tiers.js";
import { createSevdeskClient } from "../../../../src/sevdesk/client.js";
import { loadFixture } from "../../../helpers/fake-client.js";
import {
  createFakeClock,
  createFakeFetch,
  type FakeReply,
  jsonResponse,
} from "../../../helpers/fake-fetch.js";
import { draftRow, positionRow } from "./routes.js";

export function wireClient(replies: FakeReply[]) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]),
      readOnly: false,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    { fetch: fake.fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
  );
  return { client, fake };
}

/** A reply with a fixture's full body. */
export function fixtureReply(path: string): FakeReply {
  return jsonResponse(loadFixture(path).body, loadFixture(path).status);
}

/** The reads of a create with supplier contact 1001, in the order `prepare` makes them. */
export function createReads(): FakeReply[] {
  return [
    fixtureReply("meta/bookkeeping-system-version.json"),
    fixtureReply("drafts/sev-client.json"),
    fixtureReply("recorded/2026-11-07/meta/receipt-guidance-all.json"),
    fixtureReply("recorded/2026-11-07/meta/account-datev.json"),
    fixtureReply("contacts/contact-1001.json"),
    jsonResponse({ objects: [] }),
  ];
}

/** The read-back of voucher 2101 after the save. */
export function readBackReplies(): FakeReply[] {
  return [
    jsonResponse({ objects: [draftRow({ document: { id: "7101", objectName: "Document" } })] }),
    jsonResponse({ objects: [positionRow()], total: 1 }),
  ];
}

/** A create call of draft 2101 (119.00 gross at 19 % on account 4266). */
export const CREATE_ARGS = {
  supplierId: 1001,
  number: "ER-2026-0815",
  date: "2026-11-02",
  positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
};
