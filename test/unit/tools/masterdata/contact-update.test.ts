import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { contactUpdateTool as tool } from "../../../../src/tools/contacts/update.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

const OK = { body: { objects: { id: "1", objectName: "Contact" } } };
const EMPTY = { body: { objects: [] } };
const COUNTRIES = {
  body: {
    objects: [
      { id: "1", code: "de", name: "Deutschland", nameEn: "Germany" },
      { id: "2", code: "at", name: "Österreich", nameEn: "Austria" },
    ],
  },
};

function filter(id: number) {
  return { "contact[id]": String(id), "contact[objectName]": "Contact" };
}

/** Routes for contact 1001 (organisation, billing + delivery address, e-mail/phone/web). */
function routes(overrides: Partial<Record<string, FakeRoute["response"]>> = {}): FakeRoute[] {
  const table: [string, FakeRoute][] = [
    ["contact", { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } }],
    [
      "addresses",
      {
        path: "/ContactAddress",
        query: filter(1001),
        response: { fixture: "contacts/contact-addresses-1001.json" },
      },
    ],
    [
      "ways",
      {
        path: "/CommunicationWay",
        query: filter(1001),
        response: { fixture: "contacts/communication-ways-1001.json" },
      },
    ],
    ["byNumber", { path: "/Contact", query: { customerNumber: "K-9999" }, response: EMPTY }],
    ["countries", { path: "/StaticCountry", response: COUNTRIES }],
    ["putContact", { method: "PUT", path: "/Contact/1001", response: OK }],
    ["putAddress", { method: "PUT", path: "/ContactAddress/3001", response: OK }],
    ["putEmail", { method: "PUT", path: "/CommunicationWay/4001", response: OK }],
    ["putPhone", { method: "PUT", path: "/CommunicationWay/4002", response: OK }],
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
  ];
  return table.map(([key, route]) => {
    const response = overrides[key];
    return response === undefined ? route : { ...route, response };
  });
}

/** Contact 1002 (a person) without addresses or communication ways. */
function personRoutes(): FakeRoute[] {
  return [
    { path: "/Contact/1002", response: { fixture: "contacts/contact-1002.json" } },
    { path: "/ContactAddress", query: filter(1002), response: EMPTY },
    { path: "/CommunicationWay", query: filter(1002), response: EMPTY },
    { path: "/StaticCountry", response: COUNTRIES },
    { method: "PUT", path: "/Contact/1002", response: OK },
    {
      method: "POST",
      path: "/ContactAddress",
      response: { fixture: "masterdata/contact-address-create-3101.json" },
    },
    {
      method: "POST",
      path: "/CommunicationWay",
      response: { fixture: "masterdata/communication-way-create-4101.json" },
    },
  ];
}

describe("sevdesk_contact_update", () => {
  it("is a write tool with update annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("changes only the given fields of contact, billing address and main entries", async () => {
    const client = new FakeSevdeskClient(routes());
    const args = {
      id: 1001,
      organisationName: "Musterfirma Holding GmbH",
      category: "supplier",
      vatNumber: "DE000000000",
      customerNumber: "K-9999",
      street: "Neue Straße 2",
      zip: "12345",
      country: "AT",
      email: "buchhaltung@example.com",
      phone: "+49 30 2222222",
    };
    const { plan, output } = await executeWrite(tool, args, client);

    expect(plan.preview).toEqual({
      action:
        "Update contact Musterfirma GmbH (id 1001): name, category, customer number, address, " +
        "e-mail, phone.",
      facts: [
        { label: "Contact", value: "Musterfirma GmbH (id 1001)" },
        { label: "Name", value: "Musterfirma GmbH → Musterfirma Holding GmbH" },
        { label: "Category", value: "Kunde (customer) → Lieferant (supplier)" },
        { label: "Customer number", value: "K-1001 → K-9999" },
        {
          label: "Address (id 3001)",
          value: "street Musterstraße 1 → Neue Straße 2; country id 1 → Österreich (id 2)",
        },
        { label: "E-mail (id 4001)", value: "rechnung@example.com → buchhaltung@example.com" },
        { label: "Phone (id 4002)", value: "+49 30 0000000 → +49 30 2222222" },
      ],
      warnings: [],
      irreversible: false,
    });
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      [
        "PUT",
        "/Contact/1001",
        "write",
        {
          name: "Musterfirma Holding GmbH",
          category: { id: 2, objectName: "Category" },
          customerNumber: "K-9999",
        },
      ],
      [
        "PUT",
        "/ContactAddress/3001",
        "write",
        { street: "Neue Straße 2", country: { id: 2, objectName: "StaticCountry" } },
      ],
      ["PUT", "/CommunicationWay/4001", "write", { value: "buchhaltung@example.com" }],
      ["PUT", "/CommunicationWay/4002", "write", { value: "+49 30 2222222" }],
    ]);
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1001" },
      { objectName: "ContactAddress", id: "3001" },
      { objectName: "CommunicationWay", id: "4001" },
      { objectName: "CommunicationWay", id: "4002" },
    ]);
    expect(output.data.contact.id).toBe(1001);
    expect(output.summary).toBe("Updated contact 1001: 4 records changed or added.");
  });

  it("sends no contact PUT when only a communication way changes", async () => {
    const client = new FakeSevdeskClient([
      { method: "PUT", path: "/CommunicationWay/4003", response: OK },
      ...routes(),
    ]);
    const { output } = await executeWrite(
      tool,
      { id: 1001, website: "https://neu.example.com" },
      client,
    );
    expect(client.writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", "/CommunicationWay/4003", { value: "https://neu.example.com" }],
    ]);
    expect(output.affected).toEqual([{ objectName: "CommunicationWay", id: "4003" }]);
    expect(output.summary).toBe("Updated contact 1001: 1 record changed or added.");
  });

  it("refuses an update that changes nothing", async () => {
    const client = new FakeSevdeskClient(routes());
    await expect(
      prepareWrite(
        tool,
        {
          id: 1001,
          organisationName: "Musterfirma GmbH",
          category: "customer",
          vatNumber: "DE 000000000",
          street: "Musterstraße 1",
          country: "DE",
          email: "RECHNUNG@example.com",
          phone: "+49 30 0000000",
        },
        client,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Nothing to change: contact 1001 already has these values.",
    });
  });

  it("never mixes the kinds of contacts", async () => {
    const organisation = new FakeSevdeskClient(routes());
    await expect(
      prepareWrite(tool, { id: 1001, lastName: "Muster" }, organisation),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("is an organisation") as string,
    });
    const person = new FakeSevdeskClient(personRoutes());
    await expect(
      prepareWrite(tool, { id: 1002, organisationName: "Firma" }, person),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("Contact 1002 is a person") as string,
    });
  });

  it("refuses a customer number used by another contact, accepts its own", async () => {
    const taken = new FakeSevdeskClient(
      routes({ byNumber: { body: { objects: [{ id: "1003", customerNumber: "K-9999" }] } } }),
    );
    await expect(
      prepareWrite(tool, { id: 1001, customerNumber: "K-9999" }, taken),
    ).rejects.toMatchObject({ message: "The customer number is already used by contact 1003." });

    const own = new FakeSevdeskClient([
      {
        path: "/Contact",
        query: { customerNumber: "K-1001" },
        response: { fixture: "contacts/contact-1001.json" },
      },
      ...routes(),
    ]);
    await expect(
      prepareWrite(tool, { id: 1001, customerNumber: "K-1001" }, own),
    ).rejects.toMatchObject({
      message: "Nothing to change: contact 1001 already has these values.",
    });
  });

  it("adds a billing address (default DE) and an e-mail to a person without them", async () => {
    const client = new FakeSevdeskClient(personRoutes());
    const { plan, output } = await executeWrite(
      tool,
      { id: 1002, firstName: "Moritz", city: "Berlin", zip: "10115", email: "moritz@example.com" },
      client,
    );
    expect(plan.preview.facts).toEqual([
      { label: "Contact", value: "Dr. Max Mustermann (id 1002)" },
      { label: "First name", value: "Max → Moritz" },
      { label: "New billing address (Rechnungsanschrift)", value: "10115 Berlin, Deutschland" },
      { label: "E-mail (new)", value: "moritz@example.com" },
    ]);
    expect(client.writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", "/Contact/1002", { surename: "Moritz" }],
      [
        "POST",
        "/ContactAddress",
        {
          zip: "10115",
          city: "Berlin",
          country: { id: 1, objectName: "StaticCountry" },
          category: { id: 47, objectName: "Category" },
          contact: { id: 1002, objectName: "Contact" },
        },
      ],
      [
        "POST",
        "/CommunicationWay",
        {
          type: "EMAIL",
          value: "moritz@example.com",
          key: { id: 2, objectName: "CommunicationWayKey" },
          main: true,
          contact: { id: 1002, objectName: "Contact" },
        },
      ],
    ]);
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1002" },
      { objectName: "ContactAddress", id: "3101" },
      { objectName: "CommunicationWay", id: "4101" },
    ]);
  });

  it("refuses a country alone for a contact without address", async () => {
    const client = new FakeSevdeskClient(personRoutes());
    await expect(prepareWrite(tool, { id: 1002, country: "AT" }, client)).rejects.toMatchObject({
      kind: "validation",
      message:
        "Contact 1002 has no address yet: a new one needs street, zip or city, not only a country.",
    });
  });

  it("updates the only address even when it is not a billing address", async () => {
    const client = new FakeSevdeskClient(
      routes({
        addresses: {
          body: {
            objects: [
              {
                id: "3002",
                contact: { id: "1001", objectName: "Contact" },
                city: "Alt",
                category: { id: "48", objectName: "Category" },
              },
            ],
          },
        },
      }),
    );
    const plan = await prepareWrite(tool, { id: 1001, city: "Neu" }, client);
    expect(plan.preview.facts).toContainEqual({
      label: "Address (id 3002)",
      value: "city Alt → Neu",
    });
  });

  it("adds a billing address when several other addresses exist, and warns about partial lists", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: String(5000 + index),
      contact: { id: "1001", objectName: "Contact" },
      city: "Lager",
      category: { id: "48", objectName: "Category" },
    }));
    const client = new FakeSevdeskClient(
      routes({ addresses: { body: { objects: rows, total: "20000" } } }),
    );
    const plan = await prepareWrite(tool, { id: 1001, street: "Hauptstraße 1" }, client);
    expect(plan.preview.facts).toContainEqual({
      label: "New billing address (Rechnungsanschrift)",
      value: "Hauptstraße 1, Deutschland",
    });
    expect(plan.preview.warnings).toEqual([
      "sevDesk had more addresses than could be read; the address chosen may not be the " +
        "billing address.",
    ]);
  });

  it("prefers the main communication way and warns when the list is partial", async () => {
    const rows = [
      ...Array.from({ length: 999 }, (_, index) => ({
        id: String(6000 + index),
        contact: { id: "1001", objectName: "Contact" },
        type: "EMAIL",
        value: `alt${index}@example.com`,
        main: "0",
      })),
      {
        id: "7000",
        contact: { id: "1001", objectName: "Contact" },
        type: "EMAIL",
        value: "main@example.com",
        main: "1",
      },
    ];
    const client = new FakeSevdeskClient([
      { method: "PUT", path: "/CommunicationWay/7000", response: OK },
      ...routes({ ways: { body: { objects: rows, total: "20000" } } }),
    ]);
    const plan = await prepareWrite(tool, { id: 1001, email: "neu@example.com" }, client);
    expect(plan.preview.facts).toContainEqual({
      label: "E-mail (id 7000)",
      value: "main@example.com → neu@example.com",
    });
    expect(plan.preview.warnings).toEqual([
      "sevDesk had more communication ways than could be read; the main entry may have been " +
        "missed.",
    ]);
  });

  it("refuses an unknown country code", async () => {
    const client = new FakeSevdeskClient(routes());
    await expect(prepareWrite(tool, { id: 1001, country: "ZZ" }, client)).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("does not know this country code") as string,
    });
  });

  it("surfaces a missing contact as not_found without writing", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Contact/4040", response: EMPTY },
      { path: "/ContactAddress", query: filter(4040), response: EMPTY },
      { path: "/CommunicationWay", query: filter(4040), response: EMPTY },
    ]);
    await expect(prepareWrite(tool, { id: 4040, taxNumber: "1" }, client)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(client.writes()).toEqual([]);
  });

  describe("partial failures", () => {
    it("passes the first failed write through unchanged", async () => {
      const rejected = new SevdeskError({ kind: "validation", status: 422, message: "x" });
      const client = new FakeSevdeskClient(routes({ putContact: { error: rejected } }));
      await expect(
        executeWrite(tool, { id: 1001, taxNumber: "111/111/11111", city: "Neu" }, client),
      ).rejects.toBe(rejected);
    });

    it("lists what was already changed when a later step fails", async () => {
      const client = new FakeSevdeskClient(
        routes({
          putAddress: { error: new SevdeskError({ kind: "server", status: 500, message: "x" }) },
        }),
      );
      await expect(
        executeWrite(
          tool,
          { id: 1001, taxNumber: "111/111/11111", city: "Neu", email: "x@example.com" },
          client,
        ),
      ).rejects.toMatchObject({
        kind: "server",
        completedWrites: [{ objectName: "Contact", id: "1001" }],
      });
      expect(client.writes().map((call) => call.path)).toEqual([
        "/Contact/1001",
        "/ContactAddress/3001",
      ]);
    });

    it("lists a created address when adding an e-mail fails", async () => {
      const client = new FakeSevdeskClient([
        {
          method: "POST",
          path: "/CommunicationWay",
          response: { error: new SevdeskError({ kind: "timeout", message: "x" }) },
        },
        ...personRoutes(),
      ]);
      await expect(
        executeWrite(tool, { id: 1002, city: "Berlin", email: "x@example.com" }, client),
      ).rejects.toMatchObject({
        kind: "timeout",
        completedWrites: [{ objectName: "ContactAddress", id: "3101" }],
      });
    });
  });
});
