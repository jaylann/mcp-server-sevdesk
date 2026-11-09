import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { contactCreateTool as tool } from "../../../../src/tools/contacts/create.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

const EMPTY = { body: { objects: [] } };
const readBackFilter = { "contact[id]": "1101", "contact[objectName]": "Contact" };

/** Routes for a successful create of contact 1101; `overrides` replace routes by key. */
function routes(overrides: Partial<Record<string, FakeRoute["response"]>> = {}): FakeRoute[] {
  const table: [string, FakeRoute][] = [
    ["byName", { path: "/Contact", query: { depth: "1" }, response: EMPTY }],
    [
      "byEmail",
      {
        path: "/CommunicationWay",
        query: { type: "EMAIL" },
        response: { fixture: "contacts/communication-ways-1001.json" },
      },
    ],
    [
      "nextNumber",
      {
        path: "/Contact/Factory/getNextCustomerNumber",
        response: { fixture: "contacts/next-customer-number.json" },
      },
    ],
    ["countries", { path: "/StaticCountry", response: { fixture: "meta/static-countries.json" } }],
    [
      "postContact",
      {
        method: "POST",
        path: "/Contact",
        response: { fixture: "masterdata/contact-create-1101.json" },
      },
    ],
    [
      "postAddress",
      {
        method: "POST",
        path: "/ContactAddress",
        response: { fixture: "masterdata/contact-address-create-3101.json" },
      },
    ],
    [
      "postWay",
      {
        method: "POST",
        path: "/CommunicationWay",
        response: { fixture: "masterdata/communication-way-create-4101.json" },
      },
    ],
    [
      "readContact",
      { path: "/Contact/1101", response: { fixture: "masterdata/contact-1101.json" } },
    ],
    [
      "readAddresses",
      {
        path: "/ContactAddress",
        query: readBackFilter,
        response: { fixture: "masterdata/contact-addresses-1101.json" },
      },
    ],
    [
      "readWays",
      {
        path: "/CommunicationWay",
        query: readBackFilter,
        response: { fixture: "masterdata/communication-ways-1101.json" },
      },
    ],
  ];
  return table.map(([key, route]) => {
    const response = overrides[key];
    return response === undefined ? route : { ...route, response };
  });
}

/** Routes where the name filter must be matched (customer number queries also hit /Contact). */
function withCustomerNumber(owner: FakeRoute["response"]): FakeRoute[] {
  return [{ path: "/Contact", query: { customerNumber: "K-2000" }, response: owner }, ...routes()];
}

const organisation = {
  organisationName: "Beispiel Handel GmbH",
  vatNumber: "de 000 000 001",
  street: "Beispielweg 5",
  zip: "10115",
  city: "Berlin",
  email: "buchhaltung@example.com",
};

describe("sevdesk_contact_create", () => {
  it("is a write tool with create annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("previews an organisation with address and e-mail", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, organisation, client);

    expect(plan.preview).toEqual({
      action:
        "Create the organisation contact Beispiel Handel GmbH (Kunde) with a billing address " +
        "and 1 communication way.",
      facts: [
        { label: "Name", value: "Beispiel Handel GmbH" },
        { label: "Type", value: "organisation" },
        { label: "Category", value: "Kunde (customer)" },
        {
          label: "Customer number",
          value: "K-1004 (next free number, assigned by sevDesk)",
        },
        { label: "VAT ID (USt-IdNr.)", value: "DE000000001" },
        {
          label: "Billing address (Rechnungsanschrift)",
          value: "Beispielweg 5, 10115 Berlin, Deutschland",
        },
        { label: "E-mail", value: "buchhaltung@example.com" },
      ],
      warnings: [
        "sevDesk assigns the customer number when the contact is saved; the number shown is " +
          "the next free one right now.",
      ],
      irreversible: false,
    });
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/Contact")[0]?.query).toMatchObject({
      depth: "1",
      name: "Beispiel Handel GmbH",
    });
  });

  it("creates the contact, its billing address and e-mail, then reads it back", async () => {
    const client = new FakeSevdeskClient(routes());
    const { output } = await executeWrite(tool, organisation, client);

    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      [
        "POST",
        "/Contact",
        "write",
        {
          name: "Beispiel Handel GmbH",
          category: { id: 3, objectName: "Category" },
          status: 1000,
          vatNumber: "DE000000001",
        },
      ],
      [
        "POST",
        "/ContactAddress",
        "write",
        {
          street: "Beispielweg 5",
          zip: "10115",
          city: "Berlin",
          country: { id: 1, objectName: "StaticCountry" },
          category: { id: 47, objectName: "Category" },
          contact: { id: 1101, objectName: "Contact" },
        },
      ],
      [
        "POST",
        "/CommunicationWay",
        "write",
        {
          type: "EMAIL",
          value: "buchhaltung@example.com",
          key: { id: 2, objectName: "CommunicationWayKey" },
          main: true,
          contact: { id: 1101, objectName: "Contact" },
        },
      ],
    ]);
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1101" },
      { objectName: "ContactAddress", id: "3101" },
      { objectName: "CommunicationWay", id: "4101" },
    ]);
    expect(output.data.contact).toMatchObject({
      id: 1101,
      kind: "organisation",
      displayName: "Beispiel Handel GmbH",
      customerNumber: "K-1004",
      vatNumber: "DE000000001",
    });
    expect(output.data.addresses.map((address) => address.id)).toEqual([3101]);
    expect(output.data.communicationWays.map((way) => way.value)).toEqual([
      "buchhaltung@example.com",
    ]);
    expect(output.summary).toBe(
      "Created contact 1101 (organisation) with 1 address and 1 communication way.",
    );
  });

  it("creates a person with the given customer number, category and all fields", async () => {
    const client = new FakeSevdeskClient([
      ...withCustomerNumber(EMPTY),
      {
        method: "POST",
        path: "/CommunicationWay",
        response: { fixture: "masterdata/communication-way-create-4101.json" },
      },
    ]);
    const args = {
      firstName: "Erika",
      lastName: "Beispiel",
      category: "supplier",
      customerNumber: "K-2000",
      taxNumber: "000/000/00001",
      buyerReference: "991-00000-00",
      phone: "+49 30 1111111",
      website: "https://beispiel.example.com",
    };
    const plan = await prepareWrite(tool, args, client);
    expect(plan.preview.action).toBe(
      "Create the person contact Erika Beispiel (Lieferant) with 2 communication ways.",
    );
    expect(plan.preview.facts).toContainEqual({ label: "Customer number", value: "K-2000" });
    expect(plan.preview.facts).toContainEqual({ label: "Category", value: "Lieferant (supplier)" });
    expect(plan.preview.warnings).toEqual([]);
    expect(client.callsTo("/Contact/Factory/getNextCustomerNumber")).toEqual([]);
    expect(client.callsTo("/StaticCountry")).toEqual([]);

    await executeWrite(tool, args, client);
    const bodies = client.writes().map((call) => call.body);
    expect(bodies[0]).toEqual({
      surename: "Erika",
      familyname: "Beispiel",
      category: { id: 2, objectName: "Category" },
      status: 1000,
      customerNumber: "K-2000",
      taxNumber: "000/000/00001",
      buyerReference: "991-00000-00",
    });
    expect(bodies.slice(1)).toEqual([
      {
        type: "PHONE",
        value: "+49 30 1111111",
        key: { id: 2, objectName: "CommunicationWayKey" },
        main: true,
        contact: { id: 1101, objectName: "Contact" },
      },
      {
        type: "WEB",
        value: "https://beispiel.example.com",
        key: { id: 2, objectName: "CommunicationWayKey" },
        main: true,
        contact: { id: 1101, objectName: "Contact" },
      },
    ]);
  });

  it("creates only the contact when no address or communication is given", async () => {
    const client = new FakeSevdeskClient(routes());
    const { output } = await executeWrite(tool, { organisationName: "Nur Name GmbH" }, client);
    expect(client.writes().map((call) => call.path)).toEqual(["/Contact"]);
    expect(client.callsTo("/CommunicationWay").filter((call) => call.query["type"])).toEqual([]);
    expect(output.affected).toEqual([{ objectName: "Contact", id: "1101" }]);
  });

  it("refuses an organisation with the same name, naming the existing contact", async () => {
    const client = new FakeSevdeskClient(
      routes({ byName: { fixture: "contacts/contacts-list.json" } }),
    );
    await expect(
      prepareWrite(tool, { organisationName: "  musterfirma   GMBH " }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "A contact with the same name already exists: contact 1001. Use the existing contact " +
        "(sevdesk_contact_get, sevdesk_contact_update), or call again with allowDuplicate: " +
        "true to create another one.",
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses a person with the same first and last name, not one with a different first name", async () => {
    const client = new FakeSevdeskClient(
      routes({ byName: { fixture: "contacts/contacts-list.json" } }),
    );
    await expect(
      prepareWrite(tool, { firstName: "Max", lastName: "Mustermann" }, client),
    ).rejects.toMatchObject({ message: expect.stringContaining("contact 1002") as string });
    await expect(
      prepareWrite(tool, { firstName: "Moritz", lastName: "Mustermann" }, client),
    ).resolves.toBeDefined();
    // The person search uses the last name.
    expect(client.callsTo("/Contact")[0]?.query).toMatchObject({ name: "Mustermann" });
  });

  it("refuses a contact whose e-mail address exists (case-insensitive)", async () => {
    const client = new FakeSevdeskClient(routes());
    await expect(
      prepareWrite(tool, { organisationName: "Neu GmbH", email: "Rechnung@Example.com" }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(
        "A contact with the same e-mail address already exists: contact 1001.",
      ) as string,
    });
  });

  it("lists both duplicate reasons and creates anyway with allowDuplicate", async () => {
    const client = new FakeSevdeskClient(
      routes({ byName: { fixture: "contacts/contacts-list.json" } }),
    );
    const args = {
      organisationName: "Musterfirma GmbH",
      email: "rechnung@example.com",
      allowDuplicate: true,
    };
    const { plan } = await executeWrite(tool, args, client);
    expect(plan.preview.warnings[0]).toBe(
      "Creating it anyway (allowDuplicate): A contact with the same name already exists: " +
        "contact 1001. A contact with the same e-mail address already exists: contact 1001.",
    );
    expect(client.writes().map((call) => call.path)).toEqual(["/Contact", "/CommunicationWay"]);
  });

  it("caps the list of duplicates and warns when the scan was truncated", async () => {
    const many = Array.from({ length: 501 }, (_, index) => ({
      id: String(5000 + index),
      name: "Gleich GmbH",
    }));
    const client = new FakeSevdeskClient(routes({ byName: { body: { objects: many } } }));
    await expect(
      prepareWrite(tool, { organisationName: "Gleich GmbH" }, client),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "contact 5000, contact 5001, contact 5002, contact 5003, contact 5004 and 495 more.",
      ) as string,
    });
    const plan = await prepareWrite(
      tool,
      { organisationName: "Gleich GmbH", allowDuplicate: true },
      client,
    );
    expect(plan.preview.warnings).toContain(
      "The duplicate check could not read every existing contact or e-mail address; a " +
        "duplicate may exist that was not found.",
    );
  });

  it("refuses a customer number that is taken", async () => {
    const client = new FakeSevdeskClient(
      withCustomerNumber({ fixture: "contacts/contact-1002.json" }),
    );
    await expect(
      prepareWrite(tool, { organisationName: "Neu GmbH", customerNumber: "K-2000" }, client),
    ).resolves.toBeDefined();

    const taken = new FakeSevdeskClient(
      withCustomerNumber({
        body: { objects: [{ id: "1007", name: "X", customerNumber: "K-2000" }] },
      }),
    );
    await expect(
      prepareWrite(tool, { organisationName: "Neu GmbH", customerNumber: "K-2000" }, taken),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "The customer number is already used by contact 1007. Use another number, or leave " +
        "customerNumber out so sevDesk assigns the next free one.",
    });
  });

  it("refuses ambiguous or missing names and incomplete or unknown addresses", async () => {
    const client = new FakeSevdeskClient(routes());
    await expect(
      prepareWrite(tool, { organisationName: "A GmbH", lastName: "B" }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("not both") as string,
    });
    await expect(prepareWrite(tool, { email: "a@example.com" }, client)).rejects.toMatchObject({
      message: "A contact needs organisationName (a company) or firstName/lastName (a person).",
    });
    await expect(
      prepareWrite(tool, { organisationName: "A GmbH", country: "at" }, client),
    ).rejects.toMatchObject({ message: expect.stringContaining("A country alone") as string });
    await expect(
      prepareWrite(tool, { organisationName: "A GmbH", city: "Wien", country: "XX" }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("does not know this country code") as string,
    });
    expect(client.writes()).toEqual([]);
  });

  it("validates and normalizes its arguments", () => {
    const parse = (args: Record<string, unknown>) => tool.input.safeParse(args);
    expect(parse({ organisationName: "A", vatNumber: "de 123 456 789" }).data?.vatNumber).toBe(
      "DE123456789",
    );
    expect(parse({ organisationName: "A", country: "de" }).data?.country).toBe("DE");
    expect(parse({ organisationName: "A" }).data).toMatchObject({
      category: "customer",
      allowDuplicate: false,
    });
    expect(parse({ organisationName: "A", vatNumber: "123" }).success).toBe(false);
    expect(parse({ organisationName: "A", email: "not-an-email" }).success).toBe(false);
    expect(parse({ organisationName: "A", phone: "call me" }).success).toBe(false);
    expect(parse({ organisationName: "A", website: "no website" }).success).toBe(false);
    expect(parse({ organisationName: "   " }).success).toBe(false);
    expect(parse({ organisationName: "A", category: "employee" }).success).toBe(false);
    expect(parse({ organisationName: "A", dryRun: true }).success).toBe(true);
    expect(parse({ organisationName: "A", status: 100 }).success).toBe(false);
  });

  describe("partial failures", () => {
    it("reports the contact as created when the address fails, and stops", async () => {
      const rejected = new SevdeskError({
        kind: "validation",
        status: 422,
        message: "sevDesk rejected the request.",
        upstreamMessage: "zip invalid",
      });
      const client = new FakeSevdeskClient(routes({ postAddress: { error: rejected } }));
      const error: unknown = await executeWrite(tool, organisation, client).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(SevdeskError);
      expect(error).toMatchObject({
        kind: "validation",
        status: 422,
        upstreamMessage: "zip invalid",
        completedWrites: [{ objectName: "Contact", id: "1101" }],
      });
      expect(client.writes().map((call) => call.path)).toEqual(["/Contact", "/ContactAddress"]);
    });

    it("lists contact and address when a communication way fails", async () => {
      const client = new FakeSevdeskClient(
        routes({
          postWay: { error: new SevdeskError({ kind: "server", status: 500, message: "x" }) },
        }),
      );
      await expect(executeWrite(tool, organisation, client)).rejects.toMatchObject({
        kind: "server",
        completedWrites: [
          { objectName: "Contact", id: "1101" },
          { objectName: "ContactAddress", id: "3101" },
        ],
      });
    });

    it("lists every record when only the read-back fails", async () => {
      const client = new FakeSevdeskClient(
        routes({ readContact: { error: new SevdeskError({ kind: "network", message: "x" }) } }),
      );
      await expect(executeWrite(tool, organisation, client)).rejects.toMatchObject({
        kind: "network",
        completedWrites: [
          { objectName: "Contact", id: "1101" },
          { objectName: "ContactAddress", id: "3101" },
          { objectName: "CommunicationWay", id: "4101" },
        ],
      });
    });

    it("wraps unexpected failures and cancellations with the created records", async () => {
      const unreadable = new FakeSevdeskClient(routes({ postAddress: { body: { objects: "?" } } }));
      await expect(executeWrite(tool, organisation, unreadable)).rejects.toMatchObject({
        kind: "unexpected_response",
        completedWrites: [{ objectName: "Contact", id: "1101" }],
      });

      const client = new FakeSevdeskClient(routes());
      const plan = await prepareWrite(tool, organisation, client);
      const failing = (error: Error) => ({
        request: (request: Parameters<FakeSevdeskClient["request"]>[0]) =>
          request.path === "/ContactAddress" ? Promise.reject(error) : client.request(request),
        list: client.list.bind(client),
        listAll: client.listAll.bind(client),
        download: client.download.bind(client),
      });
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      const context = (base: ReturnType<typeof failing>) => ({
        client: base,
        config: {} as never,
        signal: new AbortController().signal,
        progress: () => Promise.resolve(),
        files: {} as never,
      });
      await expect(
        tool.execute(tool.input.parse(organisation), plan, context(failing(abort))),
      ).rejects.toMatchObject({
        kind: "aborted",
        completedWrites: [{ objectName: "Contact", id: "1101" }],
      });
      await expect(
        tool.execute(tool.input.parse(organisation), plan, context(failing(new TypeError("bug")))),
      ).rejects.toMatchObject({
        kind: "unexpected_response",
        message: "The call failed part-way through for an unexpected reason.",
      });
    });

    it("passes a failed contact POST through unchanged (nothing was created)", async () => {
      const rejected = new SevdeskError({ kind: "validation", status: 422, message: "x" });
      const client = new FakeSevdeskClient(routes({ postContact: { error: rejected } }));
      await expect(executeWrite(tool, organisation, client)).rejects.toBe(rejected);
    });
  });
});
