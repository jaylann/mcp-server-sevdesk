/**
 * `sevdesk_contact_delete` against the behaviour recorded on 2026-11-16 (spec/deviations.md D-084,
 * D-085): the DELETE answers `{objects: [null]}`, the contact (with its addresses and
 * communication ways) is 404 afterwards, a second DELETE is 404, and a contact that documents
 * reference is refused inside HTTP 200. The trap itself, through the real HTTP client, is in
 * `test/regressions/contact-delete-referenced.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError, unexpectedResponse } from "../../../../src/sevdesk/errors.js";
import { contactDeleteTool as tool } from "../../../../src/tools/contacts/delete.js";
import { selectTools } from "../../../../src/tools/registry.js";
import { testConfig, tiers } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { StagedClient } from "../lifecycle/helpers.js";

const DELETED: FakeRoute["response"] = { body: { objects: [null] } };
const GONE: FakeRoute["response"] = {
  error: new SevdeskError({ kind: "not_found", status: 404, message: "Not found." }),
};
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

/** The persons of organisation 1001: person 1002 (`parent` 1001), as the parent filter answers. */
function personsRoute(rows: readonly unknown[] = personRows()): FakeRoute {
  return {
    path: "/Contact",
    query: { depth: "1", "parent[id]": "1001", "parent[objectName]": "Contact" },
    response: { body: { objects: rows } },
  };
}

function personRows(): unknown[] {
  return (loadFixture("contacts/contact-1002.json").body as { objects: unknown[] }).objects;
}

/** Organisation 1001 with its two addresses and three communication ways. */
function organisationRoutes(): FakeRoute[] {
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
    personsRoute(),
  ];
}

/** Person 1002 (belongs to 1001) without addresses or communication ways. */
function personRoutes(): FakeRoute[] {
  return [
    { path: "/Contact/1002", response: { fixture: "contacts/contact-1002.json" } },
    { path: "/ContactAddress", query: filter(1002), response: { body: { objects: [] } } },
    { path: "/CommunicationWay", query: filter(1002), response: { body: { objects: [] } } },
  ];
}

/** The DELETE, then the read-back of contact 1001. */
function afterDelete(
  answer: FakeRoute["response"],
  readBack: FakeRoute["response"] = GONE,
): FakeRoute[] {
  return [
    { method: "DELETE", path: "/Contact/1001", response: answer },
    { path: "/Contact/1001", response: readBack },
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
  });

  it("is offered only with the commit tier", () => {
    const names = (allowed: ReturnType<typeof tiers>) =>
      selectTools([tool], testConfig({ allowedTiers: allowed })).map((entry) => entry.name);
    expect(names(tiers("read", "write"))).toEqual([]);
    expect(names(tiers("read", "commit"))).toEqual(["sevdesk_contact_delete"]);
  });

  it("deletes an organisation and confirms with a read that it is gone (D-084)", async () => {
    const client = new StagedClient(organisationRoutes(), afterDelete(DELETED));
    const { plan, output } = await executeWrite(tool, { id: 1001 }, client);

    expect(client.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["DELETE", "/Contact/1001", "commit"],
    ]);
    expect(plan.preview).toEqual({
      action: "Delete contact 1001 (organisation) from sevDesk.",
      facts: [
        { label: "Contact", value: "Musterfirma GmbH (id 1001)" },
        { label: "Customer number (Kundennummer)", value: "K-1001" },
        { label: "Category", value: "Kunde (customer)" },
        { label: "Contact persons (Ansprechpartner)", value: "1: contact 1002" },
        { label: "Addresses (deleted with it)", value: "2" },
        { label: "Communication ways (deleted with it)", value: "3" },
      ],
      warnings: [
        "The contact, its 2 addresses and its 3 communication ways are deleted from sevDesk; " +
          "this cannot be undone.",
        "1 contact person (Ansprechpartner) belongs to this organisation; what sevDesk does " +
          "with the contact persons of a deleted organisation is not recorded: check afterwards " +
          "with sevdesk_contact_get.",
      ],
      irreversible: true,
    });
    expect(plan.previewDe).toEqual({
      action: "Kontakt 1001 (Organisation) aus sevDesk löschen.",
      facts: [
        { label: "Kontakt", value: "Musterfirma GmbH (ID 1001)" },
        { label: "Kundennummer", value: "K-1001" },
        { label: "Kategorie", value: "Kunde" },
        { label: "Ansprechpartner", value: "1: Kontakt 1002" },
        { label: "Adressen (werden mitgelöscht)", value: "2" },
        { label: "Kommunikationswege (werden mitgelöscht)", value: "3" },
      ],
      warnings: [
        "Der Kontakt, seine 2 Adressen und seine 3 Kommunikationswege werden aus sevDesk " +
          "gelöscht; das lässt sich nicht rückgängig machen.",
        "Zu dieser Organisation gehört 1 Ansprechpartner; was sevDesk mit den Ansprechpartnern " +
          "einer gelöschten Organisation macht, ist nicht erfasst: Prüfen Sie das danach mit " +
          "sevdesk_contact_get.",
      ],
      irreversible: true,
    });
    expect(output.data).toMatchObject({
      contact: { id: 1001, kind: "organisation", displayName: "Musterfirma GmbH" },
      addresses: 2,
      communicationWays: 3,
      deleted: true,
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.data.stillReferenced).toBeUndefined();
    expect(output.summary).toBe("Deleted contact 1001 with 2 addresses and 3 communication ways.");
    expect(output.affected).toEqual([
      { objectName: "Contact", id: "1001" },
      { objectName: "ContactAddress", id: "3001" },
      { objectName: "ContactAddress", id: "3002" },
      { objectName: "CommunicationWay", id: "4001" },
      { objectName: "CommunicationWay", id: "4002" },
      { objectName: "CommunicationWay", id: "4003" },
    ]);
  });

  it("names a person's organisation and reads no contact persons for it", async () => {
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
    ]);
    expect(preview.warnings).toHaveLength(1);
    expect(previewDe.action).toBe("Kontakt 1002 (Person) aus sevDesk löschen.");
    expect(previewDe.facts[3]).toEqual({ label: "Ansprechpartner von", value: "Kontakt 1001" });
    expect(client.callsTo("/Contact")).toEqual([]);
  });

  it("lists no contact persons as none, and says when lists were cut", async () => {
    // A page with a larger total, answered again for every offset: the read stops at its cap of
    // 10,000 rows and reports the list as partial.
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: String(5000 + index),
      contact: { id: "1001", objectName: "Contact" },
      city: "Lager",
    }));
    const client = new FakeSevdeskClient([
      personsRoute([]),
      {
        path: "/ContactAddress",
        query: filter(1001),
        response: { body: { objects: rows, total: 5000 } },
      },
      ...organisationRoutes(),
    ]);
    const { preview, previewDe } = await prepareWrite(tool, { id: 1001 }, client);
    expect(preview.facts).toContainEqual({
      label: "Contact persons (Ansprechpartner)",
      value: "none",
    });
    expect(preview.facts).toContainEqual({
      label: "Addresses (deleted with it)",
      value: "at least 10000",
    });
    expect(preview.warnings).toEqual([
      "The contact, its at least 10000 addresses and its 3 communication ways are deleted from " +
        "sevDesk; this cannot be undone.",
    ]);
    expect(previewDe.facts).toContainEqual({ label: "Ansprechpartner", value: "keine" });
    expect(previewDe.facts).toContainEqual({
      label: "Adressen (werden mitgelöscht)",
      value: "mindestens 10000",
    });
  });

  it("reports sevDesk's refusal of a referenced contact in its own words (D-085)", async () => {
    const client = new StagedClient(
      organisationRoutes(),
      afterDelete({ error: REFUSED }, { fixture: "contacts/contact-1001.json" }),
    );
    const { output } = await executeWrite(tool, { id: 1001 }, client);

    expect(client.writes().map((call) => [call.method, call.path])).toEqual([
      ["DELETE", "/Contact/1001"],
    ]);
    // Never retried: one DELETE, then one read that finds the contact still there.
    expect(
      client.calls.filter((call) => call.path === "/Contact/1001").map((call) => call.method),
    ).toEqual(["GET", "DELETE", "GET"]);
    expect(output.data).toMatchObject({ deleted: false, stillReferenced: true });
    expect(output.data.notes).toEqual([
      "sevDesk refused to delete contact 1001: documents still reference it (sevDesk keeps a " +
        "contact that invoices or other documents use, drafts included). Nothing was deleted; " +
        "the contact, its addresses and its communication ways are unchanged. Give those drafts " +
        "another contact or delete them first; finalized documents keep their contact.",
    ]);
    expect(output.summary).toBe(
      "sevDesk refused to delete contact 1001: documents still reference it. Nothing was deleted.",
    );
    expect(output.affected).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("necessary references");
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
      afterDelete({ error: conflict }, { fixture: "contacts/contact-1001.json" }),
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
    expect(output.data.notes?.[0]).toContain("still returns contact 1001");
    expect(output.summary).toBe(
      "Asked sevDesk to delete contact 1001; it is still there. See notes.",
    );
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
