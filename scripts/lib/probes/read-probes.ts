/**
 * Read-only probes: they only send GETs (the client runs in read-only mode and would refuse
 * anything else) and work with whatever the account already holds. Where the account lacks the
 * data a question needs, the verdict is `inconclusive` and says what is missing; in a write run
 * the write probes run first, so their tagged documents are there to read.
 */
import { RUN_TAG_PREFIX } from "../live-env.js";
import {
  berlinMidnight,
  diffState,
  type ProbeContext,
  type ProbeDefinition,
  type ProbeOutcome,
  refId,
  type Row,
  sendState,
  str,
} from "./core.js";

const UNKNOWN_ID = 999_999_999;

function typesOf(rows: readonly Row[], keys: readonly string[]): string {
  return keys
    .map((key) => {
      const types = new Set(rows.map((row) => (row[key] === null ? "null" : typeof row[key])));
      return `${key}: ${[...types].join("/") || "absent"}`;
    })
    .join(", ");
}

function inconclusive(finding: string): ProbeOutcome {
  return { verdict: "inconclusive", finding };
}

/** A non-draft document of `objectName` (status other than 100). */
async function nonDraft(ctx: ProbeContext, objectName: string): Promise<Row | undefined> {
  return ctx.read.first(`/${objectName}`, undefined, (row) => str(row, "status") !== "100");
}

export const READ_PROBES: readonly ProbeDefinition[] = [
  {
    id: "read-unknown-id",
    title: "GET by id for an id that does not exist",
    mode: "read",
    question:
      "Does GET /Contact/{id} and /Invoice/{id} answer an unknown id with an empty list, 400 or 404?",
    deviations: ["D-001", "D-021"],
    async run(ctx) {
      const contact = await ctx.http.get(`/Contact/${UNKNOWN_ID}`);
      const invoice = await ctx.http.get(`/Invoice/${UNKNOWN_ID}`);
      const describe = (result: typeof contact): string =>
        result.ok
          ? Array.isArray(result.objects) && result.objects.length === 0
            ? "2xx with an empty list"
            : "2xx with data"
          : `${String(result.status ?? result.kind)} (${result.kind ?? "error"})`;
      const answers = `Contact: ${describe(contact)}; Invoice: ${describe(invoice)}.`;
      const emptyList = [contact, invoice].some(
        (result) => result.ok && Array.isArray(result.objects) && result.objects.length === 0,
      );
      const status400 = [contact, invoice].some((result) => result.status === 400);
      const status404 = [contact, invoice].some((result) => result.status === 404);
      return {
        verdict: emptyList || status400 ? "confirmed" : "observed",
        finding: answers,
        deviations: {
          "D-001": emptyList ? "confirms" : "informs",
          "D-021": status400 ? "confirms" : status404 ? "contradicts" : "informs",
        },
      };
    },
  },
  {
    id: "read-scalar-types",
    title: "Scalar types in list responses",
    mode: "read",
    question:
      "Are ids, sums, statuses and the countAll total strings; which fields arrive as JSON numbers; which sendType values occur?",
    deviations: ["D-002", "D-008", "D-009"],
    async run(ctx) {
      const invoices = await ctx.read.page("/Invoice", { embed: "contact" }, 50);
      const transactions = await ctx.read.page("/CheckAccountTransaction", undefined, 50);
      const contacts = await ctx.read.page("/Contact", { depth: 1 }, 50);
      const totalRaw = (invoices.result.json as { total?: unknown } | undefined)?.total;
      const sendTypes = new Set(
        [...invoices.rows, ...(await ctx.read.page("/Order", undefined, 50)).rows].map((row) =>
          JSON.stringify(row["sendType"] ?? null),
        ),
      );
      const finding =
        `countAll total: ${typeof totalRaw}. Invoices (${invoices.rows.length}): ` +
        `${typesOf(invoices.rows, ["id", "status", "sumNet", "sumGross", "paidAmount", "showNet"])}. ` +
        `Transactions (${transactions.rows.length}): ${typesOf(transactions.rows, ["amount"])}. ` +
        `Contacts (${contacts.rows.length}): ${typesOf(contacts.rows, ["defaultDiscountAmount"])}. ` +
        `sendType values on invoices and orders: ${[...sendTypes].join(", ") || "none"}.`;
      if (invoices.rows.length === 0) return inconclusive(`No invoices to inspect. ${finding}`);
      const strings =
        typeof totalRaw === "string" && invoices.rows.every((row) => typeof row["id"] === "string");
      return {
        verdict: strings ? "confirmed" : "contradicted",
        finding,
        deviations: { "D-008": "informs", "D-009": "informs" },
      };
    },
  },
  {
    id: "read-limit-range",
    title: "limit outside 1–1000 and the default page size",
    mode: "read",
    question: "Is limit=1001 or limit=0 refused with 400, and does an omitted limit cut at 100?",
    deviations: ["D-019"],
    async run(ctx) {
      const tooLarge = await ctx.http.get("/Contact", { depth: 1, limit: 1001 });
      const zero = await ctx.http.get("/Contact", { depth: 1, limit: 0 });
      const unlimited = await ctx.http.get("/Contact", { depth: 1, countAll: true });
      const rows = Array.isArray(unlimited.objects) ? unlimited.objects.length : 0;
      const total = Number((unlimited.json as { total?: unknown } | undefined)?.total);
      const refused = !tooLarge.ok && tooLarge.status === 400;
      const truncation =
        Number.isFinite(total) && total > 100
          ? `without limit: ${rows} of ${total} rows`
          : `without limit: ${rows} rows (total ${Number.isFinite(total) ? total : "unknown"}; needs more than 100 contacts to show the cut)`;
      return {
        verdict: refused ? "confirmed" : "contradicted",
        finding:
          `limit=1001: ${tooLarge.ok ? "accepted" : String(tooLarge.status)}; ` +
          `limit=0: ${zero.ok ? "accepted" : String(zero.status)}; ${truncation}.`,
      };
    },
  },
  {
    id: "read-contact-depth",
    title: "GET /Contact without depth",
    mode: "read",
    question: "Does GET /Contact without depth=1 return organisations only?",
    deviations: ["D-020"],
    async run(ctx) {
      const without = await ctx.read.total("/Contact");
      const withDepth = await ctx.read.total("/Contact", { depth: 1 });
      const persons = (await ctx.read.page("/Contact", { depth: 1 }, 1000)).rows.filter(
        (row) => str(row, "surename") !== "" || str(row, "familyname") !== "",
      ).length;
      const finding = `Total without depth: ${String(without)}; with depth=1: ${String(withDepth)}; persons among depth=1 rows: ${persons}.`;
      if (persons === 0) return inconclusive(`${finding} Needs at least one person contact.`);
      return { verdict: (without ?? 0) < (withDepth ?? 0) ? "confirmed" : "contradicted", finding };
    },
  },
  {
    id: "read-transaction-boolean-filters",
    title: "isBooked=1/0/false on transactions",
    mode: "read",
    question: "Does isBooked=1 filter, and are isBooked=0 and isBooked=false ignored?",
    deviations: ["D-020"],
    async run(ctx) {
      const all = await ctx.read.total("/CheckAccountTransaction");
      const booked = await ctx.read.total("/CheckAccountTransaction", { isBooked: 1 });
      const zero = await ctx.read.total("/CheckAccountTransaction", { isBooked: 0 });
      const literal = await ctx.read.total("/CheckAccountTransaction", { isBooked: "false" });
      const finding = `Totals: unfiltered ${String(all)}, isBooked=1 ${String(booked)}, isBooked=0 ${String(zero)}, isBooked=false ${String(literal)}.`;
      if (!all)
        return inconclusive(
          `${finding} Needs bank transactions (import a CSV or add a cash entry).`,
        );
      const ignoredFalse = literal === all;
      return { verdict: ignoredFalse ? "confirmed" : "contradicted", finding };
    },
  },
  {
    id: "read-transaction-status-filter",
    title: "status filter on transactions",
    mode: "read",
    question:
      "Does GET /CheckAccountTransaction?status=100 return only status-100 rows; which statuses occur (350)?",
    deviations: ["D-020", "D-031"],
    async run(ctx) {
      const all = await ctx.read.page("/CheckAccountTransaction", undefined, 1000);
      const statuses = [...new Set(all.rows.map((row) => str(row, "status")))].sort();
      if (all.rows.length === 0) {
        return inconclusive(
          "No bank transactions in the account (import a CSV or add a cash entry).",
        );
      }
      const target = statuses[0] ?? "100";
      const filtered = await ctx.read.page("/CheckAccountTransaction", { status: target }, 1000);
      const onlyTarget = filtered.rows.every((row) => str(row, "status") === target);
      const narrower = (filtered.total ?? filtered.rows.length) < (all.total ?? all.rows.length);
      return {
        verdict: onlyTarget && (narrower || statuses.length === 1) ? "confirmed" : "contradicted",
        finding:
          `Statuses seen: ${statuses.join(", ")}. status=${target}: ${filtered.rows.length} rows ` +
          `(${onlyTarget ? "all" : "not all"} with that status) of ${String(all.total)} in total.`,
        deviations: { "D-031": statuses.includes("350") ? "confirms" : "informs" },
      };
    },
  },
  {
    id: "read-transaction-date-filters",
    title: "Which date startDate/endDate compare on transactions, and their formats",
    mode: "read",
    question:
      "Do the transaction date filters cut by entryDate or valueDate, and do they take Unix seconds and ISO dates?",
    deviations: ["D-047", "D-016"],
    async run(ctx) {
      const rows = (await ctx.read.page("/CheckAccountTransaction", undefined, 1000)).rows;
      if (rows.length === 0) return inconclusive("No bank transactions in the account.");
      const differing = rows.find(
        (row) =>
          str(row, "valueDate").slice(0, 10) !== str(row, "entryDate").slice(0, 10) &&
          str(row, "entryDate") !== "",
      );
      const row = differing ?? rows[0];
      const id = str(row, "id");
      const contains = async (query: Record<string, string | number>): Promise<boolean> =>
        (await ctx.read.page("/CheckAccountTransaction", query, 1000)).rows.some(
          (item) => str(item, "id") === id,
        );
      const valueDay = str(row, "valueDate").slice(0, 10);
      const entryDay = str(row, "entryDate").slice(0, 10);
      const unix = berlinMidnight(valueDay);
      const formats = {
        unix: await contains({ startDate: unix, endDate: unix + 86_399 }),
        iso: await contains({ startDate: `${valueDay}T00:00:00`, endDate: `${valueDay}T23:59:59` }),
      };
      if (differing === undefined) {
        return inconclusive(
          `Every transaction has valueDate = entryDate, so the compared field cannot be told apart. ` +
            `A one-day window on the value date found the row with Unix seconds: ${formats.unix}, with ISO: ${formats.iso}.`,
        );
      }
      const byValue = formats.unix || formats.iso;
      const byEntry = await contains({
        startDate: berlinMidnight(entryDay),
        endDate: berlinMidnight(entryDay) + 86_399,
      });
      return {
        verdict: byEntry && !byValue ? "confirmed" : "contradicted",
        finding:
          `Transaction with valueDate ${valueDay} and entryDate ${entryDay}: a window on the value day ` +
          `finds it ${byValue ? "yes" : "no"} (Unix ${formats.unix}, ISO ${formats.iso}); a window on the entry day: ${byEntry ? "yes" : "no"}.`,
        deviations: { "D-016": "informs" },
      };
    },
  },
  {
    id: "read-document-date-strictness",
    title: "startDate/endDate on document lists: inclusive or strict",
    mode: "read",
    question:
      "Does GET /Invoice?startDate=<00:00 Berlin of the invoice date> include that invoice; does endDate=<same instant>?",
    deviations: ["D-046"],
    async run(ctx) {
      const invoice = await ctx.read.first(
        "/Invoice",
        undefined,
        (row) => str(row, "invoiceDate") !== "",
      );
      if (invoice === undefined)
        return inconclusive("No invoice with an invoice date in the account.");
      const id = str(invoice, "id");
      const day = str(invoice, "invoiceDate").slice(0, 10);
      const midnight = berlinMidnight(day);
      const contains = async (query: Record<string, string | number>): Promise<boolean> =>
        (await ctx.read.page("/Invoice", query, 1000)).rows.some((row) => str(row, "id") === id);
      const startAtMidnight = await contains({ startDate: midnight });
      const startOneSecondLater = await contains({ startDate: midnight + 1 });
      const endAtMidnight = await contains({ endDate: midnight });
      const endOneSecondEarlier = await contains({ endDate: midnight - 1 });
      const germanStart = await contains({
        startDate: `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`,
      });
      return {
        verdict: "observed",
        finding:
          `Invoice dated ${str(invoice, "invoiceDate")}: startDate=00:00 Berlin → ${startAtMidnight ? "included" : "excluded"}; ` +
          `startDate=00:00:01 → ${startOneSecondLater ? "included" : "excluded"}; endDate=00:00 → ${endAtMidnight ? "included" : "excluded"}; ` +
          `endDate=23:59:59 the day before → ${endOneSecondEarlier ? "included" : "excluded"}; startDate as dd.mm.yyyy → ${germanStart ? "included" : "excluded"}. ` +
          `Inclusive bounds means ${startAtMidnight && endAtMidnight ? "yes" : "no"}.`,
      };
    },
  },
  {
    id: "read-update-after",
    title: "updateAfter: honored where, unit and strictness",
    mode: "read",
    question:
      "Which lists honor updateAfter (Unix seconds), is the bound strict, and do /CreditNote and /CheckAccountTransaction accept it?",
    deviations: ["D-048"],
    async run(ctx) {
      const future = ctx.nowSeconds + 86_400;
      const subjects = [
        "/Contact",
        "/Invoice",
        "/Order",
        "/Voucher",
        "/CreditNote",
        "/CheckAccountTransaction",
      ];
      const honored: string[] = [];
      const ignored: string[] = [];
      const empty: string[] = [];
      for (const path of subjects) {
        const all = await ctx.read.total(path, path === "/Contact" ? { depth: 1 } : {});
        if (!all) {
          empty.push(path);
          continue;
        }
        const filtered = await ctx.read.total(path, {
          ...(path === "/Contact" ? { depth: 1 } : {}),
          updateAfter: future,
        });
        (filtered === 0 ? honored : ignored).push(path);
      }
      let strictness = "no invoice to test strictness";
      const invoice = await ctx.read.first(
        "/Invoice",
        undefined,
        (row) => str(row, "update") !== "",
      );
      if (invoice !== undefined) {
        const updated = Math.floor(Date.parse(str(invoice, "update")) / 1000);
        const id = str(invoice, "id");
        const contains = async (after: number): Promise<boolean> =>
          (await ctx.read.page("/Invoice", { updateAfter: after }, 1000)).rows.some(
            (row) => str(row, "id") === id,
          );
        const atSame = await contains(updated);
        const before = await contains(updated - 1);
        const millis = await ctx.read.total("/Invoice", { updateAfter: updated * 1000 });
        strictness =
          `invoice updated at ${str(invoice, "update")}: updateAfter=<that second> → ${atSame ? "included (inclusive)" : "excluded (strict)"}, ` +
          `one second earlier → ${before ? "included" : "excluded"}; the same instant in milliseconds → total ${String(millis)}`;
      }
      return {
        verdict: "observed",
        finding:
          `A future updateAfter empties: ${honored.join(", ") || "none"}; is ignored by: ${ignored.join(", ") || "none"}; ` +
          `no rows to tell: ${empty.join(", ") || "none"}. ${strictness}.`,
      };
    },
  },
  {
    id: "read-list-defaults",
    title: "Default lists vs showWkr/showMa/showAll and noRv; reminder sums",
    mode: "read",
    question:
      "Does GET /Invoice leave recurring templates (WKR) and reminders (MA) out by default, does GET /Voucher include RV, and do MA rows carry sums that would double-count?",
    deviations: ["D-049"],
    async run(ctx) {
      const totals = {
        default: await ctx.read.total("/Invoice"),
        showWkr: await ctx.read.total("/Invoice", { showWkr: "all" }),
        showMa: await ctx.read.total("/Invoice", { showMa: "all" }),
        showAll: await ctx.read.total("/Invoice", { showAll: "true" }),
      };
      const defaultTypes = new Set(
        (await ctx.read.page("/Invoice", undefined, 1000)).rows.map((row) =>
          str(row, "invoiceType"),
        ),
      );
      const reminders = (await ctx.read.page("/Invoice", { showMa: "all" }, 1000)).rows.filter(
        (row) => str(row, "invoiceType") === "MA",
      );
      const sums: string[] = [];
      for (const reminder of reminders.slice(0, 3)) {
        const originId = refId(reminder, "origin");
        const origin =
          originId === undefined ? undefined : await ctx.read.byId("Invoice", originId);
        sums.push(
          `MA ${str(reminder, "id")}: sumGross ${str(reminder, "sumGross")}, status ${str(reminder, "status")}, ` +
            `origin ${originId === undefined ? "none" : `${originId} (sumGross ${str(origin, "sumGross")})`}`,
        );
      }
      const vouchers = {
        default: await ctx.read.total("/Voucher"),
        noRv: await ctx.read.total("/Voucher", { noRv: "true" }),
      };
      const voucherTypes = new Set(
        (await ctx.read.page("/Voucher", undefined, 1000)).rows.map((row) =>
          str(row, "voucherType"),
        ),
      );
      return {
        verdict: "observed",
        finding:
          `Invoice totals: default ${String(totals.default)}, showWkr=all ${String(totals.showWkr)}, showMa=all ${String(totals.showMa)}, ` +
          `showAll=true ${String(totals.showAll)}; types in the default list: ${[...defaultTypes].join(", ") || "none"}. ` +
          `${sums.length > 0 ? `Reminders: ${sums.join("; ")}.` : "No reminder (MA) invoices to inspect."} ` +
          `Voucher totals: default ${String(vouchers.default)}, noRv=true ${String(vouchers.noRv)}; types in the default list: ${[...voucherTypes].join(", ") || "none"}.`,
      };
    },
  },
  {
    id: "read-account-datev",
    title: "Shape of /AccountDatev",
    mode: "read",
    question:
      "What does GET /AccountDatev (undocumented) return: keys and scalar types of a row, and GET by id?",
    deviations: ["D-024"],
    async run(ctx) {
      const page = await ctx.read.page("/AccountDatev", undefined, 5);
      if (!page.result.ok) {
        return {
          verdict: "contradicted",
          finding: `GET /AccountDatev failed: ${String(page.result.status)} ${page.result.message ?? ""}.`,
        };
      }
      const first = page.rows[0];
      if (first === undefined) return inconclusive("GET /AccountDatev returned no rows.");
      const byId = await ctx.read.byId("AccountDatev", Number(first["id"]));
      return {
        verdict: "confirmed",
        finding:
          `${String(page.total)} accounts. Row keys: ${Object.keys(first).join(", ")}. ` +
          `Types: ${typesOf([first], Object.keys(first))}. GET by id: ${byId === undefined ? "no row" : "one row"}.`,
      };
    },
  },
  {
    id: "read-credit-note-statuses",
    title: "Credit note statuses 300 and 500",
    mode: "read",
    question:
      "Does GET /CreditNote accept status=300/500, and do credit notes ever have statuses other than 100/200/750/1000?",
    deviations: ["D-038"],
    async run(ctx) {
      const s300 = await ctx.read.page("/CreditNote", { status: 300 }, 10);
      const s500 = await ctx.read.page("/CreditNote", { status: 500 }, 10);
      const all = await ctx.read.page("/CreditNote", undefined, 1000);
      const statuses = [...new Set(all.rows.map((row) => str(row, "status")))].sort();
      const unusual = statuses.filter((status) => !["100", "200", "750", "1000"].includes(status));
      return {
        verdict: unusual.length === 0 ? "confirmed" : "contradicted",
        finding:
          `status=300: ${s300.result.ok ? `${s300.rows.length} rows` : String(s300.result.status)}; ` +
          `status=500: ${s500.result.ok ? `${s500.rows.length} rows` : String(s500.result.status)}; ` +
          `statuses among ${all.rows.length} credit notes: ${statuses.join(", ") || "none"}.`,
      };
    },
  },
  {
    id: "read-credit-note-pos-objectname",
    title: "creditNote[objectName] casing on /CreditNotePos",
    mode: "read",
    question:
      "Does the CreditNotePos filter work with objectName CreditNote and with the spec's creditNote?",
    deviations: ["D-040"],
    async run(ctx) {
      const creditNote = await ctx.read.first("/CreditNote", undefined);
      if (creditNote === undefined) return inconclusive("No credit note in the account.");
      const id = str(creditNote, "id");
      const check = async (objectName: string) => {
        const page = await ctx.read.page(
          "/CreditNotePos",
          { "creditNote[id]": id, "creditNote[objectName]": objectName },
          100,
        );
        const own = page.rows.filter((row) => String(refId(row, "creditNote")) === id).length;
        return { ok: page.result.ok, rows: page.rows.length, own, status: page.result.status };
      };
      const upper = await check("CreditNote");
      const lower = await check("creditNote");
      const describe = (result: typeof upper): string =>
        result.ok
          ? `${result.rows} rows, ${result.own} of this credit note`
          : `refused (${String(result.status)})`;
      const upperWorks = upper.ok && upper.rows > 0 && upper.own === upper.rows;
      return {
        verdict: upperWorks ? "confirmed" : "inconclusive",
        finding: `Credit note ${id}: objectName=CreditNote → ${describe(upper)}; objectName=creditNote → ${describe(lower)}.`,
      };
    },
  },
  {
    id: "read-invoice-filters",
    title: "invoiceType and invoiceNumber filters on /Invoice",
    mode: "read",
    question:
      "Is invoiceType honored (RE, SR), and does invoiceNumber match exactly, by prefix or case-insensitively?",
    deviations: ["D-015", "D-035"],
    async run(ctx) {
      const re = await ctx.read.page("/Invoice", { invoiceType: "RE" }, 1000);
      const sr = await ctx.read.page("/Invoice", { invoiceType: "SR" }, 1000);
      const reOnly = re.rows.every((row) => str(row, "invoiceType") === "RE");
      const srOnly = sr.rows.every((row) => str(row, "invoiceType") === "SR");
      const numbered = re.rows.find((row) => str(row, "invoiceNumber").length > 2);
      let numberFinding = "No numbered invoice to test the number filter.";
      if (numbered !== undefined) {
        const number = str(numbered, "invoiceNumber");
        const count = async (value: string) =>
          (await ctx.read.page("/Invoice", { invoiceNumber: value }, 1000)).rows.length;
        numberFinding =
          `invoiceNumber exact → ${await count(number)} rows, without its last character → ${await count(number.slice(0, -1))} rows, ` +
          `lower case → ${await count(number.toLowerCase())} rows.`;
      }
      const all = await ctx.read.total("/Invoice");
      return {
        verdict:
          re.rows.length > 0 && reOnly && srOnly && (re.total ?? 0) <= (all ?? 0)
            ? "confirmed"
            : "observed",
        finding:
          `invoiceType=RE: ${re.rows.length} rows (${reOnly ? "all RE" : "mixed types"}); invoiceType=SR: ${sr.rows.length} rows ` +
          `(${srOnly ? "all SR" : "mixed types"}); unfiltered total ${String(all)}. ${numberFinding}`,
        deviations: { "D-035": "informs" },
      };
    },
  },
  {
    id: "read-contact-address-filter",
    title: "contact[id] filter on /ContactAddress",
    mode: "read",
    question: "Does sevDesk honor the undocumented contact[id] filter on /ContactAddress?",
    deviations: ["D-032"],
    async run(ctx) {
      const all = await ctx.read.page("/ContactAddress", undefined, 1000);
      const owner = refId(all.rows[0], "contact");
      if (owner === undefined) return inconclusive("No contact address in the account.");
      const filtered = await ctx.read.page(
        "/ContactAddress",
        { "contact[id]": owner, "contact[objectName]": "Contact" },
        1000,
      );
      const own = filtered.rows.filter((row) => refId(row, "contact") === owner).length;
      const owners = new Set(all.rows.map((row) => refId(row, "contact")));
      return {
        verdict:
          own === filtered.rows.length &&
          (owners.size === 1 || filtered.rows.length < all.rows.length)
            ? "confirmed"
            : "contradicted",
        finding: `Filtered by contact ${owner}: ${filtered.rows.length} rows, ${own} of that contact; unfiltered: ${all.rows.length} rows of ${owners.size} contacts.`,
      };
    },
  },
  {
    id: "read-getxml-shapes",
    title: "getXml on a normal invoice, Content-Type and propertyIsEInvoice",
    mode: "read",
    question:
      "What does getXml return for a finalized invoice that is not an e-invoice (status, body, Content-Type); does GET /Invoice/{id} carry propertyIsEInvoice?",
    deviations: ["D-033", "D-034"],
    async run(ctx) {
      const invoice = await nonDraft(ctx, "Invoice");
      if (invoice === undefined) return inconclusive("No finalized invoice in the account.");
      const id = Number(invoice["id"]);
      const xml = await ctx.http.get(`/Invoice/${id}/getXml`);
      const detail = await ctx.read.byId("Invoice", id);
      const hasFlag = detail !== undefined && Object.hasOwn(detail, "propertyIsEInvoice");
      const body = xml.ok
        ? `2xx, Content-Type ${xml.contentType ?? "none"}, ${typeof xml.objects === "string" ? `objects is a string starting ${JSON.stringify(xml.objects.slice(0, 40))}` : `body ${xml.json === undefined ? "not JSON" : "JSON without an XML string"}`}`
        : `${String(xml.status ?? xml.kind)}: ${xml.message ?? ""}`;
      return {
        verdict: "observed",
        finding:
          `Invoice ${id} (status ${str(invoice, "status")}): getXml → ${body}. GET by id ` +
          `${hasFlag ? `has propertyIsEInvoice = ${JSON.stringify(detail["propertyIsEInvoice"])}` : "has no propertyIsEInvoice key"}.`,
        deviations: {
          "D-033": xml.ok ? "informs" : "confirms",
          "D-034": hasFlag ? "contradicts" : "confirms",
        },
      };
    },
  },
  {
    id: "read-getpdf-download",
    title: "getPdf with download=true, and the getPdf JSON keys",
    mode: "read",
    question:
      "Does download=true switch getPdf to a raw PDF body, does the JSON form carry content (not pdf), and does either change the document?",
    deviations: ["D-023", "D-025"],
    async run(ctx) {
      const invoice = await nonDraft(ctx, "Invoice");
      if (invoice === undefined)
        return inconclusive(
          "No finalized invoice in the account (drafts are not used for this read).",
        );
      const id = Number(invoice["id"]);
      const before = sendState(await ctx.read.byId("Invoice", id));
      const json = await ctx.http.get(`/Invoice/${id}/getPdf`, { preventSendBy: "true" });
      const raw = await ctx.http.get(`/Invoice/${id}/getPdf`, {
        preventSendBy: "true",
        download: "true",
      });
      const after = sendState(await ctx.read.byId("Invoice", id));
      const keys =
        json.objects !== null && typeof json.objects === "object" && !Array.isArray(json.objects)
          ? Object.keys(json.objects).join(", ")
          : typeof json.objects;
      const rawShape = raw.ok
        ? `Content-Type ${raw.contentType ?? "none"}, body ${raw.text?.startsWith("%PDF") === true ? "a raw PDF" : raw.json === undefined ? "not JSON" : "JSON"}`
        : String(raw.status ?? raw.kind);
      const changed = diffState(before, after);
      return {
        verdict: changed === "" ? "observed" : "contradicted",
        finding:
          `Invoice ${id}: JSON getPdf keys: ${keys}. download=true → ${rawShape}. ` +
          (changed === ""
            ? "Status, sendDate, sendType and update unchanged."
            : `Changed: ${changed}.`),
        deviations: { "D-023": changed === "" ? "confirms" : "contradicts", "D-025": "informs" },
      };
    },
  },
  {
    id: "read-getpdf-preview-finalized",
    title: "getPdf preview (preventSendBy=true) on finalized documents",
    mode: "read",
    question:
      "Does a getPdf preview leave a finalized invoice, credit note and order unchanged (status, sendDate, sendType, update)?",
    deviations: ["D-023", "B1"],
    async run(ctx) {
      const lines: string[] = [];
      let changed = false;
      let checked = 0;
      for (const objectName of ["Invoice", "CreditNote", "Order"]) {
        const row = await nonDraft(ctx, objectName);
        if (row === undefined) {
          lines.push(`${objectName}: none finalized`);
          continue;
        }
        const id = Number(row["id"]);
        const before = sendState(await ctx.read.byId(objectName, id));
        const pdf = await ctx.http.get(`/${objectName}/${id}/getPdf`, { preventSendBy: "true" });
        const after = sendState(await ctx.read.byId(objectName, id));
        const diff = diffState(before, after);
        checked += 1;
        changed ||= diff !== "";
        lines.push(
          `${objectName} ${id}: ${pdf.ok ? "PDF read" : `PDF refused (${String(pdf.status)})`}, ${diff === "" ? "unchanged" : `changed (${diff})`}`,
        );
      }
      if (checked === 0) return inconclusive(`${lines.join("; ")}.`);
      return { verdict: changed ? "contradicted" : "confirmed", finding: `${lines.join("; ")}.` };
    },
  },
  {
    id: "read-voucher-document-key",
    title: "document key on voucher reads",
    mode: "read",
    question: "Do GET /Voucher rows and GET /Voucher/{id} carry the document key?",
    deviations: ["D-044"],
    async run(ctx) {
      const voucher = await ctx.read.first("/Voucher", undefined);
      if (voucher === undefined) return inconclusive("No voucher in the account.");
      const detail = await ctx.read.byId("Voucher", Number(voucher["id"]));
      const listHas = Object.hasOwn(voucher, "document");
      const detailHas = detail !== undefined && Object.hasOwn(detail, "document");
      return {
        verdict: listHas ? "contradicted" : "confirmed",
        finding: `List row: ${listHas ? "has" : "no"} document key; GET by id: ${detailHas ? `has it (${JSON.stringify(detail["document"] ?? null)})` : "no document key"}.`,
      };
    },
  },
  {
    id: "read-related-objects-shape",
    title: "getRelatedObjects on Update 2.0",
    mode: "read",
    question:
      "Does GET /Order/{id}/getRelatedObjects return a list or an object with numeric keys on 2.0?",
    deviations: ["D-036"],
    async run(ctx) {
      const order = await ctx.read.first("/Order", undefined);
      if (order === undefined) return inconclusive("No order in the account.");
      const id = Number(order["id"]);
      const related = await ctx.http.get(`/Order/${id}/getRelatedObjects`, { includeItself: 0 });
      if (!related.ok)
        return {
          verdict: "observed",
          finding: `Order ${id}: refused (${String(related.status)}).`,
        };
      const shape = Array.isArray(related.objects)
        ? `a list of ${related.objects.length}`
        : related.objects !== null && typeof related.objects === "object"
          ? `an object with keys ${Object.keys(related.objects).join(", ") || "(none)"}`
          : typeof related.objects;
      return {
        verdict: "observed",
        finding: `Order ${id}: objects is ${shape} (system version ${ctx.systemVersion}).`,
      };
    },
  },
  {
    id: "read-number-placeholders",
    title: "Unexpanded placeholders in document numbers",
    mode: "read",
    question: "Do any invoice, credit note or order numbers contain %…% placeholders?",
    deviations: ["D-027"],
    async run(ctx) {
      const found: string[] = [];
      let total = 0;
      for (const [path, key] of [
        ["/Invoice", "invoiceNumber"],
        ["/CreditNote", "creditNoteNumber"],
        ["/Order", "orderNumber"],
      ] as const) {
        const rows = (await ctx.read.page(path, undefined, 1000)).rows;
        total += rows.length;
        for (const row of rows) {
          if (/%[^%]+%/.test(str(row, key))) found.push(`${path.slice(1)} ${str(row, "id")}`);
        }
      }
      if (total === 0) return inconclusive("No documents in the account.");
      return {
        verdict: "observed",
        finding: `${found.length} of ${total} documents have placeholders in their number${found.length > 0 ? `: ${found.join(", ")}` : ""}.`,
      };
    },
  },
  {
    id: "read-paid-amount-currency",
    title: "Currency of paidAmount on foreign-currency invoices",
    mode: "read",
    question:
      "On a foreign-currency invoice with a payment, does paidAmount follow sumGross (EUR) or sumGrossForeignCurrency?",
    deviations: ["D-043"],
    async run(ctx) {
      const invoice = await ctx.read.first(
        "/Invoice",
        undefined,
        (row) =>
          str(row, "currency") !== "EUR" &&
          str(row, "currency") !== "" &&
          Number(str(row, "paidAmount")) > 0,
        1000,
      );
      if (invoice === undefined)
        return inconclusive(
          "No foreign-currency invoice with a payment (the write probe creates one).",
        );
      return {
        verdict: "observed",
        finding:
          `Invoice ${str(invoice, "id")} in ${str(invoice, "currency")}: paidAmount ${str(invoice, "paidAmount")}, ` +
          `sumGross ${str(invoice, "sumGross")}, sumGrossForeignCurrency ${str(invoice, "sumGrossForeignCurrency")}, status ${str(invoice, "status")}.`,
      };
    },
  },
  {
    id: "read-rate-limit-burst",
    title: "Rate limiting under a burst",
    mode: "read",
    optIn: true,
    question:
      "Does sevDesk answer 429 (with Retry-After) when 40 light GETs arrive at about 20 per second?",
    deviations: ["D-022"],
    async run(ctx) {
      if (ctx.makeClient === undefined) return inconclusive("No client factory available.");
      let limited = 0;
      let retried = 0;
      let failed = 0;
      const client = ctx.makeClient(20, (event) => {
        if (event.type === "failure" && event.kind === "rate_limited") limited += 1;
        if (event.type === "retry" && event.kind === "rate_limited" && event.delayMs > 0)
          retried += 1;
      });
      const started = Date.now();
      await Promise.all(
        Array.from({ length: 40 }, async () => {
          try {
            await client.request({ method: "GET", path: "/Tools/bookkeepingSystemVersion" });
          } catch {
            failed += 1;
          }
        }),
      );
      return {
        verdict: limited > 0 ? "confirmed" : "observed",
        finding: `40 requests in ${Date.now() - started} ms: ${limited} attempts answered 429 (${retried} retried), ${failed} requests failed after retries.`,
      };
    },
  },
  {
    id: "read-origin-filter",
    title: "origin[id] filter on /Invoice and /CreditNote",
    mode: "read",
    question:
      "Do GET /Invoice and GET /CreditNote honor origin[id] + origin[objectName]=Invoice? For one contact, the filtered answer is compared with a local filter of the unfiltered list.",
    deviations: ["D-064", "D-039", "D-035"],
    async run(ctx) {
      const lines: string[] = [];
      let checked = 0;
      let honored = 0;
      for (const path of ["/Invoice", "/CreditNote"] as const) {
        const sample = await ctx.read.first(
          path,
          undefined,
          (row) =>
            refId(row, "origin") !== undefined &&
            str(row["origin"] as Row, "objectName") === "Invoice" &&
            refId(row, "contact") !== undefined,
          1000,
        );
        if (sample === undefined) {
          lines.push(`${path}: no row with an invoice as origin`);
          continue;
        }
        const originId = refId(sample, "origin") ?? 0;
        const contactId = refId(sample, "contact") ?? 0;
        const byContact = { "contact[id]": contactId, "contact[objectName]": "Contact" };
        const unfiltered = (await ctx.read.page(path, byContact, 1000)).rows.filter(
          (row) => refId(row, "contact") === contactId,
        );
        const expected = unfiltered
          .filter(
            (row) =>
              refId(row, "origin") === originId &&
              str(row["origin"] as Row, "objectName") === "Invoice",
          )
          .map((row) => str(row, "id"))
          .sort();
        const answered = (
          await ctx.read.page(
            path,
            { ...byContact, "origin[id]": originId, "origin[objectName]": "Invoice" },
            1000,
          )
        ).rows
          .filter((row) => refId(row, "contact") === contactId)
          .map((row) => str(row, "id"))
          .sort();
        const same = JSON.stringify(expected) === JSON.stringify(answered);
        checked += 1;
        if (same && expected.length < unfiltered.length) honored += 1;
        lines.push(
          `${path}, contact ${contactId}, origin Invoice ${originId}: filtered answer ${answered.length} rows, ` +
            `local filter of the ${unfiltered.length} unfiltered rows ${expected.length}` +
            (same
              ? expected.length < unfiltered.length
                ? " (same rows: honored)"
                : " (same rows, but every row has this origin: cannot tell)"
              : " (different rows: ignored or not exact)"),
        );
      }
      if (checked === 0) return inconclusive(`${lines.join("; ")}.`);
      return {
        verdict: honored === checked ? "confirmed" : "observed",
        finding: `${lines.join("; ")}.`,
        deviations: { "D-039": "informs", "D-035": "informs" },
      };
    },
  },
  {
    id: "read-cancellation-origin",
    title: "origin of cancellation invoices (SR)",
    mode: "read",
    question:
      "Does every cancellation invoice (SR) carry origin pointing to the invoice it cancels (objectName Invoice, an existing id)? Includes the SR invoices a write run created.",
    deviations: ["D-037"],
    async run(ctx) {
      const rows = new Map<string, Row>();
      for (const query of [{ invoiceType: "SR" }, undefined]) {
        for (const row of (await ctx.read.page("/Invoice", query, 1000)).rows) {
          if (str(row, "invoiceType") === "SR") rows.set(str(row, "id"), row);
        }
      }
      if (rows.size === 0)
        return inconclusive(
          "No cancellation invoice (SR); the write probe write-cancel-invoice creates one.",
        );
      let withOrigin = 0;
      let resolved = 0;
      let tagged = 0;
      let checkedTargets = 0;
      const missing: string[] = [];
      for (const row of rows.values()) {
        const originId = refId(row, "origin");
        if (originId === undefined || str(row["origin"] as Row, "objectName") !== "Invoice") {
          missing.push(str(row, "id"));
          continue;
        }
        withOrigin += 1;
        if (checkedTargets >= 10) continue;
        checkedTargets += 1;
        const original = await ctx.read.byId("Invoice", originId);
        if (original !== undefined) resolved += 1;
        if (str(original, "header").startsWith(RUN_TAG_PREFIX)) tagged += 1;
      }
      return {
        verdict: missing.length === 0 ? "confirmed" : "contradicted",
        finding:
          `${rows.size} SR invoices, ${withOrigin} with an origin Invoice${missing.length > 0 ? `, without: ${missing.join(", ")}` : ""}. ` +
          `Of ${checkedTargets} origins read, ${resolved} exist (${tagged} created by this tooling).`,
      };
    },
  },
  {
    id: "read-communication-way-type-filter",
    title: "type filter on /CommunicationWay",
    mode: "read",
    question: "Does GET /CommunicationWay honor type=EMAIL?",
    deviations: ["NEW", "D-035"],
    async run(ctx) {
      const all = await ctx.read.page("/CommunicationWay", undefined, 1000);
      if (all.rows.length === 0)
        return inconclusive("No communication ways (e-mail, phone) in the account.");
      const filtered = await ctx.read.page("/CommunicationWay", { type: "EMAIL" }, 1000);
      const emails = filtered.rows.filter((row) => str(row, "type") === "EMAIL").length;
      const types = [...new Set(all.rows.map((row) => str(row, "type")))].sort();
      const honored =
        emails === filtered.rows.length &&
        (types.length === 1 || filtered.rows.length < all.rows.length);
      return {
        verdict: honored ? "confirmed" : "contradicted",
        finding: `type=EMAIL: ${filtered.rows.length} rows, ${emails} of type EMAIL; unfiltered ${all.rows.length} rows of types ${types.join(", ")}.`,
        deviations: { "D-035": "informs" },
      };
    },
  },
  {
    id: "read-receipt-guidance-limit",
    title: "limit on /ReceiptGuidance/forAllAccounts",
    mode: "read",
    question:
      "Does GET /ReceiptGuidance/forAllAccounts honor limit, or does it always return every account (more than 100)?",
    deviations: ["NEW"],
    async run(ctx) {
      const count = async (query?: Record<string, number>) => {
        const result = await ctx.http.get("/ReceiptGuidance/forAllAccounts", query);
        return result.ok ? (Array.isArray(result.objects) ? result.objects.length : 1) : undefined;
      };
      const none = await count();
      const five = await count({ limit: 5 });
      const thousand = await count({ limit: 1000 });
      return {
        verdict: "observed",
        finding: `Rows without limit: ${String(none)}; limit=5: ${String(five)}; limit=1000: ${String(thousand)}.`,
      };
    },
  },
];
