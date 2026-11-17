import { describe, expect, it } from "vitest";

import { ALL_PROBES } from "../../../scripts/lib/probes/catalog.js";
import { GAPS_CONTACTS_PROBES } from "../../../scripts/lib/probes/gaps-contacts-probes.js";
import { renderReport } from "../../../scripts/lib/probes/report.js";
import { type RunOptions, runProbes } from "../../../scripts/lib/probes/runner.js";
import { assertNoSecrets, createScrubber } from "../../../scripts/lib/scrub.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type ScriptedCall, ScriptedClient } from "./scripted-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TAG = "MCP-E2E 20261120-1000-abcd";
const IDS = GAPS_CONTACTS_PROBES.map((probe) => probe.id);
const WRITE_IDS = GAPS_CONTACTS_PROBES.filter((probe) => probe.mode === "write").map(
  (probe) => probe.id,
);

type Rec = Record<string, unknown>;

function options(client: ScriptedClient, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    client,
    scrubber: createScrubber({ secrets: [TOKEN] }),
    probes: ALL_PROBES,
    allowWrites: true,
    only: IDS,
    tag: TAG,
    today: "2026-11-20",
    nowSeconds: Date.parse("2026-11-20T09:00:00Z") / 1000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    ...overrides,
  };
}

function refused(status: number, upstreamMessage: string): never {
  throw new SevdeskError({
    kind: "validation",
    message: "Invalid request",
    status,
    upstreamMessage,
  });
}

/**
 * A refusal inside HTTP 200, as the client reports it: sevDesk answers deletes of referenced
 * contacts and cost centres this way (D-085, recorded 2026-11-16).
 */
function refusedInOk(): never {
  throw new SevdeskError({
    kind: "unexpected_response",
    message: "sevDesk's answer could not be read: it reports an error despite its status.",
    status: 200,
    upstreamMessage: "Cannot delete because of existing necessary references",
  });
}

const ref = (objectName: string, id: number) => ({ id: String(id), objectName });
const idOf = (value: unknown) => Number((value as Rec | null | undefined)?.["id"]);

/**
 * A simulated trial account with contacts, their details, custom fields, documents, tags and cost
 * centres. By default it behaves as recorded on 2026-11-16 (D-083 to D-092); the switches give
 * synthetic variants so that every branch of the probes is exercised.
 */
function gapsAccount(
  settings: {
    /** POST /CostCentre is refused (the probes then look for a hand-made MCP-E2E one). */
    refuseCostCentreCreate?: boolean;
    /** Hand-made cost centres already on the account. */
    costCentres?: readonly Rec[];
    /**
     * The lists honour `tags[0][id]` and `costCentre[id]`, refuse `tags` (400) and a bare
     * `costCentre` (422), as recorded (D-090, D-092). Off: every filter is ignored.
     */
    honourFilters?: boolean;
    /** saveOrder drops costCentre unless `false` (recorded: it drops it, D-092). */
    orderDropsCostCentre?: boolean;
    /** Synthetic: POST /Contact refuses a person as parent (recorded: no check, D-083). */
    validateParent?: boolean;
    /** Synthetic: DELETE of a referenced contact or used cost centre succeeds (recorded: D-085). */
    allowReferencedDelete?: boolean;
    /** Existing contacts (read probes). */
    contacts?: readonly Rec[];
  } = {},
) {
  let nextId = 1000;
  const contacts = new Map<number, Rec>(
    (settings.contacts ?? []).map((row) => [Number(row["id"]), { ...row }]),
  );
  const addresses = new Map<number, Rec>();
  const ways = new Map<number, Rec>();
  const fieldSettings = new Map<number, Rec>();
  const fields = new Map<number, Rec>();
  const documents = new Map<string, Rec>();
  const tags = new Map<number, Rec>();
  const relations = new Map<number, Rec>();
  const costCentres = new Map<number, Rec>(
    (settings.costCentres ?? []).map((row) => [Number(row["id"]), { ...row }]),
  );

  const list = (rows: readonly Rec[], query: Readonly<Record<string, unknown>>) => {
    const offset = Number(query["offset"] ?? 0);
    const limit = Number(query["limit"] ?? 100);
    return { total: String(rows.length), objects: rows.slice(offset, offset + limit) };
  };
  const byId = (map: Map<number, Rec>, id: number) => {
    const row = map.get(id);
    return row === undefined ? refused(404, "not found") : { objects: [row] };
  };
  const remove = (map: Map<number, Rec>, id: number) => {
    if (!map.delete(id)) refused(404, "not found");
    return { objects: [null] };
  };
  const ofContact = (map: Map<number, Rec>, query: Readonly<Record<string, unknown>>) =>
    [...map.values()].filter(
      (row) =>
        query["contact[id]"] === undefined || idOf(row["contact"]) === Number(query["contact[id]"]),
    );
  const tagsOf = (kind: string, id: number) =>
    [...relations.values()]
      .filter((row) => (row["object"] as Rec)["objectName"] === kind && idOf(row["object"]) === id)
      .map((row) => idOf(row["tag"]));

  const saveDocument = (kind: string, header: Rec): number => {
    const id = header["id"] === undefined ? nextId++ : Number(header["id"]);
    const stored = documents.get(`${kind}/${id}`) ?? { id: String(id), objectName: kind };
    const { mapAll: _mapAll, ...fieldsToStore } = header;
    Object.assign(stored, fieldsToStore, {
      id: String(id),
      status: kind === "Voucher" ? "50" : "100",
    });
    if (kind === "Order" && settings.orderDropsCostCentre !== false) delete stored["costCentre"];
    if (stored["costCentre"] !== undefined && stored["costCentre"] !== null) {
      stored["costCentre"] = ref("CostCentre", idOf(stored["costCentre"]));
    }
    if (stored["contact"] !== undefined) {
      stored["contact"] = ref("Contact", idOf(stored["contact"]));
    }
    documents.set(`${kind}/${id}`, stored);
    return id;
  };

  const handler = (call: ScriptedCall): unknown => {
    const { method, path, query } = call;
    const body = (call.body ?? {}) as Rec;
    const id = Number(/\/(\d+)(?:\/|$)/.exec(path)?.[1]);
    if (path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
    if (path === "/SevUser") return { total: "1", objects: [{ id: "7", objectName: "SevUser" }] };
    if (path === "/ReceiptGuidance/forAllAccounts") {
      return {
        objects: [
          {
            accountDatevId: 4266,
            accountNumber: "6815",
            allowedTaxRules: [{ id: 9, taxRates: ["NINETEEN"] }],
            allowedReceiptTypes: ["EXPENSE"],
          },
        ],
      };
    }
    // --- contacts -----------------------------------------------------------------------------
    if (path === "/Contact" && method === "POST") {
      const parentId = idOf(body["parent"]);
      if (
        settings.validateParent === true &&
        body["parent"] !== undefined &&
        contacts.get(parentId)?.["name"] === undefined
      ) {
        refused(400, "The parent contact must be an organisation.");
      }
      const contactId = nextId++;
      const { parent: _parent, ...fields } = body;
      contacts.set(contactId, {
        ...fields,
        id: String(contactId),
        objectName: "Contact",
        ...(body["parent"] === undefined ? {} : { parent: ref("Contact", parentId) }),
      });
      return { objects: contacts.get(contactId) };
    }
    if (path === "/Contact" && method === "GET") {
      let rows = [...contacts.values()];
      if (query["parent[id]"] !== undefined) {
        rows = rows.filter((row) => idOf(row["parent"]) === Number(query["parent[id]"]));
      }
      return list(rows, query);
    }
    if (/^\/Contact\/\d+$/.test(path)) {
      if (method === "DELETE") {
        const referenced = [...documents.values()].some((doc) => idOf(doc["contact"]) === id);
        if (referenced && settings.allowReferencedDelete !== true) refusedInOk();
        for (const map of [addresses, ways, fields]) {
          for (const [key, row] of map) if (idOf(row["contact"]) === id) map.delete(key);
        }
        return remove(contacts, id);
      }
      if (method === "PUT") {
        const stored = contacts.get(id) ?? refused(404, "not found");
        // Recorded: `parent: null` removes the key from later reads (D-083).
        if (body["parent"] === null) delete stored["parent"];
        else if (body["parent"] !== undefined)
          stored["parent"] = ref("Contact", idOf(body["parent"]));
        return { objects: stored };
      }
      const row = contacts.get(id);
      if (row === undefined) return refused(404, `No Model_Contact with the id ${id} was found`);
      if (query["embed"] === "parent" && row["parent"] !== undefined) {
        return { objects: [{ ...row, parent: contacts.get(idOf(row["parent"])) }] };
      }
      return { objects: [row] };
    }
    if (path === "/Contact/Mapper/checkCustomerNumberAvailability") {
      if (query["customerNumber"] === undefined) refused(400, "customerNumber missing");
      return {
        objects: ![...contacts.values()].some(
          (row) => row["customerNumber"] === query["customerNumber"],
        ),
      };
    }
    if (path === "/Contact/Factory/findContactsByCustomFieldValue") {
      if (query["customFieldName"] === undefined) refused(400, "customFieldName missing");
      const ids = [...fields.values()]
        .filter((row) => row["value"] === query["value"])
        .map((row) => idOf(row["contact"]));
      return { objects: [...contacts.values()].filter((row) => ids.includes(Number(row["id"]))) };
    }
    if (path === "/ContactAddress" || path === "/CommunicationWay") {
      const map = path === "/ContactAddress" ? addresses : ways;
      if (method === "POST") {
        const rowId = nextId++;
        map.set(rowId, {
          ...body,
          id: String(rowId),
          objectName: path.slice(1),
          contact: ref("Contact", idOf(body["contact"])),
          ...(body["main"] === undefined ? {} : { main: body["main"] === true ? "1" : "0" }),
        });
        return { objects: map.get(rowId) };
      }
      return list(ofContact(map, query), query);
    }
    if (/^\/(ContactAddress|CommunicationWay)\/\d+$/.test(path)) {
      const map = path.startsWith("/ContactAddress") ? addresses : ways;
      return method === "DELETE" ? remove(map, id) : byId(map, id);
    }
    // --- custom fields ------------------------------------------------------------------------
    if (/^\/ContactCustomFieldSetting(?:\/\d+)?$/.test(path) && String(body["name"]).length > 30) {
      refused(400, "Property 'name' is too long. Maximum for this property is 30");
    }
    if (path === "/ContactCustomFieldSetting") {
      if (method === "POST") {
        const rowId = nextId++;
        fieldSettings.set(rowId, { ...body, id: String(rowId), identifier: `field_${rowId}` });
        return { objects: [fieldSettings.get(rowId)] };
      }
      return list([...fieldSettings.values()], query);
    }
    if (/^\/ContactCustomFieldSetting\/\d+\/getReferenceCount$/.test(path)) {
      return {
        objects: [...fields.values()].filter((row) => idOf(row["contactCustomFieldSetting"]) === id)
          .length,
      };
    }
    if (/^\/ContactCustomFieldSetting\/\d+$/.test(path)) {
      if (method === "DELETE") {
        if ([...fields.values()].some((row) => idOf(row["contactCustomFieldSetting"]) === id)) {
          refused(409, "Setting is in use.");
        }
        return remove(fieldSettings, id);
      }
      if (method === "PUT") {
        Object.assign(fieldSettings.get(id) ?? {}, { name: body["name"] });
        return { objects: fieldSettings.get(id) };
      }
      return byId(fieldSettings, id);
    }
    if (path === "/ContactCustomField") {
      if (method === "POST") {
        const rowId = nextId++;
        fields.set(rowId, {
          ...body,
          id: String(rowId),
          contact: ref("Contact", idOf(body["contact"])),
          contactCustomFieldSetting: ref(
            "ContactCustomFieldSetting",
            idOf(body["contactCustomFieldSetting"]),
          ),
        });
        return { objects: fields.get(rowId) };
      }
      return list(ofContact(fields, query), query);
    }
    if (/^\/ContactCustomField\/\d+$/.test(path)) {
      if (method === "DELETE") return remove(fields, id);
      if (method === "PUT") {
        Object.assign(fields.get(id) ?? {}, { value: body["value"] });
        return { objects: fields.get(id) };
      }
      return byId(fields, id);
    }
    // --- documents ----------------------------------------------------------------------------
    if (path === "/Order/Factory/getNextOrderNumber") {
      expect(query["useNextNumber"]).toBe("false");
      return { objects: "AN-1000" };
    }
    const save = /^\/(Invoice|Order|CreditNote|Voucher)\/Factory\/save\w+$/.exec(path);
    if (save !== null) {
      const kind = save[1] ?? "";
      const key = kind === "CreditNote" ? "creditNote" : kind.toLowerCase();
      const header = (body[key] ?? {}) as Rec;
      if (kind === "Order" && header["id"] === undefined) {
        if (header["orderNumber"] === undefined) refused(400, "Bad Request");
        const taken = [...documents.values()].some(
          (row) => row["orderNumber"] === header["orderNumber"],
        );
        if (taken) refused(400, "Order number already used");
      }
      const docId = saveDocument(kind, (body[key] ?? {}) as Rec);
      return { objects: { [key]: ref(kind, docId) } };
    }
    const docById = /^\/(Invoice|Order|CreditNote|Voucher)\/(\d+)$/.exec(path);
    if (docById !== null) {
      const row = documents.get(`${docById[1] ?? ""}/${docById[2] ?? ""}`);
      return { objects: row === undefined ? [] : [row] };
    }
    const docList = /^\/(Invoice|Order|CreditNote|Voucher)$/.exec(path);
    if (docList !== null && method === "GET") {
      const kind = docList[1] ?? "";
      let rows = [...documents.values()].filter((row) => row["objectName"] === kind);
      if (settings.honourFilters === true) {
        if (query["tags"] !== undefined) refused(400, "Bad Request");
        if (query["costCentre"] !== undefined) {
          refused(422, "Invalid costCentre given, must have id and objectName");
        }
        if (query["tags[0][id]"] !== undefined) {
          rows = rows.filter((row) =>
            tagsOf(kind, Number(row["id"])).includes(Number(query["tags[0][id]"])),
          );
        }
        if (query["costCentre[id]"] !== undefined) {
          rows = rows.filter((row) => idOf(row["costCentre"]) === Number(query["costCentre[id]"]));
        }
      }
      return list(rows, query);
    }
    // --- tags ---------------------------------------------------------------------------------
    if (path === "/Tag/Factory/create") {
      // Recorded (D-088): only by name, reusing a tag of that name in any case; a document that
      // already has the tag gets its existing relation back.
      const object = body["object"] as Rec;
      if (typeof body["name"] !== "string") refused(400, "Invalid type of parameter");
      const name = body["name"];
      const existing = [...tags.values()].find(
        (row) => String(row["name"]).toLowerCase() === name.toLowerCase(),
      );
      const tagId = existing === undefined ? nextId++ : Number(existing["id"]);
      if (existing === undefined) tags.set(tagId, { id: String(tagId), objectName: "Tag", name });
      const known = [...relations.values()].find(
        (row) =>
          idOf(row["tag"]) === tagId &&
          idOf(row["object"]) === idOf(object) &&
          (row["object"] as Rec)["objectName"] === object["objectName"],
      );
      if (known !== undefined) return { objects: known };
      const relationId = nextId++;
      relations.set(relationId, {
        id: String(relationId),
        objectName: "TagRelation",
        tag: ref("Tag", tagId),
        object: ref(String(object["objectName"]), idOf(object)),
      });
      return { objects: relations.get(relationId) };
    }
    if (path === "/Tag") {
      const rows = [...tags.values()].filter(
        (row) => query["name"] === undefined || row["name"] === query["name"],
      );
      return list(rows, query);
    }
    if (/^\/Tag\/\d+$/.test(path)) {
      if (method === "PUT") {
        Object.assign(tags.get(id) ?? {}, { name: body["name"] });
        return { objects: tags.get(id) };
      }
      if (method === "DELETE") {
        for (const [key, row] of relations) if (idOf(row["tag"]) === id) relations.delete(key);
        return remove(tags, id);
      }
      return byId(tags, id);
    }
    if (path === "/TagRelation") {
      const rows = [...relations.values()].filter(
        (row) =>
          (query["tag[id]"] === undefined || idOf(row["tag"]) === Number(query["tag[id]"])) &&
          (query["object[id]"] === undefined ||
            idOf(row["object"]) === Number(query["object[id]"])),
      );
      return list(rows, query);
    }
    if (/^\/TagRelation\/\d+$/.test(path)) {
      if (method !== "DELETE") return byId(relations, id);
      const tagId = idOf(relations.get(id)?.["tag"]);
      const answer = remove(relations, id);
      // Recorded (D-089): the tag goes with its last relation.
      if (![...relations.values()].some((row) => idOf(row["tag"]) === tagId)) tags.delete(tagId);
      return answer;
    }
    // --- cost centres -------------------------------------------------------------------------
    if (path === "/CostCentre") {
      if (method === "POST") {
        if (settings.refuseCostCentreCreate === true) refused(405, "Method not allowed");
        if (!/^[a-zA-Z0-9 äöüßÄÖÜ]{1,8}$/u.test(String(body["number"]))) {
          refused(422, "The given number (0) is not allowed.");
        }
        const rowId = nextId++;
        costCentres.set(rowId, { ...body, id: String(rowId) });
        return { objects: costCentres.get(rowId) };
      }
      return list([...costCentres.values()], query);
    }
    if (/^\/CostCentre\/\d+$/.test(path)) {
      if (method === "DELETE") {
        const used = [...documents.values()].some((doc) => idOf(doc["costCentre"]) === id);
        if (used && settings.allowReferencedDelete !== true) refusedInOk();
        for (const doc of documents.values())
          if (idOf(doc["costCentre"]) === id) doc["costCentre"] = null;
        return remove(costCentres, id);
      }
      return byId(costCentres, id);
    }
    if (method !== "GET") refused(422, "not simulated");
    return { total: "0", objects: [] };
  };
  return { client: new ScriptedClient(handler), contacts, tags, costCentres, documents };
}

function result(report: Awaited<ReturnType<typeof runProbes>>, id: string) {
  const found = report.results.find((item) => item.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

describe("gap probes (#86, #87): catalog", () => {
  it("registers every probe once with a mode prefix, deviations and no e-mail or opt-in", () => {
    const all = ALL_PROBES.map((probe) => probe.id);
    for (const probe of GAPS_CONTACTS_PROBES) {
      expect(
        all.filter((id) => id === probe.id),
        probe.id,
      ).toHaveLength(1);
      expect(probe.id.startsWith(`${probe.mode}-`), probe.id).toBe(true);
      expect(probe.deviations.length, probe.id).toBeGreaterThan(0);
      expect(probe.sendsEmail, probe.id).toBeUndefined();
      expect(probe.optIn, probe.id).toBeUndefined();
    }
  });

  it("covers the questions of both issues", () => {
    expect(IDS).toEqual(
      expect.arrayContaining([
        "write-contact-parent",
        "write-contact-parent-invalid",
        "write-contact-delete",
        "write-contact-delete-referenced",
        "write-contact-address-delete",
        "write-communication-way-delete",
        "write-custom-field-settings",
        "write-custom-field-values",
        "read-customer-number-availability",
        "write-tag-create-on-documents",
        "write-tag-relation-filters",
        "write-tag-relation-remove",
        "write-tag-update-delete",
        "write-tag-list-filters",
        "read-tag-lists",
        "read-cost-centre-list",
        "write-cost-centre-create",
        "write-cost-centre-documents",
        "write-cost-centre-list-filters",
        "write-cost-centre-delete",
      ]),
    );
    const deviations = new Set(GAPS_CONTACTS_PROBES.flatMap((probe) => probe.deviations));
    const recorded = ["D-024", "D-052", "D-062"];
    for (let n = 83; n <= 92; n += 1) recorded.push(`D-0${n}`);
    for (const id of recorded) expect(deviations.has(id), id).toBe(true);
    expect(deviations.has("NEW")).toBe(false);
  });
});

describe("gap probes (#86, #87) on a simulated trial account", () => {
  it("runs every probe without errors, with the write tier, on its own data only", async () => {
    const account = gapsAccount({ honourFilters: true });
    const report = await runProbes(options(account.client));

    expect(report.results.filter((item) => item.status === "error")).toEqual([]);
    expect(report.results).toHaveLength(IDS.length);
    const writes = account.client.writes();
    for (const call of writes) {
      expect(call.tier, `${call.method} ${call.path}`).toBe("write");
      expect(call.path).not.toMatch(/sendBy|sendVia|enshrine|bookAmount|cancel/);
    }
    // Every DELETE names a record this run created (relations come from the tag factory).
    const created = new Set(report.created.map((record) => `${record.objectName}/${record.id}`));
    for (const call of writes.filter((item) => item.method === "DELETE")) {
      const [, objectName, id] = /^\/(\w+)\/(\d+)$/.exec(call.path) ?? [];
      if (objectName === "TagRelation") continue;
      expect(created.has(`${objectName ?? ""}/${id ?? ""}`), call.path).toBe(true);
    }
    // Everything named carries the run tag, or its short form where sevDesk limits the length.
    for (const call of writes.filter((item) => item.method === "POST")) {
      const body = call.body as Rec | undefined;
      for (const key of ["name", "familyname"]) {
        if (typeof body?.[key] === "string") {
          expect(body[key], call.path).toMatch(/^(?:MCP-E2E |E2E abcd )/);
        }
      }
    }
    // Short names: custom field settings within 30 characters (except the probe of the limit),
    // cost-centre numbers within the 8-character pattern, order numbers distinct.
    const settingNames = writes
      .filter((call) => call.path === "/ContactCustomFieldSetting")
      .map((call) => String((call.body as Rec)["name"]));
    expect(settingNames.filter((name) => name.length > 30)).toEqual([
      "E2E abcd Feld xxxxxxxxxxxxxxxxx",
    ]);
    for (const call of writes.filter((item) => item.path === "/CostCentre")) {
      expect(String((call.body as Rec)["number"])).toMatch(/^[A-Za-z0-9]{1,8}$/);
    }
    const orderNumbers = writes
      .filter((call) => call.path === "/Order/Factory/saveOrder")
      .map((call) => ((call.body as Rec)["order"] as Rec)["orderNumber"])
      .filter((number) => number !== undefined);
    expect(orderNumbers.length).toBeGreaterThan(0);
    expect(new Set(orderNumbers).size).toBe(orderNumbers.length);
    expect(orderNumbers[0]).toBe("AN-1000-P1");
    for (const contact of account.contacts.values()) {
      expect(String(contact["name"] ?? contact["familyname"])).toMatch(/^MCP-E2E /);
    }
    for (const tag of account.tags.values()) expect(String(tag["name"])).toMatch(/^MCP-E2E /i);
    const kinds = new Set(report.created.map((record) => record.objectName));
    for (const kind of [
      "Contact",
      "ContactAddress",
      "CommunicationWay",
      "ContactCustomFieldSetting",
      "ContactCustomField",
      "Invoice",
      "Voucher",
      "Order",
      "CreditNote",
      "Tag",
      "CostCentre",
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(report.created.some((record) => record.state === "deleted by the probe")).toBe(true);
    const markdown = renderReport(report);
    expect(() => {
      assertNoSecrets(markdown, [TOKEN]);
    }).not.toThrow();
  });

  it("follows parent through create, set, change and clear and checks the parent filter", async () => {
    const report = await runProbes(
      options(gapsAccount().client, { only: ["write-contact-parent"] }),
    );
    const finding = result(report, "write-contact-parent").finding;
    expect(finding).toMatch(
      /POST person \d+ with parent \d+: ok; read: parent Contact \d+, with embed=parent Contact \d+ \(\+\d+ keys\)/,
    );
    expect(finding).toMatch(/PUT set to \d+: ok, .*read parent Contact \d+/);
    expect(finding).toMatch(/PUT clear \(null\): ok, .*read parent absent\.$/);
    expect(finding).toMatch(
      /parent\[id\]=\d+: 1 row\(s\), person included: true, rows with another parent: 0 \(honoured\)/,
    );
  });

  it("reports wrong-sided parents as stored, as recorded, and a refusal with its message (D-083)", async () => {
    const report = await runProbes(
      options(gapsAccount().client, { only: ["write-contact-parent-invalid"] }),
    );
    const finding = result(report, "write-contact-parent-invalid").finding;
    expect(finding).toMatch(
      /^POST person with a person as parent: ok \(contact \d+, read parent Contact \d+\)\. POST organisation with an organisation as parent: ok \(contact \d+, read parent Contact \d+\)\. PUT a person's parent to a person: ok; read parent Contact \d+\.$/,
    );

    const validating = await runProbes(
      options(gapsAccount({ validateParent: true }).client, {
        only: ["write-contact-parent-invalid"],
      }),
    );
    expect(result(validating, "write-contact-parent-invalid").finding).toMatch(
      /POST person with a person as parent: refused \(400: The parent contact must be an organisation\.\)/,
    );
  });

  it("deletes contacts, addresses and communication ways and reports what is left", async () => {
    const report = await runProbes(
      options(gapsAccount().client, {
        only: [
          "write-contact-delete",
          "write-contact-delete-referenced",
          "write-contact-address-delete",
          "write-communication-way-delete",
        ],
      }),
    );
    expect(result(report, "write-contact-delete").finding).toMatch(
      /DELETE contact \d+: ok, answer a list of 1; GET afterwards gone \(404\)\. address \d+: gone \(404\)\. communication way \d+: gone \(404\)\. second DELETE: refused \(404: not found\)\./,
    );
    // Recorded (D-085): the refusal arrives inside HTTP 200; nothing changes.
    expect(result(report, "write-contact-delete-referenced").finding).toMatch(
      /DELETE contact: refused \(200: Cannot delete because of existing necessary references\), answer nothing; contact afterwards still there; invoice afterwards still there, status 100, contact Contact \d+\./,
    );
    expect(result(report, "write-contact-address-delete").finding).toMatch(
      /the contact has 1 address\(es\) left.*the contact has 0 address\(es\) left.*second DELETE: refused \(404/,
    );
    expect(result(report, "write-communication-way-delete").finding).toMatch(
      /the other e-mail \d+ now has main "0".*left: PHONE main 1/,
    );
    const states = report.created.filter((record) => record.state === "deleted by the probe");
    expect(states.map((record) => record.objectName)).toEqual(
      expect.arrayContaining(["Contact", "ContactAddress", "CommunicationWay"]),
    );

    const deleting = await runProbes(
      options(gapsAccount({ allowReferencedDelete: true }).client, {
        only: ["write-contact-delete-referenced"],
      }),
    );
    expect(result(deleting, "write-contact-delete-referenced").finding).toMatch(
      /DELETE contact: ok, .*contact afterwards gone \(404\); invoice afterwards still there, status 100, contact Contact \d+/,
    );
  });

  it("probes custom fields without putting their values into the report", async () => {
    const report = await runProbes(
      options(gapsAccount().client, {
        only: ["write-custom-field-settings", "write-custom-field-values"],
      }),
    );
    expect(result(report, "write-custom-field-settings").finding).toMatch(
      /POST with a 31-character name: refused \(400: Property 'name' is too long\. Maximum for this property is 30\)\. POST: ok.*PUT a 30-character name: ok, .*renamed true, description kept true.*getReferenceCount: answer 0.*DELETE: ok, answer a list of 1; GET afterwards gone \(404\); second DELETE refused \(404/,
    );
    const values = result(report, "write-custom-field-values").finding;
    expect(values).toMatch(/value changed true, contact kept true, setting kept true/);
    expect(values).toMatch(/exact, setting id \+ name: 1 contact\(s\), ours true/);
    expect(values).toMatch(/exact, setting id only: refused \(400: customFieldName missing\)/);
    expect(values).toMatch(/prefix: 0 contact\(s\), ours false/);
    expect(values).toMatch(
      /DELETE the setting while value \d+ uses it: refused \(409: Setting is in use\.\)/,
    );
    const markdown = renderReport(report);
    expect(markdown).not.toMatch(/EXT-4711/);
  });

  it("tags documents of every kind, reuses a tag by name and removes one relation", async () => {
    const report = await runProbes(
      options(gapsAccount().client, {
        only: [
          "write-tag-create-on-documents",
          "write-tag-relation-filters",
          "write-tag-relation-remove",
          "write-tag-update-delete",
        ],
      }),
    );
    const create = result(report, "write-tag-create-on-documents");
    expect(create.status).toBe("observed");
    expect(create.finding).toMatch(
      /4 documents tagged by name, 1 distinct tag id\(s\) \(the name reuses the tag\)/,
    );
    // Recorded (D-088): the same name in any case reuses the tag, a second tagging of a document
    // answers its existing relation, and a tag by id without a name is refused.
    expect(create.finding).toMatch(
      /Invoice (\d+): ok, .*relation (\d+)\..*the same name again on invoice \1: ok, tag \d+, relation \2\./,
    );
    expect(create.finding).toMatch(/the name in upper case on order \d+: ok, the same tag/);
    expect(create.finding).toMatch(
      /without a name on invoice \d+: refused \(400: Invalid type of parameter\), no tag id/,
    );
    expect(result(report, "write-tag-relation-filters").finding).toMatch(
      /tag\[id\] filter: 2 row\(s\), 2 of this tag \(honoured\).*limit=1: 1 row\(s\).*count-like keys none/,
    );
    expect(result(report, "write-tag-relation-remove").finding).toMatch(
      /the other relation \d+ kept: true.*DELETE the last relation \d+: ok; the tag afterwards gone \(404\)/,
    );
    expect(result(report, "write-tag-update-delete").finding).toMatch(
      /renamed true; 2 relation\(s\).*DELETE the used tag: ok.*tag afterwards gone \(404\); no relation left/,
    );
  });

  it("tells honoured list filters from ignored ones, with an untagged control", async () => {
    const honoured = await runProbes(
      options(gapsAccount({ honourFilters: true }).client, {
        // The documents probe leaves other drafts with the same cost centre behind.
        only: [
          "write-tag-list-filters",
          "write-cost-centre-documents",
          "write-cost-centre-list-filters",
        ],
      }),
    );
    // As recorded (D-090, D-092).
    for (const kind of ["Invoice", "Voucher", "Order", "CreditNote"]) {
      expect(result(honoured, "write-tag-list-filters").finding).toMatch(
        new RegExp(
          `${kind} \\(tagged \\d+, control \\d+\\): tag\\[id\\] ignored \\(\\d+ rows incl\\. the control, total \\d+\\); ` +
            "tags\\[0\\]\\[id\\] honoured \\(1 row\\(s\\), exactly the expected ones\\); tags refused \\(400: Bad Request\\); tag ignored",
        ),
      );
    }
    expect(result(honoured, "write-cost-centre-list-filters").finding).toMatch(
      /Voucher \(with \d+, stored CostCentre \d+; control \d+\): costCentre\[id\] honoured \(3 row\(s\): the expected one\(s\) and 2 other\(s\) that match, control out\); costCentre refused \(422: Invalid costCentre given, must have id and objectName\)/,
    );
    const ignored = await runProbes(
      options(gapsAccount().client, { only: ["write-tag-list-filters"] }),
    );
    expect(result(ignored, "write-tag-list-filters").finding).toMatch(
      /No parameter was honoured\.$/,
    );
  });

  it("checks costCentre on create and on updates with the id, per document kind", async () => {
    const report = await runProbes(
      options(gapsAccount({ orderDropsCostCentre: true }).client, {
        only: ["write-cost-centre-create", "write-cost-centre-documents"],
      }),
    );
    expect(result(report, "write-cost-centre-create").finding).toMatch(
      /POST \/CostCentre: ok, .*cost centre \d+ created through POST \/CostCentre.*listed in GET \/CostCentre: true/,
    );
    const documents = result(report, "write-cost-centre-documents").finding;
    expect(documents).toMatch(
      /Invoice: created with it → CostCentre \d+; update with id setting it ok → CostCentre \d+; update with id leaving it out ok → CostCentre \d+/,
    );
    expect(documents).toMatch(/Order: created with it → absent; .* → absent/);
    expect(documents).toMatch(/Kept on create: 3 of 4\.$/);
    // Only one cost centre is created for the whole run.
    expect(report.created.filter((record) => record.objectName === "CostCentre")).toHaveLength(1);
  });

  it("falls back to a hand-made MCP-E2E cost centre and never deletes it", async () => {
    const handMade = { id: "77", objectName: "CostCentre", name: "MCP-E2E Kostenstelle" };
    const account = gapsAccount({
      refuseCostCentreCreate: true,
      costCentres: [{ id: "76", objectName: "CostCentre", name: "Vertrieb" }, handMade],
    });
    const report = await runProbes(
      options(account.client, {
        only: ["write-cost-centre-documents", "write-cost-centre-delete"],
      }),
    );
    expect(result(report, "write-cost-centre-documents").finding).toMatch(
      /^Using the hand-made cost centre 77/,
    );
    expect(result(report, "write-cost-centre-delete")).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(/nothing of the probe's own to delete/) as unknown,
    });
    expect(account.client.writes().filter((call) => call.method === "DELETE")).toEqual([]);
    expect(account.costCentres.has(77)).toBe(true);

    const none = await runProbes(
      options(gapsAccount({ refuseCostCentreCreate: true }).client, {
        only: ["write-cost-centre-documents"],
      }),
    );
    expect(result(none, "write-cost-centre-documents")).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(
        /create one named MCP-E2E Kostenstelle in the web app/,
      ) as unknown,
    });
  });

  it("deletes only its own cost centres, unused and in use", async () => {
    const report = await runProbes(
      options(gapsAccount().client, { only: ["write-cost-centre-delete"] }),
    );
    expect(result(report, "write-cost-centre-delete").finding).toMatch(
      /DELETE unused cost centre \d+: ok.*second DELETE refused \(404.*used by voucher \d+ \(CostCentre (\d+)\): refused \(200: Cannot delete because of existing necessary references\); cost centre afterwards still there; voucher costCentre now CostCentre \1\./,
    );
  });
});

describe("gap probes (#86, #87): read probes", () => {
  it("send only GETs and stay inconclusive on an empty account", async () => {
    const account = gapsAccount();
    const report = await runProbes(options(account.client, { allowWrites: false }));
    expect(account.client.writes()).toEqual([]);
    for (const id of WRITE_IDS) expect(result(report, id).status).toBe("skipped");
    for (const id of [
      "read-customer-number-availability",
      "read-tag-lists",
      "read-cost-centre-list",
    ]) {
      expect(result(report, id).status, id).toBe("inconclusive");
    }
  });

  it("asks with the real customer number and keeps it out of the report", async () => {
    const number = "KD-98765";
    const account = gapsAccount({
      contacts: [
        { id: "5", objectName: "Contact", name: "Huber Bau GmbH", customerNumber: number },
      ],
    });
    const report = await runProbes(
      options(account.client, { allowWrites: false, only: ["read-customer-number-availability"] }),
    );
    expect(result(report, "read-customer-number-availability").finding).toBe(
      "a used number: answers false; the same in lower case: answers true; a free number: answers true; no number: refused (400: customerNumber missing).",
    );
    const sent = account.client.calls.map((call) => call.query["customerNumber"]).filter(Boolean);
    expect(sent).toEqual([
      number,
      number.toLowerCase(),
      expect.stringMatching(/^MCP-FREE-/) as unknown,
    ]);
    const markdown = renderReport(report);
    expect(markdown.toLowerCase()).not.toContain("98765");
    expect(markdown).not.toContain("Huber");
  });

  it("describe tags, relations and cost centres by keys and counts", async () => {
    const account = gapsAccount({
      costCentres: [
        { id: "76", objectName: "CostCentre", name: "Vertrieb", number: "100" },
        { id: "77", objectName: "CostCentre", name: "Einkauf", number: "200" },
      ],
    });
    // A tagged invoice made through the write side of the simulation.
    await account.client.request({
      method: "POST",
      path: "/Tag/Factory/create",
      tier: "write",
      body: { name: "Projekt Huber", object: { id: 9, objectName: "Invoice" } },
    });
    const report = await runProbes(
      options(account.client, {
        allowWrites: false,
        only: ["read-tag-lists", "read-cost-centre-list"],
      }),
    );
    expect(result(report, "read-tag-lists").finding).toMatch(
      /GET \/Tag: 1 row\(s\), total 1, keys id, objectName, name\. limit=1: 1 row\(s\)\. name filter: 1 row\(s\), 1 with that name \(honoured\)\. GET \/TagRelation: 1 row\(s\), .*objects Invoice 1; limit=1: 1 row\(s\)\./,
    );
    expect(result(report, "read-cost-centre-list").finding).toMatch(
      /GET \/CostCentre: 2 row\(s\), total 2, keys id, objectName, name, number\. limit=1: 1 row\(s\); offset=1: row 77 \(the second of the full list: true\)\. GET \/CostCentre\/\{id\}: a list of 1/,
    );
    const markdown = renderReport(report);
    expect(markdown).not.toMatch(/Huber|Vertrieb|Einkauf/);
  });
});
