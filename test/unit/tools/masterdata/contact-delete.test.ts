/**
 * `sevdesk_contact_delete` against the behaviour recorded on 2026-11-16 (spec/deviations.md D-084,
 * D-085): the DELETE answers `{objects: [null]}`, the contact (with its addresses and
 * communication ways, and an organisation with its contact persons) is 404 afterwards, a second
 * DELETE is 404, and a contact that documents reference is refused inside HTTP 200. The trap
 * itself, through the real HTTP client, is in `test/regressions/contact-delete-referenced.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError, unexpectedResponse } from "../../../../src/sevdesk/errors.js";
import { contactDeleteTool as tool } from "../../../../src/tools/contacts/delete.js";
import { selectTools } from "../../../../src/tools/registry.js";
import { testConfig, tiers } from "../../../helpers/config.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { StagedClient } from "../lifecycle/helpers.js";

const DELETED: FakeRoute["response"] = { body: { objects: [null] } };
const GONE: FakeRoute["response"] = {
  error: new SevdeskError({ kind: "not_found", status: 404, message: "Not found." }),
};
const STILL_THERE: FakeRoute["response"] = { fixture: "contacts/contact-1002.json" };
/** What the client raises for the HTTP-200 refusal (D-085), built by the client's own factory. */
const REFUSED = unexpectedResponse(
  200,
  JSON.stringify({
    objects: null,
    error: { message: "Cannot delete because of existing necessary references" },
  }),
  { method: "DELETE", path: "/Contact/1001", secrets: [] },
  "it reports an error despite its status.",
);

function filter(id: number) {
  return { "contact[id]": String(id), "contact[objectName]": "Contact" };
}

/** The persons of organisation 1001, as the parent filter answers. */
function personsRoute(rows: readonly unknown[] = personRows()): FakeRoute {
  return {
    path: "/Contact",
    query: { depth: "1", "parent[id]": "1001", "parent[objectName]": "Contact" },
    response: { body: { objects: rows } },
  };
}

/** Person 1002, "Dr. Max Mustermann", whose `parent` is 1001 (and further ones on request). */
function personRows(...extra: readonly [id: number, firstName: string][]): unknown[] {
  const [person] = (loadFixture("contacts/contact-1002.json").body as { objects: object[] })
    .objects;
  return [
    person,
    ...extra.map(([id, firstName]) => ({ ...person, id: String(id), surename: firstName })),
  ];
}

/** The custom field values of a contact (D-086: read on their own, with the setting embedded). */
function customFieldsRoute(
  id: number,
  response: FakeRoute["response"] = { body: { objects: [] } },
): FakeRoute {
  return {
    path: "/ContactCustomField",
    query: { ...filter(id), embed: "contactCustomFieldSetting" },
    response,
  };
}

/** Organisation 1001 with its two addresses, three communication ways and two custom fields. */
function organisationRoutes(
  persons: FakeRoute = personsRoute(),
  customFields: FakeRoute["response"] = { fixture: "contacts/custom-fields-1001.json" },
): FakeRoute[] {
  return [
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
    customFieldsRoute(1001, customFields),
    persons,
  ];
}

/**
 * Person 1002 (belongs to 1001) without addresses, communication ways or custom fields, and the
 * contacts stored with 1002 as their parent (none unless given; sevDesk stores a person as
 * parent, D-083).
 */
function personRoutes(children: readonly unknown[] = []): FakeRoute[] {
  return [
    { path: "/Contact/1002", response: { fixture: "contacts/contact-1002.json" } },
    { path: "/ContactAddress", query: filter(1002), response: { body: { objects: [] } } },
    { path: "/CommunicationWay", query: filter(1002), response: { body: { objects: [] } } },
    customFieldsRoute(1002),
    {
      path: "/Contact",
      query: { depth: "1", "parent[id]": "1002", "parent[objectName]": "Contact" },
      response: { body: { objects: children } },
    },
  ];
}

/** Person 1006, "Dr. Lisa Mustermann", stored with person 1002 as its parent. */
function childOf1002(): unknown {
  const [person] = (loadFixture("contacts/contact-1002.json").body as { objects: object[] })
    .objects;
  return {
    ...person,
    id: "1006",
    surename: "Lisa",
    customerNumber: "K-1006",
    parent: { id: "1002", objectName: "Contact" },
  };
}

/** The DELETE, then the reads of contact 1001 and of its contact person 1002. */
function afterDelete(
  answer: FakeRoute["response"],
  readBack: FakeRoute["response"] = GONE,
  person: FakeRoute["response"] = GONE,
): FakeRoute[] {
  return [
    { method: "DELETE", path: "/Contact/1001", response: answer },
    { path: "/Contact/1001", response: readBack },
    { path: "/Contact/1002", response: person },
  ];
}

describe("sevdesk_contact_delete", () => {
  it("is a commit tool (a human confirms), destructive and idempotent", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("contacts");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.locks?.({ id: 1001, dryRun: false })).toEqual([
      { objectName: "Contact", id: "1001" },
    ]);
    expect(tool.description).toContain("Deleting an organisation also deletes all its contact");
  });

  it("is offered only with the commit tier", () => {
    const names = (allowed: ReturnType<typeof tiers>) =>
      selectTools([tool], testConfig({ allowedTiers: allowed })).map((entry) => entry.name);
    expect(names(tiers("read", "write"))).toEqual([]);
    expect(names(tiers("read", "commit"))).toEqual(["sevdesk_contact_delete"]);
  });

  it("deletes an organisation with its contact persons and reads every one back (D-084)", async () => {
    const client = new StagedClient(organisationRoutes(), afterDelete(DELETED));
    const { plan, output } = await executeWrite(tool, { id: 1001 }, client);

    expect(client.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["DELETE", "/Contact/1001", "commit"],
    ]);
    expect(plan.preview).toEqual({
      action: "Delete contact 1001 (organisation) and its 1 contact person from sevDesk.",
      facts: [
        { label: "Contact", value: "Musterfirma GmbH (id 1001)" },
        { label: "Customer number (Kundennummer)", value: "K-1001" },
        { label: "Category", value: "Kunde (customer)" },
        { label: "Addresses (deleted with it)", value: "2" },
        { label: "Communication ways (deleted with it)", value: "3" },
        { label: "Custom field values (Kontaktfelder, deleted with it)", value: "2" },
        { label: "Contact persons (deleted with it)", value: "1" },
        { label: "Contact person (deleted with it)", value: "Dr. Max Mustermann (contact 1002)" },
      ],
      warnings: [
        "The contact, its 2 addresses and its 3 communication ways are deleted from sevDesk; " +
          "this cannot be undone.",
        "sevDesk deletes the organisation's 1 contact person (Ansprechpartner) with it; this " +
          "cannot be undone either. If a document uses the organisation or its contact person, " +
          "sevDesk refuses the whole deletion and deletes nothing.",
        "Any custom field values (Kontaktfelder) of the contact and of its contact person are " +
          "deleted with them.",
      ],
      irreversible: true,
    });
    expect(plan.previewDe).toEqual({
      action: "Kontakt 1001 (Organisation) und seinen Ansprechpartner aus sevDesk löschen.",
      facts: [
        { label: "Kontakt", value: "Musterfirma GmbH (ID 1001)" },
        { label: "Kundennummer", value: "K-1001" },
        { label: "Kategorie", value: "Kunde" },
        { label: "Adressen (werden mitgelöscht)", value: "2" },
        { label: "Kommunikationswege (werden mitgelöscht)", value: "3" },
        { label: "Werte von Kontaktfeldern (werden mitgelöscht)", value: "2" },
        { label: "Ansprechpartner (werden mitgelöscht)", value: "1" },
        {
          label: "Ansprechpartner (wird mitgelöscht)",
          value: "Dr. Max Mustermann (Kontakt 1002)",
        },
      ],
      warnings: [
        "Der Kontakt, seine 2 Adressen und seine 3 Kommunikationswege werden aus sevDesk " +
          "gelöscht; das lässt sich nicht rückgängig machen.",
        "sevDesk löscht den Ansprechpartner der Organisation mit; das lässt sich ebenfalls nicht " +
          "rückgängig machen. Verwendet ein Dokument die Organisation oder ihren Ansprechpartner, " +
          "lehnt sevDesk die ganze Löschung ab und löscht nichts.",
        "Auch die Werte von Kontaktfeldern des Kontakts und seines Ansprechpartners werden " +
          "mitgelöscht.",
      ],
      irreversible: true,
    });
    expect(plan.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(output.data).toMatchObject({
      contact: { id: 1001, kind: "organisation", displayName: "Musterfirma GmbH" },
      addresses: 2,
      communicationWays: 3,
      deleted: true,
      contactPersons: [{ id: 1002, displayName: "Dr. Max Mustermann", outcome: "deleted" }],
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.data.stillReferenced).toBeUndefined();
    expect(output.summary).toBe(
      "Deleted contact 1001 with 2 addresses, 3 communication ways and 1 contact person.",
    );
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1001" },
      { objectName: "ContactAddress", id: "3001" },
      { objectName: "ContactAddress", id: "3002" },
      { objectName: "CommunicationWay", id: "4001" },
      { objectName: "CommunicationWay", id: "4002" },
      { objectName: "CommunicationWay", id: "4003" },
      { objectName: "Contact", id: "1002" },
    ]);
  });

  it("names a person's organisation and adds nothing when no contact names it as parent", async () => {
    const client = new FakeSevdeskClient(personRoutes());
    const { preview, previewDe } = await prepareWrite(tool, { id: 1002 }, client);
    expect(preview.action).toBe("Delete contact 1002 (person) from sevDesk.");
    expect(preview.facts).toEqual([
      { label: "Contact", value: "Dr. Max Mustermann (id 1002)" },
      { label: "Customer number (Kundennummer)", value: "K-1002" },
      { label: "Category", value: "Kunde (customer)" },
      { label: "Contact person of", value: "contact 1001" },
      { label: "Addresses (deleted with it)", value: "0" },
      { label: "Communication ways (deleted with it)", value: "0" },
      { label: "Custom field values (Kontaktfelder, deleted with it)", value: "0" },
    ]);
    expect(preview.warnings).toHaveLength(1);
    expect(previewDe.action).toBe("Kontakt 1002 (Person) aus sevDesk löschen.");
    expect(previewDe.facts[3]).toEqual({ label: "Ansprechpartner von", value: "Kontakt 1001" });
    // The parent filter is read for a person too (D-083: sevDesk stores a person as parent).
    expect(client.callsTo("/Contact")).toHaveLength(1);
  });

  it("shows, binds and reads back the contacts stored with a person as parent (D-083)", async () => {
    const plain = await prepareWrite(tool, { id: 1002 }, new FakeSevdeskClient(personRoutes()));
    const client = new StagedClient(personRoutes([childOf1002()]), [
      { method: "DELETE", path: "/Contact/1002", response: DELETED },
      { path: "/Contact/1002", response: GONE },
      { path: "/Contact/1006", response: STILL_THERE },
    ]);
    const { plan, output } = await executeWrite(tool, { id: 1002 }, client);

    expect(plan.preview.action).toBe(
      "Delete contact 1002 (person) from sevDesk; sevDesk may delete its 1 contact person with it.",
    );
    expect(plan.preview.facts.slice(-2)).toEqual([
      { label: "Contact persons (may be deleted with it)", value: "1" },
      {
        label: "Contact person (may be deleted with it)",
        value: "Dr. Lisa Mustermann (contact 1006)",
      },
    ]);
    expect(plan.preview.warnings[1]).toBe(
      "sevDesk has 1 contact stored with this person as its organisation (parent, set outside " +
        "this server). sevDesk may delete it with it; this cannot be undone either.",
    );
    expect(plan.previewDe.action).toBe(
      "Kontakt 1002 (Person) aus sevDesk löschen; sevDesk löscht möglicherweise seinen " +
        "Ansprechpartner mit.",
    );
    expect(plan.previewDe.facts.slice(-2)).toEqual([
      { label: "Ansprechpartner (werden möglicherweise mitgelöscht)", value: "1" },
      {
        label: "Ansprechpartner (wird möglicherweise mitgelöscht)",
        value: "Dr. Lisa Mustermann (Kontakt 1006)",
      },
    ]);
    expect(plan.previewDe.warnings[1]).toBe(
      "In sevDesk ist 1 Kontakt mit dieser Person als Organisation gespeichert (parent, " +
        "außerhalb dieses Servers gesetzt). sevDesk löscht ihn möglicherweise mit; das lässt " +
        "sich ebenfalls nicht rückgängig machen.",
    );
    // The custom field values: the person's own, and those of a contact sevDesk may take along.
    expect(plan.preview.warnings[2]).toBe(
      "Its custom field values (Kontaktfelder) are deleted with it, and so are those of any " +
        "contact sevDesk deletes with it.",
    );
    expect(plan.previewDe.warnings[2]).toBe(
      "Auch die Werte seiner Kontaktfelder werden mitgelöscht, ebenso die jedes Kontakts, den " +
        "sevDesk mitlöscht.",
    );
    // A contact stored under the person after the human was asked asks again.
    expect(plan.binding).not.toBe(plain.binding);

    expect(output.data.contactPersons).toEqual([
      { id: 1006, displayName: "Dr. Lisa Mustermann", outcome: "remaining" },
    ]);
    expect(output.data.notes).toEqual([
      "Contact person 1006 is still in sevDesk although person 1002 was deleted; whether " +
        "sevDesk deletes contacts stored under a person is not recorded. Check with " +
        "sevdesk_contact_get.",
    ]);
    expect(output.affected).not.toContainEqual({ objectName: "Contact", id: "1006" });
  });

  it("says the custom field values go too, and when they could not be read (D-086)", async () => {
    const error = new SevdeskError({ kind: "server", status: 500, message: "Down." });
    const client = new FakeSevdeskClient(
      withCountryRoute(organisationRoutes(personsRoute([]), { error })),
    );
    const { preview, previewDe } = await prepareWrite(tool, { id: 1001 }, client);
    expect(preview.facts).toContainEqual({
      label: "Custom field values (Kontaktfelder, deleted with it)",
      value: "could not be read",
    });
    expect(previewDe.facts).toContainEqual({
      label: "Werte von Kontaktfeldern (werden mitgelöscht)",
      value: "nicht lesbar",
    });
    // Unread values may exist, so the warning names them all the same.
    expect(preview.warnings).toContain(
      "Its custom field values (Kontaktfelder) are deleted with it.",
    );
    expect(previewDe.warnings).toContain("Auch die Werte seiner Kontaktfelder werden mitgelöscht.");
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/ContactCustomField").every((call) => call.method === "GET")).toBe(true);
  });

  it("binds the approval to the custom field values the preview counts (D-086)", async () => {
    const [first, second] = (
      loadFixture("contacts/custom-fields-1001.json").body as { objects: object[] }
    ).objects;
    const prepare = (values: FakeRoute["response"]) =>
      prepareWrite(
        tool,
        { id: 1001 },
        new FakeSevdeskClient(withCountryRoute(organisationRoutes(personsRoute([]), values))),
      );
    const plan = await prepare({ body: { objects: [first, second] } });
    // The same count, but value 7002 replaced by another one: the same previews, another binding.
    const swapped = await prepare({ body: { objects: [first, { ...second, id: "7009" }] } });
    expect(swapped.preview).toEqual(plan.preview);
    expect(swapped.previewDe).toEqual(plan.previewDe);
    expect(swapped.binding).not.toBe(plan.binding);
    // Unreadable values bind as such, unlike any list that was read.
    const unreadable = await prepare({
      error: new SevdeskError({ kind: "server", status: 500, message: "Down." }),
    });
    expect(unreadable.binding).not.toBe(plan.binding);
    const empty = await prepare({ body: { objects: [] } });
    expect(empty.binding).not.toBe(unreadable.binding);
  });

  it("lists no contact persons as none, and says when address lists were cut", async () => {
    // A page with a larger total, answered again for every offset: the read stops at its cap of
    // 10,000 rows and reports the list as partial.
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: String(5000 + index),
      contact: { id: "1001", objectName: "Contact" },
      city: "Lager",
    }));
    const client = new FakeSevdeskClient([
      {
        path: "/ContactAddress",
        query: filter(1001),
        response: { body: { objects: rows, total: 5000 } },
      },
      ...organisationRoutes(personsRoute([])),
    ]);
    const { preview, previewDe } = await prepareWrite(tool, { id: 1001 }, client);
    expect(preview.action).toBe("Delete contact 1001 (organisation) from sevDesk.");
    expect(preview.facts).toContainEqual({
      label: "Contact persons (deleted with it)",
      value: "none",
    });
    expect(preview.facts).toContainEqual({
      label: "Addresses (deleted with it)",
      value: "at least 10000",
    });
    expect(preview.warnings).toEqual([
      "The contact, its at least 10000 addresses and its 3 communication ways are deleted from " +
        "sevDesk; this cannot be undone.",
      "Its custom field values (Kontaktfelder) are deleted with it.",
    ]);
    expect(previewDe.warnings).toContain("Auch die Werte seiner Kontaktfelder werden mitgelöscht.");
    expect(previewDe.facts).toContainEqual({
      label: "Ansprechpartner (werden mitgelöscht)",
      value: "keine",
    });
    expect(previewDe.facts).toContainEqual({
      label: "Adressen (werden mitgelöscht)",
      value: "mindestens 10000",
    });
  });

  it("lists up to 20 contact persons by name and binds the approval to all of them", async () => {
    const many = (last: number) =>
      personRows(
        ...Array.from({ length: 23 }, (_, index): [number, string] => [2001 + index, `P${index}`]),
        [last, "Zuletzt"],
      );
    const prepare = (last: number) =>
      prepareWrite(
        tool,
        { id: 1001 },
        new FakeSevdeskClient(withCountryRoute(organisationRoutes(personsRoute(many(last))))),
      );
    const plan = await prepare(2100);
    const personFacts = plan.preview.facts.filter((fact) =>
      fact.label.startsWith("Contact person"),
    );
    // The count, then 20 persons by name; the 5 others are only counted.
    expect(personFacts).toHaveLength(21);
    expect(personFacts[0]).toEqual({ label: "Contact persons (deleted with it)", value: "25" });
    expect(personFacts[1]).toEqual({
      label: "Contact person (deleted with it)",
      value: "Dr. Max Mustermann (contact 1002)",
    });
    expect(personFacts[2]).toEqual({
      label: "Contact person (deleted with it)",
      value: "Dr. P0 Mustermann (contact 2001)",
    });
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "More contact persons",
      value: "5 more, deleted as well, not listed here",
    });
    expect(plan.previewDe.facts.at(-1)).toEqual({
      label: "Weitere Ansprechpartner",
      value: "5 weitere, werden ebenfalls gelöscht, hier nicht aufgeführt",
    });
    expect(plan.preview.action).toBe(
      "Delete contact 1001 (organisation) and its 25 contact persons from sevDesk.",
    );
    expect(plan.previewDe.action).toBe(
      "Kontakt 1001 (Organisation) und seine 25 Ansprechpartner aus sevDesk löschen.",
    );

    // The same organisation again: the same binding. Another person in place of the last one,
    // who is not listed: the same previews, but another binding, so the human is asked again.
    const again = await prepare(2100);
    expect(again.binding).toBe(plan.binding);
    const swapped = await prepare(2200);
    expect(swapped.preview).toEqual(plan.preview);
    expect(swapped.previewDe).toEqual(plan.previewDe);
    expect(swapped.binding).not.toBe(plan.binding);
  });

  it("refuses an organisation whose contact persons cannot all be read", async () => {
    // 101 rows of a larger total: more than the 100 the tool reads.
    const rows = personRows(
      ...Array.from({ length: 100 }, (_, index): [number, string] => [3001 + index, "P"]),
    );
    const client = new FakeSevdeskClient(
      withCountryRoute(
        organisationRoutes({
          ...personsRoute(),
          response: { body: { objects: rows, total: 500 } },
        }),
      ),
    );
    await expect(prepareWrite(tool, { id: 1001 }, client)).rejects.toMatchObject({
      kind: "validation",
      message:
        "Contact 1001 is an organisation with more than 100 contact persons (Ansprechpartner), " +
        "and sevDesk deletes them all with it. Not all of them could be read, so this deletion " +
        "is not offered here; nothing was changed.",
    });
    expect(client.writes()).toEqual([]);
  });

  it("says so when a contact person is still there or could not be checked", async () => {
    const down = new SevdeskError({ kind: "server", status: 503, message: "Down." });
    const client = new StagedClient(organisationRoutes(personsRoute(personRows([1005, "Erika"]))), [
      ...afterDelete(DELETED, GONE, STILL_THERE),
      { path: "/Contact/1005", response: { error: down } },
    ]);
    const { output } = await executeWrite(tool, { id: 1001 }, client);
    expect(output.data.contactPersons).toEqual([
      { id: 1002, displayName: "Dr. Max Mustermann", outcome: "remaining" },
      { id: 1005, displayName: "Dr. Erika Mustermann", outcome: "unchecked" },
    ]);
    expect(output.data.notes).toEqual([
      "Contact person 1002 is still in sevDesk although organisation 1001 was deleted; sevDesk " +
        "deleted an organisation's contact persons with it when this was recorded. Check with " +
        "sevdesk_contact_get.",
      "Whether contact person 1005 was deleted could not be checked. Check with " +
        "sevdesk_contact_get.",
    ]);
    expect(output.summary).toBe(
      "Deleted contact 1001 with 2 addresses, 3 communication ways and 0 contact persons. See " +
        "notes.",
    );
    expect(output.affected).not.toContainEqual({ objectName: "Contact", id: "1002" });
  });

  it("reports sevDesk's refusal of a referenced contact in its own words (D-085)", async () => {
    const client = new StagedClient(
      organisationRoutes(),
      afterDelete({ error: REFUSED }, { fixture: "contacts/contact-1001.json" }, STILL_THERE),
    );
    const { output } = await executeWrite(tool, { id: 1001 }, client);

    expect(client.writes().map((call) => [call.method, call.path])).toEqual([
      ["DELETE", "/Contact/1001"],
    ]);
    // Never retried: one DELETE, then one read that finds the contact still there.
    expect(
      client.calls.filter((call) => call.path === "/Contact/1001").map((call) => call.method),
    ).toEqual(["GET", "DELETE", "GET"]);
    expect(output.data).toMatchObject({
      deleted: false,
      stillReferenced: true,
      contactPersons: [{ id: 1002, outcome: "remaining" }],
    });
    expect(output.data.notes).toEqual([
      "sevDesk refused to delete contact 1001: documents still reference it or one of its " +
        "contact persons (sevDesk keeps a contact that invoices or other documents use, drafts " +
        "included). Nothing was deleted; the contact, its addresses and its communication ways " +
        "are unchanged. Give those drafts another contact or delete them first; finalized " +
        "documents keep their contact.",
    ]);
    expect(output.summary).toBe(
      "sevDesk refused to delete contact 1001: documents still reference it. Nothing was " +
        "deleted. See notes.",
    );
    expect(output.affected).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("necessary references");
  });

  it("does not claim nothing was deleted when a contact person is gone after a refusal", async () => {
    const client = new StagedClient(
      organisationRoutes(),
      afterDelete({ error: REFUSED }, { fixture: "contacts/contact-1001.json" }, GONE),
    );
    const { output } = await executeWrite(tool, { id: 1001 }, client);
    expect(output.data).toMatchObject({
      deleted: false,
      stillReferenced: true,
      contactPersons: [{ id: 1002, outcome: "deleted" }],
    });
    expect(output.summary).toBe(
      "sevDesk refused to delete contact 1001: documents still reference it. The organisation " +
        "was not deleted; see notes.",
    );
    expect(output.data.notes).toEqual([
      "sevDesk refused to delete contact 1001: documents still reference it or one of its " +
        "contact persons (sevDesk keeps a contact that invoices or other documents use, drafts " +
        "included). The contact, its addresses and its communication ways are unchanged. Give " +
        "those drafts another contact or delete them first; finalized documents keep their " +
        "contact.",
      "Contact person 1002 is gone although organisation 1001 is still in sevDesk. Check with " +
        "sevdesk_contact_get.",
    ]);
    expect(JSON.stringify(output)).not.toContain("Nothing was deleted");
    expect(output.affected).toEqual([{ objectName: "Contact", id: "1002" }]);
  });

  it("treats the same refusal with the 409 the spec declares alike", async () => {
    const conflict = new SevdeskError({
      kind: "validation",
      status: 409,
      message: "sevDesk rejected the request: validation error (HTTP 409).",
      upstreamMessage: "Cannot delete because of existing necessary references",
    });
    const client = new StagedClient(
      organisationRoutes(),
      afterDelete({ error: conflict }, { fixture: "contacts/contact-1001.json" }, STILL_THERE),
    );
    const { output } = await executeWrite(tool, { id: 1001 }, client);
    expect(output.data).toMatchObject({ deleted: false, stillReferenced: true });
  });

  it("reports a refused contact that a read no longer finds as deleted", async () => {
    const client = new StagedClient(organisationRoutes(), afterDelete({ error: REFUSED }));
    const { output } = await executeWrite(tool, { id: 1001 }, client);
    expect(output.data).toMatchObject({ deleted: true });
    expect(output.data.stillReferenced).toBeUndefined();
    expect(output.data.notes?.[0]).toContain("no longer finds it");
  });

  it("says so when sevDesk accepted the deletion but still returns the contact", async () => {
    const client = new StagedClient(
      organisationRoutes(),
      afterDelete(DELETED, { fixture: "contacts/contact-1001.json" }),
    );
    const { output } = await executeWrite(tool, { id: 1001 }, client);
    expect(output.data.deleted).toBe(false);
    expect(output.data.notes).toEqual([
      "sevDesk accepted the deletion, but still returns contact 1001. Check it with " +
        "sevdesk_contact_get.",
      "Contact person 1002 is gone although organisation 1001 is still in sevDesk. Check with " +
        "sevdesk_contact_get.",
    ]);
    expect(output.summary).toBe(
      "Asked sevDesk to delete contact 1001; it is still there. See notes.",
    );
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1001" },
      { objectName: "Contact", id: "1002" },
    ]);
  });

  it("counts a 404 on the DELETE as already gone (D-084)", async () => {
    const client = new StagedClient(organisationRoutes(), afterDelete(GONE));
    const { output } = await executeWrite(tool, { id: 1001 }, client);
    expect(output.data.deleted).toBe(true);
    expect(output.data.notes).toEqual([
      "Contact 1001 was already gone in sevDesk when it was deleted.",
    ]);
  });

  it("reports the deletion as sent when the check afterwards fails", async () => {
    const down = new SevdeskError({ kind: "server", status: 503, message: "Down." });
    const client = new StagedClient(organisationRoutes(), afterDelete(DELETED, { error: down }));
    const error = (await executeWrite(tool, { id: 1001 }, client).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.kind).toBe("server");
    expect(error.message).toBe(
      "sevDesk accepted the deletion of contact 1001, but the check afterwards failed: Down. Do " +
        "not delete again; check with sevdesk_contact_get.",
    );
    expect(error.completedWrites).toEqual([{ objectName: "Contact", id: "1001" }]);
  });

  it("says that a refused deletion's check failed without claiming a change", async () => {
    const down = new SevdeskError({ kind: "server", status: 503, message: "Down." });
    const client = new StagedClient(
      organisationRoutes(),
      afterDelete({ error: REFUSED }, { error: down }),
    );
    const error = (await executeWrite(tool, { id: 1001 }, client).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.message).toContain("refused to delete contact 1001 because documents still");
    expect(error.completedWrites).toEqual([]);
    expect(error.message).not.toContain("necessary references");
  });

  it("passes other delete failures through unchanged", async () => {
    const failure = new SevdeskError({ kind: "server", status: 500, message: "Down." });
    const other = unexpectedResponse(
      200,
      JSON.stringify({ objects: null, error: { message: "Something else" } }),
      { method: "DELETE", path: "/Contact/1001", secrets: [] },
      "it reports an error despite its status.",
    );
    for (const error of [failure, other]) {
      const client = new StagedClient(organisationRoutes(), afterDelete({ error }));
      await expect(executeWrite(tool, { id: 1001 }, client)).rejects.toBe(error);
    }
  });

  it("refuses an unknown contact before anything is sent", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Contact/4040", response: { body: { objects: [] } } },
      { path: "/ContactAddress", query: filter(4040), response: { body: { objects: [] } } },
      { path: "/CommunicationWay", query: filter(4040), response: { body: { objects: [] } } },
    ]);
    await expect(prepareWrite(tool, { id: 4040 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: "Contact 4040 does not exist in sevDesk (or was deleted already).",
    });
    expect(client.writes()).toEqual([]);
  });
});
