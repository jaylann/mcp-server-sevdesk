/**
 * Offers and their confirmation (spec/deviations.md D-107, D-108; recorded 2026-11-16):
 *
 * - `PUT /Order/{id}` with `{status}` on a draft offer accepts it and renumbers it, and
 *   `createContractNoteFromOrder` accepts the offer it is made from, a draft or a rejected one
 *   included. So a draft offer is never accepted or confirmed, and a rejected one is never
 *   confirmed (its rejection would silently become an acceptance): all refused before any
 *   request.
 * - sevDesk takes every field of `Model_OrderUpdate` it is sent along (D-003), so the status body
 *   carries the status and nothing else, even when built with more.
 */
import { describe, expect, it } from "vitest";

import { orderStatusPayload, setOrderStatus } from "../../src/domain/lifecycle/actions.js";
import { orderCreateConfirmationTool } from "../../src/tools/orders/create-confirmation.js";
import { orderSetOfferStatusTool } from "../../src/tools/orders/offer-status.js";
import { withCountryRoute } from "../helpers/country-route.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { prepareWrite } from "../helpers/write-tools.js";
import { documentRoute, positionRoutes, type Row } from "../unit/tools/lifecycle/helpers.js";
import { sentOffer } from "../write-cases/orders.js";

function client(offer: Row): FakeSevdeskClient {
  return new FakeSevdeskClient(
    withCountryRoute([
      documentRoute("order", offer),
      { path: "/Order", response: { body: { objects: [] } } },
      ...positionRoutes(),
    ]),
  );
}

describe("offers: drafts are never accepted or confirmed, rejections never confirmed", () => {
  it.each(["accept", "reject", "reopen"])("refuses to %s a draft offer", async (action) => {
    const fake = client({ ...sentOffer, status: "100" });
    await expect(
      prepareWrite(orderSetOfferStatusTool, { id: 3001, action }, fake),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(fake.writes()).toEqual([]);
  });

  it.each(["100", "300"])("refuses a confirmation from an offer with status %s", async (status) => {
    const fake = client({ ...sentOffer, status });
    await expect(
      prepareWrite(orderCreateConfirmationTool, { orderId: 3001 }, fake),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(fake.writes()).toEqual([]);
  });
});

describe("offers: the status body is the status alone", () => {
  it("builds and sends only {status}", async () => {
    expect(orderStatusPayload(500)).toEqual({ status: 500 });
    const fake = new FakeSevdeskClient([
      { method: "PUT", path: "/Order/3001", response: { body: { objects: sentOffer } } },
    ]);
    // A payload that picked up more on the way is refused before anything is sent.
    const widened = { status: 500, orderNumber: "AN-9999" } as unknown as ReturnType<
      typeof orderStatusPayload
    >;
    await expect(setOrderStatus(fake, 3001, widened)).rejects.toThrow();
    expect(fake.writes()).toEqual([]);

    await setOrderStatus(fake, 3001, orderStatusPayload(300));
    expect(fake.writes().map((call) => call.body)).toEqual([{ status: 300 }]);
  });
});
