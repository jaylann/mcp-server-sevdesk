import { describe, expect, it } from "vitest";

import { getContactDetails } from "../../../../src/domain/contacts.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { contactGetTool as tool } from "../../../../src/tools/contacts/get.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const contactFilter = { "contact[id]": "1001", "contact[objectName]": "Contact" };

function routes(
  overrides: {
    addresses?: FakeRoute["response"];
    contact?: FakeRoute["response"];
    customFields?: FakeRoute["response"];
  } = {},
) {
  return [
    {
      path: "/Contact/1001",
      response: overrides.contact ?? { fixture: "contacts/contact-1001.json" },
    },
    {
      path: "/ContactAddress",
      query: contactFilter,
      response: overrides.addresses ?? { fixture: "contacts/contact-addresses-1001.json" },
    },
    {
      path: "/CommunicationWay",
      query: contactFilter,
      response: { fixture: "contacts/communication-ways-1001.json" },
    },
    {
      path: "/ContactCustomField",
      query: { ...contactFilter, embed: "contactCustomFieldSetting" },
      response: overrides.customFields ?? { fixture: "contacts/custom-fields-1001.json" },
    },
  ] satisfies FakeRoute[];
}

/** One custom field value row of `contact` for setting 19498, in sevDesk's shape. */
function valueRow(id: number, contact: number, value: string, name = "Kundennr extern") {
  return {
    id: String(id),
    objectName: "ContactCustomField",
    contact: { id: String(contact), objectName: "Contact" },
    contactCustomFieldSetting: { id: "19498", objectName: "ContactCustomFieldSetting", name },
    value,
  };
}

/** `count` address rows of contact 1001 in sevDesk's shape (the fake pages them). */
function manyAddresses(count: number): FakeRoute["response"] {
  const objects = Array.from({ length: count }, (_, index) => ({
    id: String(100_000 + index),
    objectName: "ContactAddress",
    contact: { id: "1001", objectName: "Contact" },
    street: `Musterstraße ${index + 1}`,
    zip: "12345",
    city: "Musterstadt",
    country: { id: "1", objectName: "StaticCountry" },
    category: { id: "48", objectName: "Category" },
  }));
  return { body: { objects } };
}

async function get(id: number, fakeRoutes: readonly FakeRoute[] = routes()) {
  const client = new FakeSevdeskClient(withCountryRoute(fakeRoutes));
  const result = await tool.handler(tool.input.parse({ id }), testContext(client));
  return { client, result };
}

describe("sevdesk_contact_get (community: recorded shapes, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("returns the contact with addresses, communication ways and custom fields, GETs only", async () => {
    const { client, result } = await get(1001);
    expect(client.methods()).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(client.callsTo("/ContactAddress")[0]?.query).toMatchObject({
      "contact[id]": 1001,
      "contact[objectName]": "Contact",
      limit: 1000,
    });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.contact).toMatchObject({
      id: 1001,
      displayName: "Musterfirma GmbH",
      link: "https://my.sevdesk.de/crm/detail/id/1001",
    });
    expect(result.data.addresses).toEqual([
      {
        id: 3001,
        recipient: "Musterfirma GmbH\nBuchhaltung",
        street: "Musterstraße 1",
        zip: "12345",
        city: "Musterstadt",
        countryId: 1,
        country: "DE",
        category: { id: 47, name: "Rechnungsanschrift" },
      },
      expect.objectContaining({ id: 3002, category: { id: 48, name: "Lieferanschrift" } }),
    ]);
    expect(result.data.communicationWays).toEqual([
      {
        id: 4001,
        type: "EMAIL",
        value: "rechnung@example.com",
        key: { id: 8, name: "Rechnungsadresse" },
        main: true,
      },
      expect.objectContaining({ id: 4002, type: "PHONE", main: false }),
      expect.objectContaining({ id: 4003, type: "WEB", key: { id: 2, name: "Arbeit" } }),
    ]);
    expect(result.data.addressesComplete).toBe(true);
    expect(result.data.communicationWaysComplete).toBe(true);
    // D-086: no contact read shows custom fields; one more read with the setting embedded.
    expect(client.callsTo("/ContactCustomField")[0]?.query).toMatchObject({
      "contact[id]": 1001,
      "contact[objectName]": "Contact",
      embed: "contactCustomFieldSetting",
      limit: 1000,
    });
    expect(result.data.customFields).toEqual([
      { id: 7001, settingId: 19498, name: "Kundennr extern", value: "EXT-4711" },
      { id: 7002, settingId: 19499, name: "Branche", value: "Großhandel" },
    ]);
    expect(result.data.customFieldsComplete).toBe(true);
    expect(result.summary).toBe(
      "Contact 1001 (organisation) with 2 addresses, 3 communication ways and 2 custom field " +
        "values.",
    );
  });

  it("drops other contacts' custom field values and cleans their text (D-035)", async () => {
    const { result } = await get(
      1001,
      routes({
        customFields: {
          body: {
            objects: [valueRow(7101, 1001, "EXT​-1‮", "Kunden​nr"), valueRow(7102, 2002, "fremd")],
          },
        },
      }),
    );
    expect(result.data.customFields).toEqual([
      { id: 7101, settingId: 19498, name: "Kundennr", value: "EXT-1" },
    ]);
    expect(result.data.customFieldsComplete).toBe(true);
  });

  it("still returns the contact when its custom fields cannot be read, and says so", async () => {
    const error = new SevdeskError({ kind: "server", message: "sevDesk failed.", status: 500 });
    const { result } = await get(1001, routes({ customFields: { error } }));
    expect(result.data.contact.id).toBe(1001);
    expect(result.data.customFields).toEqual([]);
    expect(result.data.customFieldsComplete).toBe(false);
    // No "0 custom field values": an unread list is no count.
    expect(result.summary).toBe(
      "Contact 1001 (organisation) with 2 addresses and 3 communication ways. Its custom field " +
        "values could not be read.",
    );
  });

  it("does not swallow a cancellation of the custom field read", async () => {
    const error = new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
    const client = new FakeSevdeskClient(withCountryRoute(routes({ customFields: { error } })));
    await expect(tool.handler({ id: 1001 }, testContext(client))).rejects.toBe(error);
  });

  it("says so when sevDesk had more custom field values than could be read", async () => {
    const objects = Array.from({ length: 10_001 }, (_, index) =>
      valueRow(100_000 + index, 1001, `V-${index}`),
    );
    const { result } = await get(1001, routes({ customFields: { body: { objects } } }));
    expect(result.data.customFields).toHaveLength(10_000);
    expect(result.data.customFieldsComplete).toBe(false);
    expect(result.summary).toMatch(
      /Partial: sevDesk had more custom field values than could be read\.$/,
    );
  });

  it("drops other contacts' addresses and reads on if sevDesk ignores the filter", async () => {
    const { client, result } = await get(
      1001,
      routes({ addresses: { fixture: "contacts/contact-addresses-unfiltered.json" } }),
    );
    expect(result.data.addresses.map((address) => address.id)).toEqual([3001, 3002]);
    expect(result.data.addressesComplete).toBe(true);
    // First page, then a full page-by-page read until an empty page.
    expect(client.callsTo("/ContactAddress").map((call) => call.query["offset"])).toEqual([
      0, 0, 3,
    ]);
  });

  it("reads all rows when sevDesk's total exceeds the first page, and does not call them complete", async () => {
    const { client, result } = await get(1001, routes({ addresses: manyAddresses(1500) }));
    expect(result.data.addresses).toHaveLength(1500);
    expect(result.data.addresses.at(-1)?.id).toBe(101_499);
    // Read in two pages: sevDesk can skip a row between pages (D-146).
    expect(result.data.addressesComplete).toBe(false);
    expect(client.methods().every((method) => method === "GET")).toBe(true);
  });

  it("says so instead of returning a silently short list when the cap is hit", async () => {
    const { result } = await get(1001, routes({ addresses: manyAddresses(10_001) }));
    expect(result.data.addresses).toHaveLength(10_000);
    expect(result.data.addressesComplete).toBe(false);
    expect(result.data.communicationWaysComplete).toBe(true);
    expect(result.summary).toBe(
      "Contact 1001 (organisation) with 10000 addresses, 3 communication ways and 2 custom " +
        "field values. Partial: sevDesk had more addresses than could be read.",
    );
  });

  it("propagates not_found without fetching addresses", async () => {
    const error = new SevdeskError({ kind: "not_found", message: "no contact", status: 400 });
    const client = new FakeSevdeskClient(withCountryRoute(routes({ contact: { error } })));
    await expect(tool.handler({ id: 1001 }, testContext(client))).rejects.toBe(error);
    expect(client.calls).toHaveLength(1);
  });

  it("treats an empty GET-by-id result as not_found", async () => {
    const client = new FakeSevdeskClient(
      withCountryRoute(routes({ contact: { fixture: "contacts/contact-empty.json" } })),
    );
    await expect(tool.handler({ id: 1001 }, testContext(client))).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("validates the id before any request", async () => {
    for (const id of [0, -1, 1.5]) {
      expect(tool.input.safeParse({ id }).success, `id ${id}`).toBe(false);
    }
    expect(tool.input.safeParse({ id: "1001" }).success).toBe(false);
    const client = new FakeSevdeskClient(withCountryRoute(routes()));
    await expect(getContactDetails(client, 0, { cacheOwner: client })).rejects.toMatchObject({
      kind: "validation",
    });
    expect(client.calls).toHaveLength(0);
  });
});
