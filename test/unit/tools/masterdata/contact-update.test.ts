import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { contactUpdateTool as tool } from "../../../../src/tools/contacts/update.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { StagedClient } from "../lifecycle/helpers.js";
import { patched } from "./support.js";

const OK = { body: { objects: { id: "1", objectName: "Contact" } } };
const EMPTY = { body: { objects: [] } };
/** sevDesk's answer to a DELETE (recorded 2026-11-16, D-084). */
const DELETED = { body: { objects: [null] } };
const NOT_FOUND = {
  error: new SevdeskError({ kind: "not_found", status: 404, message: "Not found." }),
};
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

  describe("the organisation a person belongs to (parent, D-083)", () => {
    /** Organisation 1003, a second company. */
    const ORGANISATION_1003: FakeRoute = {
      path: "/Contact/1003",
      response: patched("contacts/contact-1001.json", { id: "1003", name: "Beispiel AG" }),
    };
    const ORGANISATION_1001: FakeRoute = {
      path: "/Contact/1001",
      response: { fixture: "contacts/contact-1001.json" },
    };
    /** Person 1004, whom sevDesk would accept as a parent although it is no organisation. */
    const PERSON_1004: FakeRoute = {
      path: "/Contact/1004",
      response: patched("contacts/contact-1002.json", { id: "1004" }),
    };

    it("moves a person to another organisation and names both", async () => {
      const client = new FakeSevdeskClient([
        ...personRoutes(),
        ORGANISATION_1001,
        ORGANISATION_1003,
      ]);
      const { plan, output } = await executeWrite(
        tool,
        { id: 1002, parentOrganisationId: 1003 },
        client,
      );
      expect(plan.preview).toEqual({
        action: "Update contact Dr. Max Mustermann (id 1002): organisation link.",
        facts: [
          { label: "Contact", value: "Dr. Max Mustermann (id 1002)" },
          {
            label: "Contact person of",
            value: "Musterfirma GmbH (contact 1001) → Beispiel AG (contact 1003)",
          },
        ],
        warnings: [],
        irreversible: false,
      });
      expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual(
        [["PUT", "/Contact/1002", "write", { parent: { id: 1003, objectName: "Contact" } }]],
      );
      expect(output.data.removed).toBeUndefined();
      expect(output.summary).toBe("Updated contact 1002: 1 record changed or added.");
    });

    it("links a person that belongs to no organisation yet", async () => {
      const client = new FakeSevdeskClient([
        {
          path: "/Contact/1002",
          response: patched("contacts/contact-1002.json", { parent: null }),
        },
        ...personRoutes(),
        ORGANISATION_1001,
      ]);
      const plan = await prepareWrite(tool, { id: 1002, parentOrganisationId: 1001 }, client);
      expect(plan.preview.facts[1]).toEqual({
        label: "Contact person of",
        value: "(none) → Musterfirma GmbH (contact 1001)",
      });
    });

    it("removes the link with parent null and lists it as removed", async () => {
      const client = new FakeSevdeskClient([...personRoutes(), ORGANISATION_1001]);
      const { plan, output } = await executeWrite(
        tool,
        { id: 1002, remove: [{ kind: "parentOrganisation", id: 1001 }] },
        client,
      );
      expect(plan.preview.facts[1]).toEqual({
        label: "Contact person of",
        value: "Musterfirma GmbH (contact 1001) → (none)",
      });
      expect(client.writes().map((call) => [call.method, call.path, call.body])).toEqual([
        ["PUT", "/Contact/1002", { parent: null }],
      ]);
      expect(output.data.removed).toEqual([{ kind: "parentOrganisation", id: 1001 }]);
      expect(output.affected).toEqual([{ objectName: "Contact", id: "1002" }]);
      expect(output.summary).toBe(
        "Updated contact 1002: 1 record changed or added, 1 removed (see removed). It has 0 " +
          "addresses and 0 communication ways left.",
      );
    });

    it("names a link to a contact that no longer exists by its id", async () => {
      const client = new FakeSevdeskClient([
        { path: "/Contact/1001", response: EMPTY },
        ...personRoutes(),
      ]);
      const plan = await prepareWrite(
        tool,
        { id: 1002, remove: [{ kind: "parentOrganisation", id: 1001 }] },
        client,
      );
      expect(plan.preview.facts[1]?.value).toBe("contact 1001 (no longer in sevDesk) → (none)");
    });

    it("changes nothing when the person belongs to that organisation already", async () => {
      const client = new FakeSevdeskClient([...personRoutes(), ORGANISATION_1001]);
      await expect(
        prepareWrite(tool, { id: 1002, parentOrganisationId: 1001 }, client),
      ).rejects.toMatchObject({
        kind: "validation",
        message: "Nothing to change: contact 1002 already has these values.",
      });
    });

    it.each([
      [
        "a person as organisation",
        { id: 1002, parentOrganisationId: 1004 },
        "Contact 1004 is a person, not an organisation: a person can only belong to an " +
          "organisation (as its contact person, Ansprechpartner). Use the organisation's contact " +
          "id as parentOrganisationId.",
      ],
      [
        "a contact that does not exist",
        { id: 1002, parentOrganisationId: 4040 },
        "Contact 4040 does not exist in sevDesk. parentOrganisationId must be the id of an " +
          "organisation contact; find it with sevdesk_contacts_search.",
      ],
      [
        "the contact itself",
        { id: 1002, parentOrganisationId: 1002 },
        "Contact 1002 cannot belong to itself: parentOrganisationId must be another contact.",
      ],
      [
        "an organisation for an organisation",
        { id: 1001, parentOrganisationId: 1003 },
        "Contact 1001 is an organisation: only persons belong to an organisation " +
          "(parentOrganisationId). Leave it out.",
      ],
      [
        "removing a link the person does not have",
        { id: 1002, remove: [{ kind: "parentOrganisation", id: 1003 }] },
        "Contact 1002 belongs to organisation 1001, not 1003; nothing was changed. Name the " +
          "current organisation to remove the link.",
      ],
      [
        "removing a link from a contact without one",
        { id: 1001, remove: [{ kind: "parentOrganisation", id: 1003 }] },
        "Contact 1001 belongs to no organisation: there is no link to remove; nothing was changed.",
      ],
      [
        "a new organisation and removing the link at once",
        {
          id: 1002,
          parentOrganisationId: 1003,
          remove: [{ kind: "parentOrganisation", id: 1001 }],
        },
        "Give either parentOrganisationId (link to an organisation) or remove kind " +
          "parentOrganisation (remove the link), not both.",
      ],
    ])("refuses %s (sevDesk would store it)", async (_label, args, message) => {
      const client = new FakeSevdeskClient([
        ...routes(),
        ...personRoutes(),
        ORGANISATION_1001,
        ORGANISATION_1003,
        PERSON_1004,
        { path: "/Contact/4040", response: EMPTY },
      ]);
      await expect(prepareWrite(tool, args, client)).rejects.toMatchObject({
        kind: "validation",
        message,
      });
      expect(client.writes()).toEqual([]);
    });

    it("keeps 0 and other non-ids out instead of reading them as 'no organisation'", () => {
      for (const parentOrganisationId of [0, -1, 1.5]) {
        expect(tool.input.safeParse({ id: 1002, parentOrganisationId }).success).toBe(false);
      }
    });

    it("locks the new organisation as well, so it cannot be deleted in between", () => {
      expect(tool.locks?.({ id: 1002, parentOrganisationId: 1003, dryRun: false })).toEqual([
        { objectName: "Contact", id: "1002" },
        { objectName: "Contact", id: "1003" },
      ]);
    });
  });

  describe("remove: addresses and communication ways (D-084)", () => {
    /** Contact 1001 after the removals: address 3001, phone 4002 and website 4003 are left. */
    function remaining(): FakeRoute[] {
      return [
        { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
        {
          path: "/ContactAddress",
          query: filter(1001),
          response: {
            body: { objects: [{ id: "3001", contact: { id: "1001", objectName: "Contact" } }] },
          },
        },
        {
          path: "/CommunicationWay",
          query: filter(1001),
          response: {
            body: {
              objects: ["4002", "4003"].map((id) => ({
                id,
                contact: { id: "1001", objectName: "Contact" },
                type: id === "4002" ? "PHONE" : "WEB",
                value: "x",
              })),
            },
          },
        },
      ];
    }

    it("removes an address and the main e-mail last and says what is left", async () => {
      const client = new StagedClient(routes(), [
        { method: "PUT", path: "/CommunicationWay/4002", response: OK },
        { method: "DELETE", path: "/ContactAddress/3002", response: DELETED },
        { method: "DELETE", path: "/CommunicationWay/4001", response: DELETED },
        ...remaining(),
      ]);
      const { plan, output } = await executeWrite(
        tool,
        {
          id: 1001,
          phone: "+49 30 2222222",
          remove: [
            { kind: "address", id: 3002 },
            { kind: "email", id: 4001 },
          ],
        },
        client,
      );

      expect(plan.preview).toEqual({
        action:
          "Update contact Musterfirma GmbH (id 1001): phone, remove address 3002, remove e-mail " +
          "4001.",
        facts: [
          { label: "Contact", value: "Musterfirma GmbH (id 1001)" },
          { label: "Phone (id 4002)", value: "+49 30 0000000 → +49 30 2222222" },
          {
            label: "Remove address (id 3002)",
            value: "Lagerweg 5, 12345 Musterstadt, DE (Lieferanschrift)",
          },
          { label: "Remove e-mail (id 4001)", value: "rechnung@example.com (main entry)" },
          { label: "Left afterwards", value: "1 address, 2 communication ways" },
        ],
        warnings: [
          "E-mail 4001 is the main e-mail address; sevDesk makes no other entry the main one, so " +
            "the contact has no main entry of this type afterwards.",
        ],
        irreversible: false,
      });
      expect(client.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
        ["PUT", "/CommunicationWay/4002", "write"],
        ["DELETE", "/ContactAddress/3002", "write"],
        ["DELETE", "/CommunicationWay/4001", "write"],
      ]);
      expect(output.data.removed).toEqual([
        {
          kind: "address",
          id: 3002,
          address: expect.objectContaining({ id: 3002, street: "Lagerweg 5" }) as unknown,
        },
        {
          kind: "email",
          id: 4001,
          communicationWay: expect.objectContaining({
            id: 4001,
            value: "rechnung@example.com",
            main: true,
          }) as unknown,
        },
      ]);
      expect(output.affected).toEqual([
        { objectName: "CommunicationWay", id: "4002" },
        { objectName: "ContactAddress", id: "3002" },
        { objectName: "CommunicationWay", id: "4001" },
      ]);
      expect(output.summary).toBe(
        "Updated contact 1001: 1 record changed or added, 2 removed (see removed). It has 1 " +
          "address and 2 communication ways left.",
      );
    });

    it("warns when the billing address goes and nothing replaces it", async () => {
      const client = new FakeSevdeskClient([
        { method: "DELETE", path: "/ContactAddress/3001", response: DELETED },
        ...routes(),
      ]);
      const plan = await prepareWrite(
        tool,
        { id: 1001, remove: [{ kind: "address", id: 3001 }] },
        client,
      );
      expect(plan.preview.warnings).toEqual([
        "Address 3001 is the billing address (Rechnungsanschrift); sevDesk makes no other " +
          "address the billing address, so the contact has none afterwards.",
      ]);
    });

    it("adds a new billing address when the billing address goes, and leaves the delivery address alone", async () => {
      const client = new FakeSevdeskClient([
        { method: "DELETE", path: "/ContactAddress/3001", response: DELETED },
        ...routes(),
        { method: "PUT", path: "/ContactAddress/3002", response: OK },
      ]);
      const { plan } = await executeWrite(
        tool,
        { id: 1001, city: "Neustadt", remove: [{ kind: "address", id: 3001 }] },
        client,
      );
      expect(plan.preview.facts).toContainEqual({
        label: "New billing address (Rechnungsanschrift)",
        value: "Neustadt, Deutschland",
      });
      expect(plan.preview.facts).not.toContainEqual(
        expect.objectContaining({ label: "Address (id 3002)" }),
      );
      expect(plan.preview.facts).toContainEqual({
        label: "Left afterwards",
        value: "2 addresses, 3 communication ways",
      });
      expect(plan.preview.warnings).toEqual([]);
      const writes = client.writes();
      expect(writes.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/ContactAddress"],
        ["DELETE", "/ContactAddress/3001"],
      ]);
      expect(writes[0]?.body).toMatchObject({
        city: "Neustadt",
        country: { id: 1, objectName: "StaticCountry" },
        category: { id: 47, objectName: "Category" },
        contact: { id: 1001, objectName: "Contact" },
      });
    });

    it("refuses a country alone when the billing address it would change goes", async () => {
      const client = new FakeSevdeskClient(routes());
      await expect(
        prepareWrite(
          tool,
          { id: 1001, country: "AT", remove: [{ kind: "address", id: 3001 }] },
          client,
        ),
      ).rejects.toMatchObject({
        kind: "validation",
        message:
          "Address 3001, the one this update would change, is removed: a new billing address " +
          "needs street, zip or city, not only a country.",
      });
      expect(client.writes()).toEqual([]);
    });

    it("adds a new main e-mail when the main one goes, and leaves the other e-mail alone", async () => {
      const ways = {
        body: {
          objects: [
            { id: "4001", type: "EMAIL", value: "info@example.com", main: "1" },
            { id: "4004", type: "EMAIL", value: "billing@example.com", main: "0" },
          ].map((row) => ({ ...row, contact: { id: "1001", objectName: "Contact" } })),
        },
      };
      const client = new FakeSevdeskClient([
        { method: "DELETE", path: "/CommunicationWay/4001", response: DELETED },
        { method: "PUT", path: "/CommunicationWay/4004", response: OK },
        ...routes({ ways }),
      ]);
      const { plan } = await executeWrite(
        tool,
        { id: 1001, email: "new@example.com", remove: [{ kind: "email", id: 4001 }] },
        client,
      );
      expect(plan.preview.facts).toContainEqual({
        label: "E-mail (new)",
        value: "new@example.com",
      });
      expect(plan.preview.facts).not.toContainEqual(
        expect.objectContaining({ label: "E-mail (id 4004)" }),
      );
      expect(plan.preview.warnings).toEqual([]);
      const writes = client.writes();
      expect(writes.map((call) => [call.method, call.path])).toEqual([
        ["POST", "/CommunicationWay"],
        ["DELETE", "/CommunicationWay/4001"],
      ]);
      expect(writes[0]?.body).toMatchObject({
        type: "EMAIL",
        value: "new@example.com",
        main: true,
      });
    });

    it("replaces the main e-mail: adds the new one first, removes the old one last", async () => {
      const client = new FakeSevdeskClient([
        { method: "DELETE", path: "/CommunicationWay/4001", response: DELETED },
        ...routes(),
      ]);
      const { plan } = await executeWrite(
        tool,
        { id: 1001, email: "neu@example.com", remove: [{ kind: "email", id: 4001 }] },
        client,
      );
      expect(plan.preview.facts).toContainEqual({
        label: "E-mail (new)",
        value: "neu@example.com",
      });
      expect(plan.preview.warnings).toEqual([]);
      expect(client.writes().map((call) => [call.method, call.path])).toEqual([
        ["POST", "/CommunicationWay"],
        ["DELETE", "/CommunicationWay/4001"],
      ]);
    });

    it.each([
      [
        "an address of another contact",
        [{ kind: "address", id: 9999 }],
        "Address 9999 is not one of contact 1001's addresses; nothing was changed. " +
          "sevdesk_contact_get lists them with their ids.",
      ],
      [
        "a communication way of another contact",
        [{ kind: "website", id: 9999 }],
        "Communication way 9999 is not one of contact 1001's communication ways; nothing was " +
          "changed. sevdesk_contact_get lists them with their ids.",
      ],
      [
        "an entry of another kind",
        [{ kind: "email", id: 4002 }],
        "Communication way 4002 of contact 1001 is a phone number, not an e-mail address; " +
          "nothing was changed. Use the kind that matches the entry.",
      ],
      [
        "the same entry twice",
        [
          { kind: "address", id: 3002 },
          { kind: "address", id: 3002 },
        ],
        "remove lists address 3002 twice; list each entry once.",
      ],
    ])("refuses %s before anything is sent", async (_label, remove, message) => {
      const client = new FakeSevdeskClient(routes());
      await expect(
        executeWrite(tool, { id: 1001, taxNumber: "111/111/11111", remove }, client),
      ).rejects.toMatchObject({ kind: "validation", message });
      expect(client.writes()).toEqual([]);
    });

    it("says when the id may be among rows that could not be read", async () => {
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        id: String(5000 + index),
        contact: { id: "1001", objectName: "Contact" },
        city: "Lager",
      }));
      const client = new FakeSevdeskClient(
        routes({ addresses: { body: { objects: rows, total: "20000" } } }),
      );
      await expect(
        prepareWrite(tool, { id: 1001, remove: [{ kind: "address", id: 9999 }] }, client),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "that could be read (sevDesk had more than could be read)",
        ) as string,
      });
    });

    it("refuses an empty list and unknown kinds in the arguments", () => {
      for (const remove of [[], [{ kind: "fax", id: 1 }], [{ kind: "email" }]]) {
        expect(tool.input.safeParse({ id: 1001, remove }).success).toBe(false);
      }
    });

    it("counts an entry sevDesk no longer has as already gone", async () => {
      const client = new FakeSevdeskClient([
        { method: "DELETE", path: "/CommunicationWay/4003", response: NOT_FOUND },
        ...routes(),
      ]);
      const { output } = await executeWrite(
        tool,
        { id: 1001, remove: [{ kind: "website", id: 4003 }] },
        client,
      );
      expect(output.data.removed).toEqual([
        {
          kind: "website",
          id: 4003,
          communicationWay: expect.objectContaining({ id: 4003 }) as unknown,
          alreadyGone: true,
        },
      ]);
    });

    it("lists the entries already deleted when a later deletion fails", async () => {
      const client = new FakeSevdeskClient([
        { method: "DELETE", path: "/ContactAddress/3002", response: DELETED },
        {
          method: "DELETE",
          path: "/CommunicationWay/4001",
          response: { error: new SevdeskError({ kind: "server", status: 500, message: "x" }) },
        },
        ...routes(),
      ]);
      await expect(
        executeWrite(
          tool,
          {
            id: 1001,
            remove: [
              { kind: "address", id: 3002 },
              { kind: "email", id: 4001 },
            ],
          },
          client,
        ),
      ).rejects.toMatchObject({
        kind: "server",
        completedWrites: [{ objectName: "ContactAddress", id: "3002" }],
      });
    });
  });
});
