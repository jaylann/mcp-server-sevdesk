/**
 * Custom field values (Zusatzfelder) through `sevdesk_contact_create` and
 * `sevdesk_contact_update`, against the behaviour recorded on 2026-11-16 (spec/deviations.md
 * D-086): a value is `POST /ContactCustomField` with the contact and the setting as references,
 * a change is `PUT` with only `objectName` and `value`, a removal is a `DELETE` answering
 * `{objects: [null]}`, and a contact's values are read with `contact[id]` and
 * `embed=contactCustomFieldSetting`. The settings (`/ContactCustomFieldSetting`) are only read.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../../../src/sevdesk/types.js";
import { contactCreateTool } from "../../../../src/tools/contacts/create.js";
import { contactUpdateTool } from "../../../../src/tools/contacts/update.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

const EMPTY: FakeRoute["response"] = { body: { objects: [] } };
const DELETED: FakeRoute["response"] = { body: { objects: [null] } };
const FIELD_OK: FakeRoute["response"] = {
  body: { objects: { id: "7001", objectName: "ContactCustomField" } },
};
const NOT_FOUND: FakeRoute["response"] = {
  error: new SevdeskError({ kind: "not_found", status: 404, message: "Not found." }),
};

function filter(id: number) {
  return { "contact[id]": String(id), "contact[objectName]": "Contact" };
}

function valuesRoute(id: number, response: FakeRoute["response"]): FakeRoute {
  return {
    path: "/ContactCustomField",
    query: { ...filter(id), embed: "contactCustomFieldSetting" },
    response,
  };
}

const SETTINGS: FakeRoute = {
  path: "/ContactCustomFieldSetting",
  response: { fixture: "contacts/custom-field-settings.json" },
};

/** A value row of contact `contact` for `setting`, in sevDesk's shape with the embed. */
function valueRow(id: number, contact: number, setting: number, name: string, value: string) {
  return {
    id: String(id),
    objectName: "ContactCustomField",
    contact: { id: String(contact), objectName: "Contact" },
    contactCustomFieldSetting: {
      id: String(setting),
      objectName: "ContactCustomFieldSetting",
      name,
    },
    value,
  };
}

/**
 * `base`, but each `POST /ContactCustomField` answers the next of `ids` (sevDesk answers the new
 * value as one object, D-086), so the completed writes can be told apart.
 */
function numberedPosts(base: FakeSevdeskClient, ids: readonly string[]): SevdeskClient {
  let next = 0;
  return {
    request: async (request) => {
      const answer = await base.request(request);
      if (request.method !== "POST" || request.path !== "/ContactCustomField") return answer;
      const id = ids[next] ?? "0";
      next += 1;
      return { id, objectName: "ContactCustomField" };
    },
    list: base.list.bind(base),
    listAll: base.listAll.bind(base),
    download: base.download.bind(base),
  };
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** A new organisation 1101 without address or communication ways. */
function createRoutes(extra: readonly FakeRoute[] = []): FakeRoute[] {
  return [
    ...extra,
    { path: "/Contact", query: { name: "Beispiel Handel GmbH" }, response: EMPTY },
    {
      path: "/Contact/Factory/getNextCustomerNumber",
      response: { fixture: "contacts/next-customer-number.json" },
    },
    SETTINGS,
    {
      method: "POST",
      path: "/Contact",
      response: { fixture: "masterdata/contact-create-1101.json" },
    },
    { method: "POST", path: "/ContactCustomField", response: FIELD_OK },
    { path: "/Contact/1101", response: { fixture: "masterdata/contact-1101.json" } },
    { path: "/ContactAddress", query: filter(1101), response: EMPTY },
    { path: "/CommunicationWay", query: filter(1101), response: EMPTY },
    valuesRoute(1101, {
      body: {
        objects: [
          valueRow(7101, 1101, 19498, "Kundennr extern", "EXT-4711"),
          valueRow(7102, 1101, 19499, "Branche", "Großhandel"),
        ],
      },
    }),
  ];
}

const create = {
  organisationName: "Beispiel Handel GmbH",
  customFields: [
    { name: "kundennr extern", value: "EXT-4711" },
    { settingId: 19499, value: "Großhandel" },
  ],
};

describe("sevdesk_contact_create with custom fields (D-086)", () => {
  it("sets each value after the contact, previews it and reads the values back", async () => {
    const fake = new FakeSevdeskClient(createRoutes());
    const { plan, output } = await executeWrite(
      contactCreateTool,
      create,
      numberedPosts(fake, ["7101", "7102"]),
    );

    expect(plan.preview.action).toBe(
      "Create the organisation contact Beispiel Handel GmbH (Kunde) with 2 custom field values.",
    );
    expect(plan.preview.facts.slice(-2)).toEqual([
      { label: "Custom field (setting 19498)", value: "Kundennr extern: EXT-4711" },
      { label: "Custom field (setting 19499)", value: "Branche: Großhandel" },
    ]);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["POST", "/Contact", "write"],
      ["POST", "/ContactCustomField", "write"],
      ["POST", "/ContactCustomField", "write"],
    ]);
    expect(fake.writes()[1]?.body).toEqual({
      objectName: "ContactCustomField",
      contact: { id: 1101, objectName: "Contact" },
      contactCustomFieldSetting: { id: 19498, objectName: "ContactCustomFieldSetting" },
      value: "EXT-4711",
    });
    expect(fake.writes()[2]?.body).toMatchObject({
      contactCustomFieldSetting: { id: 19499, objectName: "ContactCustomFieldSetting" },
      value: "Großhandel",
    });
    expect(output.data.customFields).toEqual([
      { id: 7101, settingId: 19498, name: "Kundennr extern", value: "EXT-4711" },
      { id: 7102, settingId: 19499, name: "Branche", value: "Großhandel" },
    ]);
    expect(output.data.customFieldsComplete).toBe(true);
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1101" },
      { objectName: "ContactCustomField", id: "7101" },
      { objectName: "ContactCustomField", id: "7102" },
    ]);
    expect(output.summary).toBe(
      "Created contact 1101 (organisation) with 0 addresses, 0 communication ways and 2 custom " +
        "field values.",
    );
  });

  it("reports a create whose values cannot be read back as done, and says so", async () => {
    // Every write went through; only the read afterwards fails. An error here would invite the
    // model to create the contact again.
    const down = new SevdeskError({ kind: "server", status: 503, message: "Down." });
    const fake = new FakeSevdeskClient(createRoutes([valuesRoute(1101, { error: down })]));
    const { output } = await executeWrite(
      contactCreateTool,
      create,
      numberedPosts(fake, ["7101", "7102"]),
    );
    expect(output.data).not.toHaveProperty("customFields");
    expect(output.data.customFieldsComplete).toBe(false);
    expect(output.affected).toHaveLength(3);
    expect(output.summary).toBe(
      "Created contact 1101 (organisation) with 0 addresses and 0 communication ways. Its " +
        "custom field values could not be read back after the write; sevdesk_contact_get shows " +
        "them.",
    );
  });

  it("reads no custom field data when none is given", async () => {
    const fake = new FakeSevdeskClient(createRoutes());
    const { output } = await executeWrite(
      contactCreateTool,
      { organisationName: "Beispiel Handel GmbH" },
      fake,
    );
    expect(fake.calls.filter((call) => call.path.startsWith("/ContactCustomField"))).toEqual([]);
    expect(output.data).not.toHaveProperty("customFields");
    expect(output.summary).toBe(
      "Created contact 1101 (organisation) with 0 addresses and 0 communication ways.",
    );
  });

  it.each([
    [[{ name: "Unbekannt", value: "x" }], "customFields entry 1: no custom field of this account"],
    [[{ name: "Projekt", value: "x" }], "2 custom fields have that name (settings 19500, 19501)"],
    [[{ settingId: 42, value: "x" }], "custom field 42 is not one of this account's custom fields"],
    [[{ settingId: 19498, name: "Branche", value: "x" }], "either by settingId or by name"],
    [[{ value: "x" }], "either by settingId or by name"],
    [
      [
        { settingId: 19498, value: "a" },
        { name: "Kundennr Extern", value: "b" },
      ],
      "customFields entry 2: custom field 19498 is listed twice",
    ],
  ])("refuses %o before anything is written", async (customFields, message) => {
    const fake = new FakeSevdeskClient(createRoutes());
    await expect(
      prepareWrite(
        contactCreateTool,
        { organisationName: "Beispiel Handel GmbH", customFields },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(message) as string,
    });
    expect(fake.writes()).toEqual([]);
  });

  it("names the contact and the values already set when a later value fails", async () => {
    const error = new SevdeskError({ kind: "validation", status: 400, message: "Refused." });
    let posts = 0;
    const fake = new FakeSevdeskClient(createRoutes());
    const client: SevdeskClient = {
      ...numberedPosts(fake, ["7101"]),
      request: async (request) => {
        if (request.method === "POST" && request.path === "/ContactCustomField") {
          posts += 1;
          if (posts === 2) throw error;
        }
        return numberedPosts(fake, ["7101"]).request(request);
      },
    };
    await expect(executeWrite(contactCreateTool, create, client)).rejects.toMatchObject({
      kind: "validation",
      completedWrites: [
        { objectName: "Contact", id: "1101" },
        { objectName: "ContactCustomField", id: "7101" },
      ],
    });
  });

  it("checks the argument's shape", () => {
    const parse = (customFields: unknown) =>
      contactCreateTool.input.safeParse({ organisationName: "X", customFields }).success;
    expect(parse([])).toBe(false);
    expect(parse([{ settingId: 1, value: "  " }])).toBe(false);
    // sevDesk's limit: 100 characters (400 "Property 'value' is too long", recorded 2026-11-17).
    expect(parse([{ settingId: 1, value: "x".repeat(101) }])).toBe(false);
    expect(parse([{ name: "x".repeat(31), value: "x" }])).toBe(false);
    expect(parse([{ settingId: 1, value: "x", identifier: "y" }])).toBe(false);
    expect(
      parse(Array.from({ length: 21 }, (_, index) => ({ settingId: index + 1, value: "x" }))),
    ).toBe(false);
    expect(parse([{ name: "x".repeat(30), value: "x".repeat(100) }])).toBe(true);
  });

  it("refuses a value over 100 characters before any request, also past the schema", async () => {
    const fake = new FakeSevdeskClient(createRoutes());
    const plan = contactCreateTool.prepare(
      {
        ...contactCreateTool.input.parse({ organisationName: "Beispiel Handel GmbH" }),
        customFields: [{ settingId: 19498, value: "x".repeat(101) }],
      },
      testContext(fake),
    );
    await expect(plan).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(
        "the value has 101 characters; sevDesk takes at most 100",
      ) as string,
    });
    expect(fake.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

/** Contact 1001 with its addresses, communication ways and two values (7001, 7002). */
function updateRoutes(
  values: FakeRoute["response"] = { fixture: "contacts/custom-fields-1001.json" },
  extra: readonly FakeRoute[] = [],
): FakeRoute[] {
  return withCountryRoute([
    ...extra,
    { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
    {
      path: "/ContactAddress",
      query: filter(1001),
      response: { fixture: "contacts/contact-addresses-1001.json" },
    },
    {
      path: "/CommunicationWay",
      query: filter(1001),
      response: { fixture: "contacts/communication-ways-1001.json" },
    },
    valuesRoute(1001, values),
    SETTINGS,
    { method: "PUT", path: "/ContactCustomField/7001", response: FIELD_OK },
    { method: "POST", path: "/ContactCustomField", response: FIELD_OK },
    { method: "DELETE", path: "/ContactCustomField/7001", response: DELETED },
    { method: "DELETE", path: "/ContactCustomField/7002", response: DELETED },
    { method: "DELETE", path: "/ContactAddress/3002", response: DELETED },
    { method: "PUT", path: "/CommunicationWay/4002", response: FIELD_OK },
  ]);
}

describe("sevdesk_contact_update with custom fields (D-086)", () => {
  it("changes a value, adds one and removes one last, after the other changes", async () => {
    const fake = new FakeSevdeskClient(updateRoutes());
    const { plan, output } = await executeWrite(
      contactUpdateTool,
      {
        id: 1001,
        phone: "+49 30 7777777",
        customFields: [
          { name: "Kundennr extern", value: "EXT-4712" },
          { settingId: 19500, value: "Umbau Lager" },
        ],
        remove: [
          { kind: "customField", id: 7002 },
          { kind: "address", id: 3002 },
        ],
      },
      numberedPosts(fake, ["7003"]),
    );

    expect(plan.preview.action).toBe(
      "Update contact Musterfirma GmbH (id 1001): phone, custom field 19498, custom field 19500, " +
        "remove address 3002, remove custom field value 7002.",
    );
    expect(plan.preview.facts).toEqual(
      expect.arrayContaining([
        {
          label: "Custom field (setting 19498), value id 7001",
          value: "Kundennr extern: EXT-4711 → EXT-4712",
        },
        { label: "Custom field (setting 19500) (new)", value: "Projekt: Umbau Lager" },
        { label: "Remove custom field value (id 7002)", value: "Branche: Großhandel" },
      ]),
    );
    // Communication ways, then the values, then the deletes: addresses and ways first.
    expect(fake.writes().map((call) => [call.method, call.path])).toEqual([
      ["PUT", "/CommunicationWay/4002"],
      ["PUT", "/ContactCustomField/7001"],
      ["POST", "/ContactCustomField"],
      ["DELETE", "/ContactAddress/3002"],
      ["DELETE", "/ContactCustomField/7002"],
    ]);
    // D-086: a PUT with only objectName and value keeps the contact and the setting.
    expect(fake.writes()[1]?.body).toEqual({ objectName: "ContactCustomField", value: "EXT-4712" });
    expect(fake.writes()[2]?.body).toEqual({
      objectName: "ContactCustomField",
      contact: { id: 1001, objectName: "Contact" },
      contactCustomFieldSetting: { id: 19500, objectName: "ContactCustomFieldSetting" },
      value: "Umbau Lager",
    });
    expect(output.data.removed).toContainEqual({
      kind: "customField",
      id: 7002,
      customField: { id: 7002, settingId: 19499, name: "Branche", value: "Großhandel" },
    });
    expect(output.data.customFields).toBeDefined();
    expect(output.affected).toEqual([
      { objectName: "CommunicationWay", id: "4002" },
      { objectName: "ContactCustomField", id: "7001" },
      { objectName: "ContactCustomField", id: "7003" },
      { objectName: "ContactAddress", id: "3002" },
      { objectName: "ContactCustomField", id: "7002" },
    ]);
    expect(output.summary).toMatch(/^Updated contact 1001: 3 records changed or added, 2 removed/);
  });

  it("refuses to set a field whose value the same update removes (one value per field)", async () => {
    // D-086 (recorded 2026-11-17): a second POST for the same contact and setting is refused, so
    // adding the new value before deleting the old one would fail half-way.
    const fake = new FakeSevdeskClient(updateRoutes());
    await expect(
      prepareWrite(
        contactUpdateTool,
        {
          id: 1001,
          customFields: [{ settingId: 19498, value: "EXT-9" }],
          remove: [{ kind: "customField", id: 7001 }],
        },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(
        "remove also lists value 7001 of custom field 19498",
      ) as string,
    });
    expect(fake.writes()).toEqual([]);
  });

  it("refuses an update whose values are already there", async () => {
    const fake = new FakeSevdeskClient(updateRoutes());
    await expect(
      prepareWrite(
        contactUpdateTool,
        { id: 1001, customFields: [{ settingId: 19498, value: "EXT-4711" }] },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("Nothing to change") as string,
    });
  });

  it("counts a value sevDesk no longer has as already gone", async () => {
    const fake = new FakeSevdeskClient(
      updateRoutes(undefined, [
        { method: "DELETE", path: "/ContactCustomField/7002", response: NOT_FOUND },
      ]),
    );
    const { output } = await executeWrite(
      contactUpdateTool,
      { id: 1001, remove: [{ kind: "customField", id: 7002 }] },
      fake,
    );
    expect(output.data.removed).toEqual([
      expect.objectContaining({ kind: "customField", id: 7002, alreadyGone: true }),
    ]);
    // What is left includes the custom field values read back (here the fake's unchanged two).
    expect(output.summary).toBe(
      "Updated contact 1001: 0 records changed or added, 1 removed (see removed). It has 2 " +
        "addresses, 3 communication ways and 2 custom field values left.",
    );
  });

  it("changes a stored value that differs only by spaces or invisible characters", async () => {
    // The display copy is cleaned ("EXT-4711"), the stored text is not: comparing against the
    // display copy skipped the change and refused the update as "Nothing to change".
    const fake = new FakeSevdeskClient(
      updateRoutes({
        body: { objects: [valueRow(7001, 1001, 19498, "Kundennr extern", "EXT-4711​ ")] },
      }),
    );
    const { plan } = await executeWrite(
      contactUpdateTool,
      { id: 1001, customFields: [{ settingId: 19498, value: "EXT-4711" }] },
      fake,
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Custom field (setting 19498), value id 7001",
      value:
        "Kundennr extern: EXT-4711 (stored with extra spaces or invisible characters) → EXT-4711",
    });
    expect(fake.writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", "/ContactCustomField/7001", { objectName: "ContactCustomField", value: "EXT-4711" }],
    ]);
  });

  it("reports an update whose values cannot be read back as done, and says so", async () => {
    const down = new SevdeskError({ kind: "server", status: 503, message: "Down." });
    // The values are read twice: for the plan, then back after the writes. Only the second fails.
    let reads = 0;
    const fake = new FakeSevdeskClient(updateRoutes());
    const failing = new FakeSevdeskClient(updateRoutes({ error: down }));
    const client: SevdeskClient = {
      request: fake.request.bind(fake),
      list: async (path, query, options) => {
        if (path !== "/ContactCustomField") return fake.list(path, query, options);
        reads += 1;
        return reads === 1 ? fake.list(path, query, options) : failing.list(path, query, options);
      },
      listAll: fake.listAll.bind(fake),
      download: fake.download.bind(fake),
    };
    const { output } = await executeWrite(
      contactUpdateTool,
      {
        id: 1001,
        customFields: [{ settingId: 19498, value: "EXT-4712" }],
        remove: [{ kind: "customField", id: 7002 }],
      },
      client,
    );
    expect(reads).toBe(2);
    expect(output.data).not.toHaveProperty("customFields");
    expect(output.data.customFieldsComplete).toBe(false);
    expect(output.affected).toEqual([
      { objectName: "ContactCustomField", id: "7001" },
      { objectName: "ContactCustomField", id: "7002" },
    ]);
    expect(output.summary).toBe(
      "Updated contact 1001: 1 record changed or added, 1 removed (see removed). It has 2 " +
        "addresses and 3 communication ways left. Its custom field values could not be read " +
        "back after the write; sevdesk_contact_get shows them.",
    );
  });

  it.each([
    [
      { remove: [{ kind: "customField", id: 9999 }] },
      "Custom field value 9999 is not one of contact 1001's custom field values; nothing was changed",
    ],
    [
      {
        remove: [
          { kind: "customField", id: 7001 },
          { kind: "customField", id: 7001 },
        ],
      },
      "remove lists custom field value 7001 twice",
    ],
    [
      { customFields: [{ name: "Unbekannt", value: "x" }] },
      "no custom field of this account has that name",
    ],
  ])("refuses %o before anything is written", async (extra, message) => {
    const fake = new FakeSevdeskClient(updateRoutes());
    await expect(
      prepareWrite(contactUpdateTool, { id: 1001, ...extra }, fake),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(message) as string,
    });
    expect(fake.writes()).toEqual([]);
  });

  it("refuses to guess which of two values of one field to change", async () => {
    const fake = new FakeSevdeskClient(
      updateRoutes({
        body: {
          objects: [
            valueRow(7001, 1001, 19498, "Kundennr extern", "A"),
            valueRow(7005, 1001, 19498, "Kundennr extern", "B"),
          ],
        },
      }),
    );
    await expect(
      prepareWrite(
        contactUpdateTool,
        { id: 1001, customFields: [{ settingId: 19498, value: "C" }] },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(
        "has 2 values of custom field 19498 (ids 7001, 7005)",
      ) as string,
    });
  });

  it("refuses to add a value when not every value of the contact could be read", async () => {
    const objects = Array.from({ length: 10_001 }, (_, index) =>
      valueRow(100_000 + index, 1001, 19499, "Branche", `V-${index}`),
    );
    const fake = new FakeSevdeskClient(updateRoutes({ body: { objects } }));
    await expect(
      prepareWrite(
        contactUpdateTool,
        { id: 1001, customFields: [{ settingId: 19500, value: "x" }] },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("more custom field values than could be read") as string,
    });
  });

  it("reads no custom field data for an update without custom fields", async () => {
    const fake = new FakeSevdeskClient(updateRoutes());
    const { output } = await executeWrite(
      contactUpdateTool,
      { id: 1001, phone: "+49 30 7777777" },
      fake,
    );
    expect(fake.calls.filter((call) => call.path.startsWith("/ContactCustomField"))).toEqual([]);
    expect(output.data).not.toHaveProperty("customFields");
  });

  it("names what was already changed when a later custom field write fails", async () => {
    const error = new SevdeskError({ kind: "server", status: 500, message: "Down." });
    const fake = new FakeSevdeskClient(
      updateRoutes(undefined, [
        { method: "DELETE", path: "/ContactCustomField/7002", response: { error } },
      ]),
    );
    await expect(
      executeWrite(
        contactUpdateTool,
        {
          id: 1001,
          customFields: [{ settingId: 19498, value: "EXT-4712" }],
          remove: [{ kind: "customField", id: 7002 }],
        },
        fake,
      ),
    ).rejects.toMatchObject({
      kind: "server",
      completedWrites: [{ objectName: "ContactCustomField", id: "7001" }],
    });
    // Never retried.
    expect(fake.writes().filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("describes customField in remove and takes no setting arguments", () => {
    const parse = (args: unknown) => contactUpdateTool.input.safeParse(args).success;
    expect(parse({ id: 1001, remove: [{ kind: "customField", id: 7001 }] })).toBe(true);
    expect(parse({ id: 1001, customFieldSettings: [{ name: "x" }] })).toBe(false);
  });
});
