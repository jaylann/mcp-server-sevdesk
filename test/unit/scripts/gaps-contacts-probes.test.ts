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
    /**
     * Custom fields as recorded on 2026-11-17 (D-086): values of at most 100 characters, one value
     * per setting and contact, deleting a setting deletes its values, the search needs no name.
     * Off: the earlier synthetic variant (no value checks, 409 on a used setting, name required).
     */
    customFieldsAsRecorded?: boolean;
    /** Synthetic (not recorded): a voucher position takes the head's cost centre, not its own. */
    positionsTakeHeadCostCentre?: boolean;
    /** Synthetic (not recorded): `GET /TagRelation` lists rows in reverse order past offset 0. */
    relationsUnstable?: boolean;
    /** Synthetic (not recorded): refuses every request this returns true for (422). */
    refuseWhen?: (call: ScriptedCall) => boolean;
  } = {},
) {
  let nextId = 1000;
  /** Voucher positions saved through `saveVoucher` (only `VoucherPos` reads use them). */
  const positions = new Map<number, Rec>();
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
    if (settings.refuseWhen?.(call) === true) refused(422, "Synthetic refusal");
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
      // Recorded (D-020): without depth=1 only organisations.
      if (String(query["depth"]) !== "1") rows = rows.filter((row) => row["name"] !== undefined);
      if (typeof query["name"] === "string") {
        // Synthetic (not recorded): a case-insensitive part of the name or of "first last".
        const wanted = query["name"].toLowerCase();
        rows = rows.filter((row) =>
          [row["name"], `${String(row["surename"])} ${String(row["familyname"])}`].some(
            (shown) => typeof shown === "string" && shown.toLowerCase().includes(wanted),
          ),
        );
      }
      return list(rows, query);
    }
    if (/^\/Contact\/\d+$/.test(path)) {
      if (method === "DELETE") {
        // Recorded (D-084): an organisation's contact persons go with it. Synthetic (not
        // recorded): a document naming one of them refuses the whole delete, as for the contact.
        const doomed = [
          id,
          ...[...contacts.values()]
            .filter((row) => idOf(row["parent"]) === id)
            .map((row) => Number(row["id"])),
        ];
        const referenced = [...documents.values()].some((doc) =>
          doomed.includes(idOf(doc["contact"])),
        );
        if (referenced && settings.allowReferencedDelete !== true) refusedInOk();
        for (const map of [addresses, ways, fields]) {
          for (const [key, row] of map) {
            if (doomed.includes(idOf(row["contact"]))) map.delete(key);
          }
        }
        for (const person of doomed.slice(1)) contacts.delete(person);
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
      if (query["customFieldName"] === undefined && settings.customFieldsAsRecorded !== true) {
        refused(400, "customFieldName missing");
      }
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
        const uses = [...fields].filter(([, row]) => idOf(row["contactCustomFieldSetting"]) === id);
        if (uses.length > 0 && settings.customFieldsAsRecorded !== true) {
          refused(409, "Setting is in use.");
        }
        for (const [key] of uses) fields.delete(key);
        return remove(fieldSettings, id);
      }
      if (method === "PUT") {
        Object.assign(fieldSettings.get(id) ?? {}, { name: body["name"] });
        return { objects: fieldSettings.get(id) };
      }
      return byId(fieldSettings, id);
    }
    if (
      /^\/ContactCustomField(?:\/\d+)?$/.test(path) &&
      settings.customFieldsAsRecorded === true &&
      typeof body["value"] === "string" &&
      body["value"].length > 100
    ) {
      refused(400, "Property 'value' is too long. Maximum for this property is 100");
    }
    if (path === "/ContactCustomField") {
      if (
        method === "POST" &&
        settings.customFieldsAsRecorded === true &&
        [...fields.values()].some(
          (row) =>
            idOf(row["contact"]) === idOf(body["contact"]) &&
            idOf(row["contactCustomFieldSetting"]) === idOf(body["contactCustomFieldSetting"]),
        )
      ) {
        refused(400, "Bad Request");
      }
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
      if (kind === "Voucher" && Array.isArray(body["voucherPosSave"])) {
        const head = documents.get(`Voucher/${docId}`)?.["costCentre"];
        for (const position of body["voucherPosSave"] as Rec[]) {
          const rowId = nextId++;
          const own = position["costCentre"];
          const centre = settings.positionsTakeHeadCostCentre === true ? head : own;
          positions.set(rowId, {
            id: String(rowId),
            objectName: "VoucherPos",
            voucher: ref("Voucher", docId),
            ...(centre === undefined || centre === null
              ? {}
              : { costCentre: ref("CostCentre", idOf(centre)) }),
          });
        }
      }
      return { objects: { [key]: ref(kind, docId) } };
    }
    if (path === "/VoucherPos") {
      return list(
        [...positions.values()].filter(
          (row) =>
            query["voucher[id]"] === undefined ||
            idOf(row["voucher"]) === Number(query["voucher[id]"]),
        ),
        query,
      );
    }
    const docById = /^\/(Invoice|Order|CreditNote|Voucher)\/(\d+)$/.exec(path);
    if (docById !== null && method === "DELETE") {
      // Recorded (D-024, D-074): DELETE removes a draft; a second one is a 404.
      const key = `${docById[1] ?? ""}/${docById[2] ?? ""}`;
      if (!documents.delete(key)) refused(404, "not found");
      for (const [rowId, row] of positions)
        if (idOf(row["voucher"]) === id) positions.delete(rowId);
      return { objects: [null] };
    }
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
      // Recorded: case and é/e fold (D-088). Synthetic (not recorded): the rest of NFKD too, so
      // the ligature U+FB01 folds to "fi" while ß, invisible characters and spaces stay.
      const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
      const existing = [...tags.values()].find((row) => fold(String(row["name"])) === fold(name));
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
      if (settings.relationsUnstable === true && Number(query["offset"] ?? 0) > 0) {
        return list([...rows].reverse(), query);
      }
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
  return {
    client: new ScriptedClient(handler),
    contacts,
    fieldSettings,
    fields,
    tags,
    relations,
    costCentres,
    documents,
    positions,
  };
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
        "write-custom-field-limits",
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
        "write-voucher-position-cost-centre",
        "write-tag-name-matching",
        "write-tag-relation-paging",
        "write-contact-name-search",
        "write-contact-delete-cascade",
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
      // An invoice update with the id and no type needs commit: the client cannot tell it from a
      // change of a recurring template.
      const untyped =
        call.path === "/Invoice/Factory/saveInvoice" &&
        ((call.body as Rec)["invoice"] as Rec)["invoiceType"] === undefined;
      expect(call.tier, `${call.method} ${call.path}`).toBe(untyped ? "commit" : "write");
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
    // Short names: custom field settings within 30 characters (except the two probes of the
    // limit), cost-centre numbers within the 8-character pattern, order numbers distinct.
    const settingNames = writes
      .filter((call) => call.path === "/ContactCustomFieldSetting")
      .map((call) => String((call.body as Rec)["name"]));
    expect(settingNames.filter((name) => name.length > 30)).toEqual([
      "E2E abcd Feld xxxxxxxxxxxxxxxxx",
      "E2E abcd Limit xxxxxxxxxxxxxxxx",
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

  it("re-checks the custom field facts of D-086 and confirms them, deleting what it made (#135)", async () => {
    const account = gapsAccount({ customFieldsAsRecorded: true });
    const report = await runProbes(
      options(account.client, { only: ["write-custom-field-limits"] }),
    );
    const limits = result(report, "write-custom-field-limits");
    expect(limits.status, limits.finding).toBe("confirmed");
    const finding = limits.finding;
    expect(finding).toMatch(
      /31 characters is refused with 400 \(maximum 30\): as recorded \(refused \(400: Property 'name' is too long\. Maximum for this property is 30\)\)/,
    );
    expect(finding).toMatch(
      /exactly 100 characters is stored in full: as recorded \(stored 100 characters, the text sent\)/,
    );
    expect(finding).toMatch(
      /101-character value .*: as recorded \(refused \(400: Property 'value' is too long\. Maximum for this property is 100\); value afterwards unchanged\)/,
    );
    expect(finding).toMatch(
      /second value .*: as recorded \(refused \(400: Bad Request\); a read by contact shows 1 value\(s\) of the setting\)/,
    );
    expect(finding).toMatch(
      /limit=1&offset=0: 2 contact\(s\), organisation true, person true; limit=1&offset=1: 2 contact\(s\), organisation true, person true/,
    );
    expect(finding).toMatch(/value afterwards gone \(404\); getReferenceCount 2 → 1\)/);
    expect(finding).toMatch(
      /answers \[null\] and deletes the value: as recorded \(DELETE ok, answer a list of 1; setting afterwards gone \(404\), value afterwards gone \(404\)\)/,
    );
    // Only the organisation was left to the cleanup; nothing of the probe stays.
    expect(finding).toMatch(/Cleanup: Contact \d+ deleted\.$/);
    expect(account.fieldSettings.size).toBe(0);
    expect(account.fields.size).toBe(0);
    expect(account.contacts.size).toBe(0);
    expect(report.created.every((record) => record.state === "deleted by the probe")).toBe(true);
    // The search names its limit, and no POST or PUT is sent twice with the same body.
    const searches = account.client.calls.filter((call) =>
      call.path.endsWith("findContactsByCustomFieldValue"),
    );
    expect(searches.map((call) => [call.query["limit"], call.query["offset"]])).toEqual([
      [1, 0],
      [1, 1],
    ]);
    const sent = account.client
      .writes()
      .filter((call) => call.method !== "DELETE")
      .map((call) => `${call.method} ${call.path} ${JSON.stringify(call.body)}`);
    expect(new Set(sent).size).toBe(sent.length);
    // Values never reach the report.
    expect(renderReport(report)).not.toMatch(/LIMIT-0|ZWEI/);
  });

  it("reports the earlier variant as contradicted and still deletes values, setting and contacts", async () => {
    const account = gapsAccount();
    const report = await runProbes(
      options(account.client, { only: ["write-custom-field-limits"] }),
    );
    const limits = result(report, "write-custom-field-limits");
    expect(limits.status, limits.finding).toBe("contradicted");
    expect(limits.finding).toMatch(
      /101-character value .*: DIFFERS \(ok; value afterwards changed\)/,
    );
    expect(limits.finding).toMatch(/second value .*: DIFFERS \(created value \d+;/);
    expect(limits.finding).toMatch(
      /deletes the value: DIFFERS \(DELETE refused \(409: Setting is in use\.\); setting afterwards still there, value afterwards still there\)/,
    );
    expect(limits.finding).toMatch(
      /Cleanup: ContactCustomField \d+ deleted; ContactCustomField \d+ deleted; ContactCustomFieldSetting \d+ deleted; Contact \d+ deleted\.$/,
    );
    expect(account.fieldSettings.size).toBe(0);
    expect(account.fields.size).toBe(0);
    expect(account.contacts.size).toBe(0);
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

/** Records of the probe `id` that the cleanup list does not show as deleted. */
function leftBy(report: Awaited<ReturnType<typeof runProbes>>, id: string): string[] {
  return report.created
    .filter((record) => record.probe === id && record.state !== "deleted by the probe")
    .map((record) => `${record.objectName} ${record.id}: ${record.state}`);
}

/**
 * {@link leftBy} without the run's tagged customer (named exactly the run tag): every draft of the
 * run shares it, and no probe deletes it.
 */
function leftByBesidesCustomer(
  report: Awaited<ReturnType<typeof runProbes>>,
  id: string,
  contacts: ReadonlyMap<number, Rec>,
): string[] {
  const customer = [...contacts.values()].find((row) => row["name"] === TAG)?.["id"];
  return leftBy(report, id).filter(
    (line) => line !== `Contact ${String(customer)}: active (can be deleted in the web app)`,
  );
}

/** The names of the contacts still on the simulated account. */
function contactNames(contacts: ReadonlyMap<number, Rec>): string[] {
  return [...contacts.values()].map((row) => String(row["name"] ?? row["familyname"]));
}

/** Refuses the `nth` call (1-based) that `matches`, and no other. */
function refuseNth(matches: (call: ScriptedCall) => boolean, nth: number) {
  let seen = 0;
  return (call: ScriptedCall) => {
    if (!matches(call)) return false;
    seen += 1;
    return seen === nth;
  };
}

describe("trial probes of the open live questions (#136, #134)", () => {
  it("says which cost centre a voucher position keeps and deletes vouchers and cost centres (#119)", async () => {
    const id = "write-voucher-position-cost-centre";
    const account = gapsAccount();
    const report = await runProbes(options(account.client, { only: [id] }));
    const own = result(report, id);
    expect(own.status).toBe("observed");
    expect(own.finding).toMatch(
      /^Cost centres (\d+) \(sent on the head\) and (\d+) \(on the position\)\. head and position \(voucher \d+\): the head reads CostCentre \1 \(the head's\); 1 position\(s\) read CostCentre \2 \(the position's\)\. position only \(voucher \d+\): the head reads absent; 1 position\(s\) read CostCentre \2 \(the position's\)\. Cleanup: Voucher \d+ deleted; Voucher \d+ deleted; CostCentre \1 deleted; CostCentre \2 deleted\.$/,
    );
    expect(leftBy(report, id)).toEqual([]);
    expect(account.costCentres.size).toBe(0);
    expect(account.documents.size).toBe(0);
    // Each position names its own cost centre in the body sent.
    const saves = account.client.writes().filter((call) => call.path.endsWith("/saveVoucher"));
    expect(saves).toHaveLength(2);
    for (const call of saves) {
      const [position] = (call.body as Rec)["voucherPosSave"] as Rec[];
      expect(position?.["costCentre"]).toEqual({
        id: expect.any(Number) as unknown,
        objectName: "CostCentre",
      });
    }

    const headWins = await runProbes(
      options(gapsAccount({ positionsTakeHeadCostCentre: true }).client, { only: [id] }),
    );
    expect(result(headWins, id).finding).toMatch(
      /head and position \(voucher \d+\): the head reads CostCentre (\d+) \(the head's\); 1 position\(s\) read CostCentre \1 \(the head's\)\. position only \(voucher \d+\): the head reads absent; 1 position\(s\) read absent\./,
    );
  });

  it("deletes the cost centres when a voucher is refused or a cost centre is missing", async () => {
    const id = "write-voucher-position-cost-centre";
    const refusing = gapsAccount({
      refuseWhen: (call) => call.path === "/Voucher/Factory/saveVoucher",
    });
    const report = await runProbes(options(refusing.client, { only: [id] }));
    expect(result(report, id).finding).toMatch(
      /head and position: saveVoucher refused \(422: Synthetic refusal\)\. position only: saveVoucher refused \(422: Synthetic refusal\)\. Cleanup: CostCentre \d+ deleted; CostCentre \d+ deleted\.$/,
    );
    expect(refusing.costCentres.size).toBe(0);
    expect(leftBy(report, id)).toEqual([]);

    const one = gapsAccount({
      refuseWhen: refuseNth((call) => call.method === "POST" && call.path === "/CostCentre", 2),
    });
    const partial = await runProbes(options(one.client, { only: [id] }));
    expect(result(partial, id)).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(
        /^POST \/CostCentre ok \/ refused \(422: Synthetic refusal\): the probe needs two cost centres of its own\. Cleanup: CostCentre \d+ deleted\.$/,
      ) as unknown,
    });
    expect(one.costCentres.size).toBe(0);
  });

  it("tells reused tags from new ones per spelling, and the rule of two tag filters (#105)", async () => {
    const id = "write-tag-name-matching";
    const account = gapsAccount({ honourFilters: true });
    const report = await runProbes(options(account.client, { only: [id] }));
    const finding = result(report, id).finding;
    expect(result(report, id).status).toBe("observed");
    // The simulation folds like NFKD: the ligature reuses the tag, the others make new ones.
    expect(finding).toMatch(
      /ß then ss: a new tag, named as sent \(\d+ characters\); GET \/Tag\?name=<variant> 1 row\(s\), the base's tag false, the variant's true\./,
    );
    expect(finding).toMatch(
      /fi then the ligature U\+FB01: reuses the base's tag, named as the base \(\d+ characters\)/,
    );
    for (const label of [
      "a zero-width space inside",
      "a soft hyphen inside",
      "a doubled inner space",
    ]) {
      expect(finding).toContain(`${label}: a new tag, named as sent`);
    }
    // As recorded (D-090), the simulation honours only tags[0].
    expect(finding).toMatch(
      /GET \/Invoice with tags\[0\] and tags\[1\]: the first tag only \(first only true, second only false, both true, untagged false; 2 row\(s\), total 2\)\. Cleanup: (Tag \d+ deleted; ){11}(Invoice \d+ deleted; ){4}Invoice \d+ deleted\.$/,
    );
    const filtered = account.client.calls.find(
      (call) => call.path === "/Invoice" && call.query["tags[1][id]"] !== undefined,
    );
    expect(filtered?.query).toMatchObject({
      "tags[0][objectName]": "Tag",
      "tags[1][objectName]": "Tag",
      limit: 1000,
    });
    expect(leftByBesidesCustomer(report, id, account.contacts)).toEqual([]);
    expect(account.tags.size).toBe(0);
    expect(account.relations.size).toBe(0);
    expect(account.documents.size).toBe(0);
    // Every name sent carries the run tag; none reaches the findings.
    for (const call of account.client
      .writes()
      .filter((item) => item.path === "/Tag/Factory/create")) {
      expect((call.body as Rec)["name"]).toMatch(/^MCP-E2E 20261120-1000-abcd /);
    }
    // The ligature variant, built from its code point like the probe builds it.
    const ligature = new RegExp(`Pro${String.fromCodePoint(0xfb01)}`, "u");
    expect(renderReport(report)).not.toMatch(
      /Maß|Mass\b|Profil|Nullbreite|Trennung|Teile|Filter Erster/,
    );
    expect(renderReport(report)).not.toMatch(ligature);

    const ignored = await runProbes(options(gapsAccount().client, { only: [id] }));
    expect(result(ignored, id).finding).toMatch(
      /tags\[0\] and tags\[1\]: ignored \(an untagged draft is listed\)/,
    );
  });

  it("deletes every tag and draft when a tagging is refused", async () => {
    const id = "write-tag-name-matching";
    const account = gapsAccount({
      refuseWhen: refuseNth((call) => call.path === "/Tag/Factory/create", 3),
    });
    const report = await runProbes(options(account.client, { only: [id] }));
    // The third tagging is the ligature pair's base.
    expect(result(report, id).finding).toMatch(
      /\. fi then the ligature U\+FB01: refused \(422: Synthetic refusal\) \/ ok\. /,
    );
    expect(leftByBesidesCustomer(report, id, account.contacts)).toEqual([]);
    expect(account.tags.size).toBe(0);
    expect(account.documents.size).toBe(0);
  });

  it("compares the paged relation list with one read of 1000 (#119)", async () => {
    const id = "write-tag-relation-paging";
    const account = gapsAccount();
    const report = await runProbes(options(account.client, { only: [id] }));
    expect(result(report, id)).toMatchObject({
      status: "observed",
      finding: expect.stringMatching(
        /^GET \/TagRelation \(limit 1000\): 6 row\(s\), total 6; ids ascending; a second read the same ids in the same order; pages of 3 over the first 6: the same ids in the same order; this run's 6 relations are the last rows\. Cleanup: Tag \d+ deleted; Tag \d+ deleted; (Invoice \d+ deleted; ){2}Invoice \d+ deleted\.$/,
      ) as unknown,
    });
    const pages = account.client.calls.filter(
      (call) => call.path === "/TagRelation" && call.query["limit"] === 3,
    );
    expect(pages.map((call) => call.query["offset"])).toEqual([0, 3]);
    expect(leftByBesidesCustomer(report, id, account.contacts)).toEqual([]);
    expect(account.relations.size).toBe(0);

    const unstable = await runProbes(
      options(gapsAccount({ relationsUnstable: true }).client, { only: [id] }),
    );
    // The second page, read in reverse, repeats the first three relations.
    expect(result(unstable, id).finding).toMatch(
      /pages of 3 over the first 6: differ \(3 missing, 3 listed twice, 6 row\(s\) read\)/,
    );

    const refusing = gapsAccount({
      refuseWhen: (call) => call.path === "/TagRelation" && call.query["offset"] === 3,
    });
    const failed = await runProbes(options(refusing.client, { only: [id] }));
    expect(result(failed, id).finding).toMatch(
      /pages of 3 over the first 6: the page at offset 3 refused \(422: Synthetic refusal\)/,
    );
    expect(leftByBesidesCustomer(failed, id, refusing.contacts)).toEqual([]);
    expect(refusing.documents.size).toBe(0);
  });

  it("searches contacts by name variants without naming them (#102)", async () => {
    const id = "write-contact-name-search";
    const account = gapsAccount();
    const report = await runProbes(options(account.client, { only: [id] }));
    // The simulation searches a case-insensitive part of the shown name (not recorded).
    expect(result(report, id).finding).toMatch(
      /^GET \/Contact\?name=… for organisation (\d+) and person (\d+) \(depth=1 unless said\): organisation, full name: found \(1 row\(s\)\); organisation, lower case: found .*organisation, full name without depth=1: found \(1 row\(s\)\); person, familyname: found .*person, shown name \(first last\): found .*person, familyname without depth=1: not found \(0 row\(s\)\)\. Cleanup: Contact \1 deleted; Contact \2 deleted\.$/,
    );
    const searches = account.client.calls.filter(
      (call) => call.path === "/Contact" && call.method === "GET",
    );
    expect(searches).toHaveLength(11);
    for (const call of searches) expect(call.query["limit"]).toBe(1000);
    expect(searches.filter((call) => call.query["depth"] === undefined)).toHaveLength(2);
    expect(account.contacts.size).toBe(0);
    expect(leftBy(report, id)).toEqual([]);
    expect(renderReport(report)).not.toMatch(/Namensuche|Suchperson|uchperso|ensuche/i);

    const refusing = gapsAccount({
      refuseWhen: (call) =>
        call.method === "POST" && (call.body as Rec)["familyname"] !== undefined,
    });
    const partial = await runProbes(options(refusing.client, { only: [id] }));
    expect(result(partial, id)).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(
        /^Could not create the contacts: ok \/ refused \(422: Synthetic refusal\)\. Cleanup: Contact \d+ deleted\.$/,
      ) as unknown,
    });
    expect(refusing.contacts.size).toBe(0);
  });

  it("reports what deleting an organisation does to its contact persons (#134)", async () => {
    const id = "write-contact-delete-cascade";
    const account = gapsAccount();
    const report = await runProbes(options(account.client, { only: [id] }));
    // As recorded (D-084) the persons go with an unreferenced organisation; the simulation refuses
    // the whole delete when a draft names one of them (not recorded, D-085's refusal in HTTP 200).
    expect(result(report, id).finding).toMatch(
      /^organisation \d+ with 2 contact person\(s\), no document: DELETE ok, answer a list of 1; organisation afterwards gone \(404\); person \d+ gone \(404\); person \d+ gone \(404\)\. organisation (\d+) whose contact person (\d+) draft invoice (\d+) names \(read contact Contact \2\): DELETE refused \(200: Cannot delete because of existing necessary references\), answer nothing; organisation afterwards still there, parent absent; person afterwards still there, parent Contact \1; invoice afterwards still there, status 100, contact Contact \2\. Cleanup: Invoice \3 deleted; Contact \2 deleted; Contact \1 deleted\.$/,
    );
    expect(leftByBesidesCustomer(report, id, account.contacts)).toEqual([]);
    expect(contactNames(account.contacts)).toEqual([TAG]);
    expect(account.documents.size).toBe(0);

    const deleting = gapsAccount({ allowReferencedDelete: true });
    const through = await runProbes(options(deleting.client, { only: [id] }));
    expect(result(through, id).finding).toMatch(
      /DELETE ok, answer a list of 1; organisation afterwards gone \(404\); person afterwards gone \(404\); invoice afterwards still there, status 100, contact Contact \d+\. Cleanup: Invoice \d+ deleted\.$/,
    );
    expect(leftByBesidesCustomer(through, id, deleting.contacts)).toEqual([]);
    expect(contactNames(deleting.contacts)).toEqual([TAG]);
    expect(deleting.documents.size).toBe(0);
  });

  it("still deletes the draft and contacts when the delete of the organisation is refused otherwise", async () => {
    const id = "write-contact-delete-cascade";
    const account = gapsAccount({
      refuseWhen: refuseNth(
        (call) => call.method === "DELETE" && call.path.startsWith("/Contact/"),
        1,
      ),
    });
    const report = await runProbes(options(account.client, { only: [id] }));
    expect(result(report, id).finding).toMatch(
      /^organisation (\d+) with 2 contact person\(s\), no document: DELETE refused \(422: Synthetic refusal\), answer nothing; organisation afterwards still there, parent absent; person \d+ still there, parent Contact \1; person \d+ still there, parent Contact \1\./,
    );
    expect(leftByBesidesCustomer(report, id, account.contacts)).toEqual([]);
    expect(contactNames(account.contacts)).toEqual([TAG]);
    expect(account.documents.size).toBe(0);
  });

  it("is inconclusive when neither organisation can be made: no DELETE was asked", async () => {
    const id = "write-contact-delete-cascade";
    const account = gapsAccount({
      refuseWhen: (call) =>
        call.method === "POST" &&
        call.path === "/Contact" &&
        String((call.body as Rec)["name"]).includes("Kaskade"),
    });
    const report = await runProbes(options(account.client, { only: [id] }));
    const own = result(report, id);
    expect(own.status).toBe("inconclusive");
    expect(own.finding).toMatch(
      /^organisation with persons: refused \(422: Synthetic refusal\)\. organisation with a referenced person: refused \(422: Synthetic refusal\)\.$/,
    );
    expect(account.client.writes().filter((call) => call.method === "DELETE")).toEqual([]);
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
