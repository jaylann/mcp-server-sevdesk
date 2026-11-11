/**
 * Reminders hidden by sevDesk's default invoice list.
 *
 * `GET /Invoice` leaves payment reminders (Mahnungen, type MA) out unless `showAll=true` (or
 * `showMa=all`, which returns the reminders only) is sent: recorded twice, 39 rows against 43
 * and 74 against 84 (spec/deviations.md D-049). `sevdesk_changed_since` listed invoices without
 * it, so a reminder created or changed after `since` was never reported, and no paging could
 * find it (review 2026-11, round 3). The change report therefore reads invoices with
 * `showAll=true`.
 */
import { describe, expect, it } from "vitest";

import { changedSince } from "../../src/domain/reports/changes.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";

type Raw = Record<string, unknown>;

/** A recorded-shape invoice row turned into a reminder changed after `since`. */
function reminder(): Raw {
  const body = loadFixture("invoices/invoices-list.json").body as { objects: Raw[] };
  return {
    ...structuredClone(body.objects[0]),
    id: "77",
    invoiceType: "MA",
    invoiceNumber: "MA-1001",
    update: "2026-11-02T09:00:00+01:00",
  };
}

/** sevDesk as recorded: the reminder comes only with `showAll=true`. */
const routes: FakeRoute[] = [
  { path: "/Invoice", query: { showAll: "true" }, response: { body: { objects: [reminder()] } } },
  { path: "/Invoice", response: { body: { objects: [] } } },
];

describe("sevdesk_changed_since and reminders (D-049)", () => {
  it("asks for invoices of all types and reports a changed reminder", async () => {
    const client = new FakeSevdeskClient(routes);

    const report = await changedSince(client, {
      since: "2026-11-01",
      subjects: ["invoices"],
      limit: 20,
      offset: 0,
    });

    expect(client.callsTo("/Invoice").map((call) => call.query["showAll"])).toEqual(["true"]);
    expect(report.subjects[0]?.items.map((row) => [row.id, row.type, row.number])).toEqual([
      [77, "MA", "MA-1001"],
    ]);
    expect(report.subjects[0]?.total).toBe(1);
  });
});
