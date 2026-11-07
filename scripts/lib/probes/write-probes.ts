/**
 * Write probes: they run only with `--allow-writes` plus `SEVDESK_LIVE_I_UNDERSTAND_WRITES=1`, on a
 * trial account, and create their own test data first (a contact named after the run tag and
 * documents whose header and internal note carry it). Every record they create is listed for
 * cleanup in the report. Drafts never carry a document number (regression B4): sevDesk assigns
 * numbers itself.
 *
 * Nothing here sends e-mails, enshrines or exports: those are listed as "not probed, manual".
 */
import { format, subtract } from "../../../src/domain/money.js";
import {
  addDays,
  berlinMidnight,
  createdId,
  diffState,
  type DocumentKind,
  germanDate,
  type ProbeContext,
  type ProbeDefinition,
  type ProbeOutcome,
  refId,
  type Row,
  sendState,
  str,
  type TestData,
} from "./core.js";

function data(ctx: ProbeContext): TestData {
  if (ctx.data === undefined) throw new Error("This probe needs write mode (--allow-writes).");
  return ctx.data;
}

const NUMBER_KEY: Readonly<Record<DocumentKind, string>> = {
  Invoice: "invoiceNumber",
  CreditNote: "creditNoteNumber",
  Order: "orderNumber",
};

/** How a document number looks: missing, a raw pattern with placeholders, or a real number. */
function numberShape(row: Row | undefined, kind: DocumentKind): string {
  const number = str(row, NUMBER_KEY[kind]);
  if (number === "") return "no number (null/empty)";
  if (/%[^%]+%/.test(number)) return `a placeholder pattern (${number})`;
  return `a number (${number})`;
}

/** Scalar fields that differ between two reads of one record. */
function changedFields(before: Row | undefined, after: Row | undefined): string {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    if (key === "update") continue;
    const a = JSON.stringify(before?.[key] ?? null);
    const b = JSON.stringify(after?.[key] ?? null);
    if (a !== b) changes.push(`${key}: ${a} → ${b}`);
  }
  return changes.join("; ");
}

/** Creates and finalizes a tagged invoice; the failure text when that is impossible. */
async function finalizedInvoice(
  ctx: ProbeContext,
  options: Parameters<TestData["draft"]>[1] = {},
): Promise<{ readonly id: number } | { readonly failure: string }> {
  const draft = await data(ctx).draft("Invoice", options);
  if (draft.id === undefined) {
    return {
      failure: `the draft invoice was refused (${draft.result.message ?? String(draft.result.status)})`,
    };
  }
  const finalized = await data(ctx).finalize("Invoice", draft.id);
  if (!finalized.ok) {
    return {
      failure: `finalizing invoice ${draft.id} failed (${finalized.message ?? String(finalized.status)})`,
    };
  }
  return { id: draft.id };
}

function inconclusive(finding: string): ProbeOutcome {
  return { verdict: "inconclusive", finding };
}

/** `PUT /<kind>/<id>/bookAmount` without a transaction (sevDesk books on the account itself). */
async function bookOn(
  ctx: ProbeContext,
  kind: "Invoice" | "CreditNote",
  id: number,
  checkAccount: number,
  amount: number,
  date: number | string,
  type: "N" | "FULL_PAYMENT" = "N",
) {
  return ctx.http.write("PUT", `/${kind}/${id}/bookAmount`, {
    tier: "commit",
    body: { amount, date, type, checkAccount: { id: checkAccount, objectName: "CheckAccount" } },
  });
}

async function book(
  ctx: ProbeContext,
  invoiceId: number,
  checkAccount: number,
  amount: number,
  date: number | string,
) {
  return bookOn(ctx, "Invoice", invoiceId, checkAccount, amount, date);
}

/** Unix seconds of 12:00 Europe/Berlin on `date` (what the payment tool sends). */
function berlinNoon(date: string): number {
  return berlinMidnight(date) + 12 * 3600;
}

/** An offline account or cash register (not an online bank account), if the account has one. */
async function offlineAccount(ctx: ProbeContext): Promise<Row | undefined> {
  return ctx.read.first(
    "/CheckAccount",
    undefined,
    (row) => str(row, "status") !== "0" && str(row, "type") !== "online",
  );
}

/** Transactions of one check account (up to 1,000). */
async function transactionsOf(ctx: ProbeContext, accountId: number): Promise<Row[]> {
  const page = await ctx.read.page(
    "/CheckAccountTransaction",
    { "checkAccount[id]": accountId, "checkAccount[objectName]": "CheckAccount" },
    1000,
  );
  return page.rows.filter((row) => refId(row, "checkAccount") === accountId);
}

/** A short description of a write answer's `objects`: list or object, and its keys. */
function shapeOf(objects: unknown): string {
  if (Array.isArray(objects)) {
    const first: unknown = objects[0];
    const keys =
      first !== null && typeof first === "object"
        ? ` of objects with keys ${Object.keys(first).join(", ")}`
        : "";
    return `a list of ${objects.length}${keys}`;
  }
  if (objects !== null && typeof objects === "object") {
    return `an object with keys ${Object.keys(objects).join(", ") || "(none)"}`;
  }
  return objects === null ? "null" : typeof objects;
}

function describeTransaction(row: Row | undefined): string {
  if (row === undefined) return "none";
  return (
    `${str(row, "id")} (amount ${str(row, "amount")}, status ${str(row, "status")}, ` +
    `valueDate ${str(row, "valueDate").slice(0, 10)}, entryDate ${str(row, "entryDate").slice(0, 10)})`
  );
}

export const WRITE_PROBES: readonly ProbeDefinition[] = [
  {
    id: "write-getpdf-preview-drafts",
    title: "getPdf preview (preventSendBy=true) on Update 2.0 drafts",
    mode: "write",
    question:
      "Does a getPdf preview leave a fresh draft invoice, credit note and offer (AN) a draft: status 100, no sendDate/sendType, update unchanged?",
    deviations: ["D-023", "B1"],
    async run(ctx) {
      const lines: string[] = [];
      let changed = false;
      let checked = 0;
      for (const kind of ["Invoice", "CreditNote", "Order"] as const) {
        const draft = await data(ctx).draft(kind);
        if (draft.id === undefined) {
          lines.push(
            `${kind}: draft refused (${draft.result.message ?? String(draft.result.status)})`,
          );
          continue;
        }
        const before = sendState(await ctx.read.byId(kind, draft.id));
        const pdf = await ctx.http.get(`/${kind}/${draft.id}/getPdf`, { preventSendBy: "true" });
        const after = sendState(await ctx.read.byId(kind, draft.id));
        const diff = diffState(before, after);
        checked += 1;
        if (diff !== "") {
          changed = true;
          data(ctx).mark(kind, draft.id, `changed by a preview (${diff})`);
        }
        lines.push(
          `${kind} ${draft.id}: ${pdf.ok ? "PDF read" : `PDF refused (${String(pdf.status)}: ${pdf.message ?? ""})`}, ` +
            (diff === "" ? `still a draft (status ${after["status"] ?? ""})` : `CHANGED: ${diff}`),
        );
      }
      if (checked === 0) return inconclusive(`${lines.join("; ")}.`);
      return {
        verdict: changed ? "contradicted" : "confirmed",
        finding: `System version ${ctx.systemVersion}. ${lines.join("; ")}.`,
      };
    },
  },
  {
    id: "write-numbering-order-draft",
    title: "Offer (AN) draft without orderNumber",
    mode: "write",
    question:
      "Does saveOrder (AN) accept a draft without orderNumber, and what number does the draft get (none, a %…% placeholder, a real number)?",
    deviations: ["D-027", "B4"],
    async run(ctx) {
      const draft = await data(ctx).draft("Order", { orderType: "AN" });
      if (draft.id === undefined) {
        return {
          verdict: "observed",
          finding: `saveOrder without orderNumber was refused: ${String(draft.result.status ?? draft.result.kind)} ${draft.result.message ?? ""}.`,
          deviations: { B4: "contradicts" },
        };
      }
      const row = await ctx.read.byId("Order", draft.id);
      return {
        verdict: "observed",
        finding: `saveOrder without orderNumber was accepted (order ${draft.id}, status ${str(row, "status")}); the draft has ${numberShape(row, "Order")}.`,
        deviations: { B4: "confirms" },
      };
    },
  },
  {
    id: "write-numbering-credit-note",
    title: "Credit note draft without creditNoteNumber, then sendBy",
    mode: "write",
    question:
      "Does saveCreditNote accept a draft without creditNoteNumber, and does finalizing (sendBy) assign a number or fail?",
    deviations: ["D-027", "B4"],
    async run(ctx) {
      const draft = await data(ctx).draft("CreditNote");
      if (draft.id === undefined) {
        return {
          verdict: "observed",
          finding: `saveCreditNote without creditNoteNumber was refused: ${String(draft.result.status ?? draft.result.kind)} ${draft.result.message ?? ""}.`,
          deviations: { B4: "contradicts" },
        };
      }
      const asDraft = await ctx.read.byId("CreditNote", draft.id);
      const finalized = await data(ctx).finalize("CreditNote", draft.id);
      const after = await ctx.read.byId("CreditNote", draft.id);
      return {
        verdict: "observed",
        finding:
          `Draft ${draft.id} accepted with ${numberShape(asDraft, "CreditNote")}. sendBy: ` +
          `${finalized.ok ? `ok, now status ${str(after, "status")} with ${numberShape(after, "CreditNote")}` : `failed (${String(finalized.status)}: ${finalized.message ?? ""})`}.`,
      };
    },
  },
  {
    id: "write-numbering-invoice",
    title: "Invoice draft without invoiceNumber, then sendBy",
    mode: "write",
    question:
      "Does saveInvoice accept a draft without invoiceNumber, and does finalizing (sendBy) assign the number?",
    deviations: ["D-027", "B4"],
    async run(ctx) {
      const draft = await data(ctx).draft("Invoice");
      if (draft.id === undefined) {
        return inconclusive(
          `The draft invoice was refused: ${draft.result.message ?? String(draft.result.status)}.`,
        );
      }
      const asDraft = await ctx.read.byId("Invoice", draft.id);
      const finalized = await data(ctx).finalize("Invoice", draft.id);
      const after = await ctx.read.byId("Invoice", draft.id);
      const assigned =
        finalized.ok &&
        str(after, "invoiceNumber") !== "" &&
        !/%[^%]+%/.test(str(after, "invoiceNumber"));
      return {
        verdict: assigned ? "confirmed" : "contradicted",
        finding:
          `Draft ${draft.id} has ${numberShape(asDraft, "Invoice")}. sendBy: ` +
          `${finalized.ok ? `ok, status ${str(after, "status")}, ${numberShape(after, "Invoice")}` : `failed (${String(finalized.status)}: ${finalized.message ?? ""})`}.`,
      };
    },
  },
  {
    id: "write-next-order-number",
    title: "getNextOrderNumber with useNextNumber=false",
    mode: "write",
    question:
      "Does GET /Order/Factory/getNextOrderNumber?orderType=AN&useNextNumber=false return the next number without advancing the sequence? " +
      "(Runs only in write mode: if sevDesk ignored the flag, every call would consume a number.)",
    deviations: ["D-027", "D-024"],
    async run(ctx) {
      const query = { orderType: "AN", useNextNumber: "false" };
      const first = await ctx.http.get("/Order/Factory/getNextOrderNumber", query);
      const second = await ctx.http.get("/Order/Factory/getNextOrderNumber", query);
      if (!first.ok || !second.ok) {
        return {
          verdict: "observed",
          finding: `Refused: ${String(first.status ?? first.kind)} ${first.message ?? ""} / ${String(second.status ?? second.kind)}.`,
        };
      }
      const a = JSON.stringify(first.objects ?? null);
      const b = JSON.stringify(second.objects ?? null);
      return {
        verdict: "observed",
        finding: `First call: ${a}; second call: ${b}; ${a === b ? "the same number, so the sequence did not advance" : "different numbers: the call advances the sequence"}.`,
      };
    },
  },
  {
    id: "write-delete-draft-invoice",
    title: "DELETE /Invoice/{id} on a draft",
    mode: "write",
    question: "Does the undocumented DELETE /Invoice/{id} delete a draft invoice?",
    deviations: ["D-024"],
    async run(ctx) {
      const draft = await data(ctx).draft("Invoice");
      if (draft.id === undefined)
        return inconclusive(`The draft invoice was refused: ${draft.result.message ?? ""}.`);
      const deleted = await ctx.http.write("DELETE", `/Invoice/${draft.id}`, { tier: "write" });
      const after = await ctx.http.get(`/Invoice/${draft.id}`);
      const gone =
        (!after.ok && (after.status === 400 || after.status === 404)) ||
        (after.ok && Array.isArray(after.objects) && after.objects.length === 0);
      if (gone) data(ctx).mark("Invoice", draft.id, "deleted by the probe");
      return {
        verdict: "observed",
        finding:
          `DELETE: ${deleted.ok ? "2xx" : `${String(deleted.status ?? deleted.kind)} ${deleted.message ?? ""}`}; ` +
          `GET afterwards: ${after.ok ? (gone ? "empty list" : "still there") : String(after.status)}. ${gone ? "Drafts can be deleted." : "The draft still exists."}`,
      };
    },
  },
  {
    id: "write-position-price-fields",
    title: "Which position price field sevDesk honors (showNet on/off)",
    mode: "write",
    question:
      "Does a position `price` follow the document's showNet (net 100 with showNet=true and gross 119 with showNet=false both give sumNet 100 / sumGross 119), and what do lone priceNet / priceGross do?",
    deviations: ["B8", "NEW", "D-003"],
    async run(ctx) {
      const cases = [
        { label: "price=100, showNet=true", showNet: true, position: { price: 100 }, core: true },
        { label: "price=119, showNet=false", showNet: false, position: { price: 119 }, core: true },
        {
          label: "priceNet=100 only, showNet=true",
          showNet: true,
          position: { priceNet: 100 },
          core: false,
        },
        {
          label: "priceGross=119 only, showNet=false",
          showNet: false,
          position: { priceGross: 119 },
          core: false,
        },
      ];
      const lines: string[] = [];
      let coreMatches = 0;
      for (const item of cases) {
        const draft = await data(ctx).draft("Invoice", {
          showNet: item.showNet,
          positions: [item.position],
        });
        if (draft.id === undefined) {
          lines.push(
            `${item.label}: draft refused (${draft.result.message ?? String(draft.result.status)})`,
          );
          continue;
        }
        const invoice = await ctx.read.byId("Invoice", draft.id);
        const position = (
          await ctx.read.page(
            "/InvoicePos",
            { "invoice[id]": draft.id, "invoice[objectName]": "Invoice" },
            10,
          )
        ).rows.find((row) => refId(row, "invoice") === draft.id);
        const sums = {
          net: Number(str(invoice, "sumNet")),
          gross: Number(str(invoice, "sumGross")),
        };
        if (item.core && sums.net === 100 && sums.gross === 119) coreMatches += 1;
        lines.push(
          `${item.label} → invoice ${draft.id} sumNet ${str(invoice, "sumNet")}, sumGross ${str(invoice, "sumGross")}; ` +
            `position price ${str(position, "price")}, priceNet ${str(position, "priceNet")}, priceGross ${str(position, "priceGross")}`,
        );
      }
      return {
        verdict: coreMatches === 2 ? "confirmed" : "contradicted",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-003": "informs" },
      };
    },
  },
  {
    id: "write-unknown-field",
    title: "Unknown request fields",
    mode: "write",
    question: "Does POST /Contact accept an unknown field without an error and drop it?",
    deviations: ["D-003"],
    async run(ctx) {
      const result = await ctx.http.write("POST", "/Contact", {
        tier: "write",
        body: {
          name: `${data(ctx).tag} unknown-field`,
          category: { id: 3, objectName: "Category" },
          status: 1000,
          mcpProbeUnknownField: "dropped?",
        },
      });
      const id = createdId(result.objects);
      if (id === undefined) {
        return {
          verdict: "contradicted",
          finding: `Refused: ${String(result.status ?? result.kind)} ${result.message ?? ""}.`,
        };
      }
      data(ctx).register("Contact", id, "active (can be deleted in the web app)");
      const row = await ctx.read.byId("Contact", id, { depth: 1 });
      const kept = row !== undefined && Object.hasOwn(row, "mcpProbeUnknownField");
      return {
        verdict: kept ? "contradicted" : "confirmed",
        finding: `Accepted (contact ${id}); the unknown field is ${kept ? "present" : "absent"} on read-back.`,
      };
    },
  },
  {
    id: "write-book-amount",
    title: "Booking payments on an invoice: response shape and date formats",
    mode: "write",
    question:
      "What does PUT /Invoice/{id}/bookAmount return, which date formats does it take (Unix seconds, dd.mm.yyyy), and how do status and paidAmount move (partial → paid)?",
    deviations: ["D-013", "D-018", "B7"],
    async run(ctx) {
      const checkAccount = await data(ctx).checkAccount();
      if (checkAccount === undefined) {
        return inconclusive(
          "No check account: create a cash register (Kasse) in the web app first.",
        );
      }
      const invoice = await finalizedInvoice(ctx);
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const id = invoice.id;
      const first = await book(ctx, id, checkAccount, 50, berlinNoon(ctx.today));
      const partial = await ctx.read.byId("Invoice", id);
      const responseKeys =
        first.objects !== null && typeof first.objects === "object"
          ? Object.keys(
              Array.isArray(first.objects)
                ? ((first.objects[0] as Row | undefined) ?? {})
                : first.objects,
            ).join(", ")
          : typeof first.objects;
      // Decimal-safe: never float arithmetic on money.
      const rest = Number(format(subtract(str(partial, "sumGross") || "0", "50"), 2));
      let second = await book(ctx, id, checkAccount, rest, germanDate(ctx.today));
      const germanAccepted = second.ok;
      if (!second.ok) second = await book(ctx, id, checkAccount, rest, berlinNoon(ctx.today));
      const paid = await ctx.read.byId("Invoice", id);
      if (second.ok) data(ctx).mark("Invoice", id, "finalized and paid (cannot be deleted)");
      return {
        verdict: "observed",
        finding:
          `Invoice ${id} (gross ${str(partial, "sumGross")}): booking 50 with a Unix date → ${first.ok ? "ok" : `failed (${String(first.status)}: ${first.message ?? ""})`}, ` +
          `response keys: ${responseKeys}; then status ${str(partial, "status")}, paidAmount ${str(partial, "paidAmount")}. ` +
          `Booking the rest (${rest}) with date dd.mm.yyyy → ${germanAccepted ? "accepted" : "refused, retried with a Unix date"}; ` +
          `final status ${str(paid, "status")}, paidAmount ${str(paid, "paidAmount")}, payDate ${str(paid, "payDate") || "none"}.`,
      };
    },
  },
  {
    id: "write-cancel-invoice",
    title: "Cancelling (Storno) an open invoice and the filters that find it",
    mode: "write",
    question:
      "After cancelInvoice: what changes on the original (status, paidAmount, payDate, other fields), what does the SR invoice look like, and do invoiceType=SR / status=1000 find them?",
    deviations: ["D-037", "D-015"],
    async run(ctx) {
      const invoice = await finalizedInvoice(ctx);
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const id = invoice.id;
      const before = await ctx.read.byId("Invoice", id);
      const cancelled = await ctx.http.write("POST", `/Invoice/${id}/cancelInvoice`, {
        tier: "commit",
      });
      if (!cancelled.ok) {
        return {
          verdict: "observed",
          finding: `cancelInvoice failed: ${String(cancelled.status)} ${cancelled.message ?? ""}.`,
        };
      }
      data(ctx).mark("Invoice", id, "cancelled (cannot be deleted)");
      const after = await ctx.read.byId("Invoice", id);
      const srId = createdId(cancelled.objects, "invoice");
      const sr = srId === undefined ? undefined : await ctx.read.byId("Invoice", srId);
      if (srId !== undefined)
        data(ctx).register("Invoice", srId, "cancellation invoice (SR, cannot be deleted)");
      const srListed =
        srId !== undefined &&
        (await ctx.read.page("/Invoice", { invoiceType: "SR" }, 1000)).rows.some(
          (row) => Number(row["id"]) === srId,
        );
      const originalListed = (await ctx.read.page("/Invoice", { status: 1000 }, 1000)).rows.some(
        (row) => Number(row["id"]) === id,
      );
      const keepsPaid = str(after, "status") === "1000";
      return {
        verdict: keepsPaid ? "confirmed" : "contradicted",
        finding:
          `Original ${id}: ${changedFields(before, after) || "no field changed"}. ` +
          `SR ${srId ?? "(no id in the response)"}: type ${str(sr, "invoiceType")}, status ${str(sr, "status")}, sumGross ${str(sr, "sumGross")}, ` +
          `origin ${refId(sr, "origin") ?? "none"}. invoiceType=SR lists the SR: ${srListed}; status=1000 lists the original: ${originalListed}.`,
        deviations: { "D-015": "informs" },
      };
    },
  },
  {
    id: "write-credit-note-from-invoice",
    title: "Credit note from an invoice",
    mode: "write",
    question:
      "What does createFromInvoice create: status, creditNoteType, origin vs refSrcInvoice, sums?",
    deviations: ["D-039", "NEW"],
    async run(ctx) {
      const invoice = await finalizedInvoice(ctx);
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const result = await ctx.http.write("POST", "/CreditNote/Factory/createFromInvoice", {
        tier: "write",
        body: { invoice: { id: invoice.id, objectName: "Invoice" } },
      });
      const id = createdId(result.objects, "creditNote");
      if (!result.ok || id === undefined) {
        return {
          verdict: "observed",
          finding: `createFromInvoice failed: ${String(result.status ?? result.kind)} ${result.message ?? ""}.`,
        };
      }
      data(ctx).register("CreditNote", id, "draft (deletable in the web app)");
      const row = await ctx.read.byId("CreditNote", id);
      const hasOrigin = refId(row, "origin") === invoice.id;
      return {
        verdict: hasOrigin ? "confirmed" : "observed",
        finding:
          `Answer: ${shapeOf(result.objects)}. Credit note ${id} from open invoice ${invoice.id}: status ${str(row, "status")}, creditNoteType ${str(row, "creditNoteType")}, ` +
          `origin ${refId(row, "origin") ?? "none"}, refSrcInvoice ${str(row, "refSrcInvoice") || "none"}, sumGross ${str(row, "sumGross")}, ` +
          `number: ${numberShape(row, "CreditNote")}.`,
      };
    },
  },
  {
    id: "write-reminder",
    title: "Dunning (Mahnung) on an overdue invoice",
    mode: "write",
    question:
      "What does createInvoiceReminder answer and create (type, status, sums vs the original, origin, dunningLevel), does it need the invoice in the query, the body or both, and does the default invoice list include the reminder?",
    deviations: ["D-049", "NEW"],
    async run(ctx) {
      const variants = [
        { label: "query + body", query: true, body: true },
        { label: "query only", query: true, body: false },
        { label: "body only", query: false, body: true },
      ] as const;
      const lines: string[] = [];
      let listed = "";
      for (const variant of variants) {
        const invoice = await finalizedInvoice(ctx, {
          date: addDays(ctx.today, -30),
          timeToPay: 7,
        });
        if ("failure" in invoice) {
          lines.push(`${variant.label}: could not prepare (${invoice.failure})`);
          continue;
        }
        const result = await ctx.http.write("POST", "/Invoice/Factory/createInvoiceReminder", {
          tier: "write",
          ...(variant.query
            ? { query: { "invoice[id]": invoice.id, "invoice[objectName]": "Invoice" } }
            : {}),
          ...(variant.body ? { body: { invoice: { id: invoice.id, objectName: "Invoice" } } } : {}),
        });
        const id = createdId(result.objects, "invoice");
        if (!result.ok || id === undefined) {
          lines.push(
            `${variant.label}: refused (${String(result.status ?? result.kind)}: ${result.message ?? ""})`,
          );
          continue;
        }
        data(ctx).register("Invoice", id, "reminder (MA) draft");
        const reminder = await ctx.read.byId("Invoice", id);
        const original = await ctx.read.byId("Invoice", invoice.id);
        lines.push(
          `${variant.label}: answer ${shapeOf(result.objects)}; reminder ${id} type ${str(reminder, "invoiceType")}, status ${str(reminder, "status")}, ` +
            `sumGross ${str(reminder, "sumGross")} (original ${invoice.id}: ${str(original, "sumGross")}), origin ${str(reminder, "origin") || "none"}, ` +
            `dunningLevel ${str(reminder, "dunningLevel") || "none"}`,
        );
        if (listed === "") {
          const inDefault = (await ctx.read.page("/Invoice", undefined, 1000)).rows.some(
            (row) => Number(row["id"]) === id,
          );
          const inShowMa = (await ctx.read.page("/Invoice", { showMa: "all" }, 1000)).rows.some(
            (row) => Number(row["id"]) === id,
          );
          listed = `Reminder ${id} in the default list: ${inDefault}; with showMa=all: ${inShowMa}.`;
        }
      }
      return { verdict: "observed", finding: `${lines.join(". ")}. ${listed}`.trim() };
    },
  },
  {
    id: "write-paid-amount-foreign-currency",
    title: "paidAmount on a foreign-currency invoice",
    mode: "write",
    question:
      "After booking 10.00 on a USD invoice, does paidAmount follow sumGross (EUR) or sumGrossForeignCurrency?",
    deviations: ["D-043"],
    async run(ctx) {
      const checkAccount = await data(ctx).checkAccount();
      if (checkAccount === undefined)
        return inconclusive("No check account: create a cash register (Kasse) first.");
      const invoice = await finalizedInvoice(ctx, { currency: "USD" });
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const booked = await book(ctx, invoice.id, checkAccount, 10, berlinNoon(ctx.today));
      const row = await ctx.read.byId("Invoice", invoice.id);
      if (booked.ok)
        data(ctx).mark("Invoice", invoice.id, "finalized, partly paid (cannot be deleted)");
      return {
        verdict: "observed",
        finding:
          `USD invoice ${invoice.id}: booking 10 → ${booked.ok ? "ok" : `failed (${String(booked.status)}: ${booked.message ?? ""})`}; ` +
          `currency ${str(row, "currency")}, paidAmount ${str(row, "paidAmount")}, sumGross ${str(row, "sumGross")}, ` +
          `sumGrossForeignCurrency ${str(row, "sumGrossForeignCurrency")}, status ${str(row, "status")}.`,
      };
    },
  },
  {
    id: "write-validation-status",
    title: "HTTP status of a validation error",
    mode: "write",
    question:
      "Does saveInvoice without required fields fail with 422, 400 or 500, and with which message?",
    deviations: ["D-021"],
    async run(ctx) {
      const result = await ctx.http.write("POST", "/Invoice/Factory/saveInvoice", {
        tier: "write",
        body: {
          invoice: { objectName: "Invoice", mapAll: true, header: `${data(ctx).tag} invalid` },
          invoicePosSave: [],
        },
      });
      if (result.ok) {
        const id = createdId(result.objects, "invoice");
        if (id !== undefined)
          data(ctx).register("Invoice", id, "draft created by an invalid payload (deletable)");
        return {
          verdict: "contradicted",
          finding: `sevDesk accepted an invoice without required fields${id === undefined ? "" : ` (id ${id})`}.`,
        };
      }
      return {
        verdict: result.status === 500 ? "confirmed" : "observed",
        finding: `Refused with ${String(result.status ?? result.kind)} (${result.kind ?? "error"}): ${result.message ?? "no message"}.`,
      };
    },
  },
  {
    id: "write-credit-note-payout-sign",
    title: "Sign of a credit note payout (bookAmount)",
    mode: "write",
    question:
      "Does PUT /CreditNote/{id}/bookAmount with a negative amount pay a finalized credit note out (status 1000), and what does a positive amount do?",
    deviations: ["NEW", "D-041"],
    async run(ctx) {
      const account = await data(ctx).checkAccount();
      if (account === undefined)
        return inconclusive("No check account: create a cash register (Kasse) first.");
      const lines: string[] = [];
      let negativePays = false;
      for (const sign of ["negative", "positive"] as const) {
        const draft = await data(ctx).draft("CreditNote");
        if (draft.id === undefined) {
          lines.push(
            `${sign}: credit note draft refused (${draft.result.message ?? String(draft.result.status)})`,
          );
          continue;
        }
        const finalized = await data(ctx).finalize("CreditNote", draft.id);
        const before = await ctx.read.byId("CreditNote", draft.id);
        const gross = str(before, "sumGross") || "0";
        const amount = Number(
          sign === "negative" ? `-${gross.replace(/^-/, "")}` : gross.replace(/^-/, ""),
        );
        const booked = await bookOn(
          ctx,
          "CreditNote",
          draft.id,
          account,
          amount,
          berlinNoon(ctx.today),
        );
        const after = await ctx.read.byId("CreditNote", draft.id);
        if (booked.ok)
          data(ctx).mark("CreditNote", draft.id, `finalized, booked ${amount} (cannot be deleted)`);
        if (sign === "negative" && booked.ok && str(after, "status") === "1000")
          negativePays = true;
        lines.push(
          `${sign} ${amount} on credit note ${draft.id} (finalize ${finalized.ok ? "ok" : "failed"}): ` +
            `${booked.ok ? "accepted" : `refused (${String(booked.status)}: ${booked.message ?? ""})`}, ` +
            `status ${str(before, "status")} → ${str(after, "status")}, payDate ${str(after, "payDate") || "none"}`,
        );
      }
      return {
        verdict: negativePays ? "confirmed" : "observed",
        finding: `${lines.join("; ")}.`,
        deviations: { "D-041": "informs" },
      };
    },
  },
  {
    id: "write-book-amount-noon-date",
    title: "Which calendar day a bookAmount date of 12:00 Berlin lands on",
    mode: "write",
    question:
      "When bookAmount gets date = Unix seconds of 12:00 Europe/Berlin three days ago, do the invoice's payDate and the booking (log, created transaction) carry that calendar day?",
    deviations: ["NEW", "D-018"],
    async run(ctx) {
      const account = await data(ctx).checkAccount();
      if (account === undefined)
        return inconclusive("No check account: create a cash register (Kasse) first.");
      const invoice = await finalizedInvoice(ctx);
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const day = addDays(ctx.today, -3);
      const before = await ctx.read.byId("Invoice", invoice.id);
      const transactionsBefore = new Set(
        (await transactionsOf(ctx, account)).map((row) => str(row, "id")),
      );
      const booked = await bookOn(
        ctx,
        "Invoice",
        invoice.id,
        account,
        Number(str(before, "sumGross") || "0"),
        berlinNoon(day),
        "FULL_PAYMENT",
      );
      if (!booked.ok) {
        return {
          verdict: "observed",
          finding: `bookAmount refused: ${String(booked.status)} ${booked.message ?? ""}.`,
        };
      }
      data(ctx).mark("Invoice", invoice.id, "finalized and paid (cannot be deleted)");
      const after = await ctx.read.byId("Invoice", invoice.id);
      const log = await ctx.http.get("/InvoiceLog", {
        "invoice[id]": invoice.id,
        "invoice[objectName]": "Invoice",
      });
      const created = (await transactionsOf(ctx, account)).find(
        (row) => !transactionsBefore.has(str(row, "id")),
      );
      const payDay = str(after, "payDate").slice(0, 10);
      return {
        verdict: payDay === day ? "confirmed" : "contradicted",
        finding:
          `Booked for ${day} 12:00 Berlin (${berlinNoon(day)}): invoice payDate ${str(after, "payDate") || "none"}, status ${str(after, "status")}; ` +
          `GET /InvoiceLog ${log.ok ? `answered (${Array.isArray(log.objects) ? log.objects.length : 0} rows)` : `refused (${String(log.status)})`}; ` +
          `transaction created on the account: ${describeTransaction(created)}.`,
        deviations: { "D-018": "informs" },
      };
    },
  },
  {
    id: "write-send-email-shape",
    title: "Answer of sendViaEmail (to the operator's own address only)",
    mode: "write",
    sendsEmail: true,
    question:
      "What does POST /Invoice/{id}/sendViaEmail answer, and how do sendType/sendDate change? Sends one e-mail to the address given with --probe-email, never to a contact.",
    deviations: ["NEW"],
    async run(ctx) {
      const to = ctx.probeEmail;
      if (to === undefined) return inconclusive("No --probe-email address given.");
      const invoice = await finalizedInvoice(ctx);
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const before = sendState(await ctx.read.byId("Invoice", invoice.id));
      const sent = await ctx.http.write("POST", `/Invoice/${invoice.id}/sendViaEmail`, {
        tier: "external",
        body: {
          toEmail: to,
          subject: `${data(ctx).tag} probe e-mail`,
          text: "Test e-mail of the sevDesk MCP API probe (trial account). Please ignore.",
          copy: false,
        },
      });
      const after = sendState(await ctx.read.byId("Invoice", invoice.id));
      if (sent.ok)
        data(ctx).mark("Invoice", invoice.id, "finalized, e-mailed to the probe address");
      const shape = Array.isArray(sent.objects)
        ? `a list of ${sent.objects.length}${sent.objects[0] !== null && typeof sent.objects[0] === "object" ? ` with keys ${Object.keys(sent.objects[0] as Row).join(", ")}` : ""}`
        : sent.objects !== null && typeof sent.objects === "object"
          ? `an object with keys ${Object.keys(sent.objects).join(", ")}`
          : typeof sent.objects;
      return {
        verdict: "observed",
        finding:
          `sendViaEmail ${sent.ok ? `answered ${shape}` : `refused (${String(sent.status)}: ${sent.message ?? ""})`}; ` +
          `${diffState(before, after) || "status, sendDate, sendType and update unchanged"}.`,
      };
    },
  },
  {
    id: "write-offline-booking-transaction",
    title: "Booking on an offline account or cash register without a transaction, then resetToOpen",
    mode: "write",
    question:
      "Does bookAmount on an offline account/cash register without a transaction create a CheckAccountTransaction, and does resetToOpen remove it again or leave it behind?",
    deviations: ["NEW"],
    async run(ctx) {
      const account = await offlineAccount(ctx);
      const accountId = Number(account?.["id"]);
      if (account === undefined || !Number.isSafeInteger(accountId)) {
        return inconclusive("No offline account or cash register (Kasse) in the account.");
      }
      const invoice = await finalizedInvoice(ctx);
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const before = new Set((await transactionsOf(ctx, accountId)).map((row) => str(row, "id")));
      const gross = Number(str(await ctx.read.byId("Invoice", invoice.id), "sumGross") || "0");
      const booked = await bookOn(
        ctx,
        "Invoice",
        invoice.id,
        accountId,
        gross,
        berlinNoon(ctx.today),
        "FULL_PAYMENT",
      );
      if (!booked.ok) {
        return {
          verdict: "observed",
          finding: `bookAmount refused: ${String(booked.status)} ${booked.message ?? ""}.`,
        };
      }
      data(ctx).mark("Invoice", invoice.id, "finalized and paid (cannot be deleted)");
      const created = (await transactionsOf(ctx, accountId)).filter(
        (row) => !before.has(str(row, "id")),
      );
      const reset = await ctx.http.write("PUT", `/Invoice/${invoice.id}/resetToOpen`, {
        tier: "commit",
      });
      const afterReset = await transactionsOf(ctx, accountId);
      const stillThere = created.map((row) =>
        afterReset.find((item) => str(item, "id") === str(row, "id")),
      );
      const invoiceAfter = await ctx.read.byId("Invoice", invoice.id);
      if (reset.ok)
        data(ctx).mark("Invoice", invoice.id, "finalized, payment reset (open; cannot be deleted)");
      return {
        verdict: "observed",
        finding:
          `Account ${accountId} (type ${str(account, "type")}): booking created ${created.length} transaction(s): ` +
          `${created.map(describeTransaction).join(", ") || "none"}. resetToOpen ${reset.ok ? "ok" : `refused (${String(reset.status)}: ${reset.message ?? ""})`}; ` +
          `invoice status ${str(invoiceAfter, "status")}, paidAmount ${str(invoiceAfter, "paidAmount")}; after the reset: ` +
          `${stillThere.map((row) => (row === undefined ? "transaction gone" : `still there: ${describeTransaction(row)}`)).join(", ") || "nothing to compare"}.`,
      };
    },
  },
  {
    id: "write-reminder-payment",
    title: "Booking a payment on a reminder (MA) invoice",
    mode: "write",
    question:
      "Can a payment be booked on a dunning (Mahnung, MA) invoice, and what happens to the reminder and to the original invoice?",
    deviations: ["NEW", "D-049"],
    async run(ctx) {
      const account = await data(ctx).checkAccount();
      if (account === undefined)
        return inconclusive("No check account: create a cash register (Kasse) first.");
      const invoice = await finalizedInvoice(ctx, { date: addDays(ctx.today, -30), timeToPay: 7 });
      if ("failure" in invoice) return inconclusive(`Could not prepare: ${invoice.failure}.`);
      const created = await ctx.http.write("POST", "/Invoice/Factory/createInvoiceReminder", {
        tier: "write",
        query: { "invoice[id]": invoice.id, "invoice[objectName]": "Invoice" },
        body: { invoice: { id: invoice.id, objectName: "Invoice" } },
      });
      const reminderId = createdId(created.objects, "invoice");
      if (!created.ok || reminderId === undefined) {
        return inconclusive(
          `createInvoiceReminder failed: ${String(created.status ?? created.kind)} ${created.message ?? ""}.`,
        );
      }
      data(ctx).register("Invoice", reminderId, "reminder (MA) draft");
      const reminder = await ctx.read.byId("Invoice", reminderId);
      let finalizeNote = "already not a draft";
      if (str(reminder, "status") === "100") {
        const finalized = await data(ctx).finalize("Invoice", reminderId);
        finalizeNote = finalized.ok
          ? "finalized with sendBy"
          : `sendBy refused (${String(finalized.status)}: ${finalized.message ?? ""})`;
      }
      const booked = await bookOn(ctx, "Invoice", reminderId, account, 1, berlinNoon(ctx.today));
      const reminderAfter = await ctx.read.byId("Invoice", reminderId);
      const originalAfter = await ctx.read.byId("Invoice", invoice.id);
      if (booked.ok)
        data(ctx).mark("Invoice", reminderId, "reminder (MA), payment booked (cannot be deleted)");
      return {
        verdict: "observed",
        finding:
          `Reminder ${reminderId} (type ${str(reminder, "invoiceType")}, status ${str(reminder, "status")}, ${finalizeNote}): ` +
          `booking 1.00 → ${booked.ok ? "accepted" : `refused (${String(booked.status)}: ${booked.message ?? ""})`}; ` +
          `reminder now status ${str(reminderAfter, "status")}, paidAmount ${str(reminderAfter, "paidAmount")}; ` +
          `original ${invoice.id} status ${str(originalAfter, "status")}, paidAmount ${str(originalAfter, "paidAmount")}.`,
        deviations: { "D-049": "informs" },
      };
    },
  },
  {
    id: "write-save-update-omitted-fields",
    title: "saveInvoice / saveOrder with an existing id and fields left out",
    mode: "write",
    question:
      "When saveInvoice or saveOrder gets an existing id with only a new header, does sevDesk update in place and keep the omitted fields (head/foot text, payment term, note, contact) or null them? Does saveOrder with orderPosDelete replace a position?",
    deviations: ["NEW"],
    async run(ctx) {
      const lines: string[] = [];
      for (const kind of ["Invoice", "Order"] as const) {
        const key = kind === "Invoice" ? "invoice" : "order";
        const draft = await data(ctx).draft(kind, {
          timeToPay: 21,
          fields: { headText: `${data(ctx).tag} head`, footText: `${data(ctx).tag} foot` },
        });
        if (draft.id === undefined) {
          lines.push(
            `${kind}: draft refused (${draft.result.message ?? String(draft.result.status)})`,
          );
          continue;
        }
        const before = await ctx.read.byId(kind, draft.id);
        const update = await ctx.http.write("POST", `/${kind}/Factory/save${kind}`, {
          tier: "write",
          body: {
            [key]: {
              id: draft.id,
              objectName: kind,
              mapAll: true,
              header: `${data(ctx).tag} ${kind} updated`,
            },
            [`${key}PosSave`]: [],
            [`${key}PosDelete`]: null,
          },
        });
        const answerId = createdId(update.objects, key);
        const after = await ctx.read.byId(kind, draft.id);
        lines.push(
          `${kind} ${draft.id}: ${update.ok ? `saved (answer id ${answerId ?? "none"}${answerId === draft.id ? ", same record" : ""})` : `refused (${String(update.status)}: ${update.message ?? ""})`}; ` +
            `changed: ${changedFields(before, after) || "nothing"}`,
        );
        if (kind === "Order" && update.ok) {
          const positionsOf = async () =>
            (
              await ctx.read.page(
                "/OrderPos",
                { "order[id]": draft.id ?? 0, "order[objectName]": "Order" },
                20,
              )
            ).rows.filter((row) => refId(row, "order") === draft.id);
          const old = (await positionsOf())[0];
          const replace = await ctx.http.write("POST", "/Order/Factory/saveOrder", {
            tier: "write",
            body: {
              order: { id: draft.id, objectName: "Order", mapAll: true },
              orderPosSave: [
                {
                  objectName: "OrderPos",
                  mapAll: true,
                  quantity: 1,
                  price: 50,
                  name: `${data(ctx).tag} replacement`,
                  unity: { id: 1, objectName: "Unity" },
                  taxRate: 19,
                },
              ],
              orderPosDelete:
                old === undefined ? null : [{ id: Number(old["id"]), objectName: "OrderPos" }],
            },
          });
          const now = await positionsOf();
          lines.push(
            `Order position replace via orderPosDelete: ${replace.ok ? "saved" : `refused (${String(replace.status)}: ${replace.message ?? ""})`}; ` +
              `positions now ${now.map((row) => `${str(row, "id")} price ${str(row, "price")}`).join(", ") || "none"} (old ${str(old, "id") || "none"})`,
          );
        }
      }
      return { verdict: "observed", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-draft-address-fields",
    title: "Address of an API-created draft invoice",
    mode: "write",
    question:
      "Does a draft invoice created through the API read back with `address` null and only the structured addressName/Street/Zip/City, with and without them in the request?",
    deviations: ["NEW"],
    async run(ctx) {
      const structured = {
        addressName: `${data(ctx).tag} Empfänger`,
        addressStreet: "Musterstraße 1",
        addressZip: "10115",
        addressCity: "Berlin",
      };
      const lines: string[] = [];
      let structuredOnly = false;
      for (const withFields of [true, false]) {
        const draft = await data(ctx).draft("Invoice", withFields ? { fields: structured } : {});
        if (draft.id === undefined) {
          lines.push(
            `${withFields ? "with" : "without"} address fields: refused (${draft.result.message ?? ""})`,
          );
          continue;
        }
        const row = await ctx.read.byId("Invoice", draft.id);
        if (
          withFields &&
          str(row, "address") === "" &&
          str(row, "addressStreet") === structured.addressStreet
        ) {
          structuredOnly = true;
        }
        lines.push(
          `${withFields ? "with" : "without"} address fields (invoice ${draft.id}): address ${JSON.stringify(row?.["address"] ?? null)}, ` +
            `addressStreet ${JSON.stringify(row?.["addressStreet"] ?? null)}, addressZip ${JSON.stringify(row?.["addressZip"] ?? null)}, ` +
            `addressCity ${JSON.stringify(row?.["addressCity"] ?? null)}, addressName set: ${str(row, "addressName") !== ""}`,
        );
      }
      return {
        verdict: structuredOnly ? "confirmed" : "observed",
        finding: `${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "write-credit-note-without-delivery-date",
    title: "saveCreditNote without deliveryDate",
    mode: "write",
    question: 'Does saveCreditNote without deliveryDate fail with 422 ("Must set deliveryDate")?',
    deviations: ["NEW"],
    async run(ctx) {
      const draft = await data(ctx).draft("CreditNote", { omit: ["deliveryDate"] });
      if (draft.id !== undefined) {
        return {
          verdict: "contradicted",
          finding: `Accepted: credit note ${draft.id} was created without deliveryDate.`,
        };
      }
      return {
        verdict: draft.result.status === 422 ? "confirmed" : "observed",
        finding: `Refused with ${String(draft.result.status ?? draft.result.kind)}: ${draft.result.message ?? "no message"}.`,
      };
    },
  },
  {
    id: "write-part-price-fields",
    title: "What POST /Part stores in price",
    mode: "write",
    question:
      "When POST /Part gets priceNet 42.01 + priceGross 49.99 + taxRate 19 but no price, is it accepted and what lands in price?",
    deviations: ["D-042"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const result = await ctx.http.write("POST", "/Part", {
        tier: "write",
        body: {
          objectName: "Part",
          mapAll: true,
          name: `${tag} Artikel`,
          partNumber: `${tag.replace(/\s+/g, "-")}-P1`,
          stock: 0,
          stockEnabled: false,
          unity: { id: 1, objectName: "Unity" },
          taxRate: 19,
          priceNet: 42.01,
          priceGross: 49.99,
          status: 100,
        },
      });
      const id = createdId(result.objects);
      if (!result.ok || id === undefined) {
        return {
          verdict: "observed",
          finding: `Refused: ${String(result.status ?? result.kind)} ${result.message ?? ""}.`,
        };
      }
      data(ctx).register("Part", id, "active (can be deleted in the web app)");
      const row = await ctx.read.byId("Part", id);
      const price = Number(str(row, "price"));
      return {
        verdict: price === 49.99 ? "confirmed" : price === 42.01 ? "contradicted" : "observed",
        finding: `Part ${id}: price ${str(row, "price") || "(empty)"}, priceNet ${str(row, "priceNet")}, priceGross ${str(row, "priceGross")}, taxRate ${str(row, "taxRate")}.`,
      };
    },
  },
  {
    id: "write-contact-customer-number",
    title: "Customer number of a contact created without one",
    mode: "write",
    question:
      "Does POST /Contact (status 1000) without customerNumber get the next free customer number, the one getNextCustomerNumber announced?",
    deviations: ["NEW"],
    async run(ctx) {
      const next = await ctx.http.get("/Contact/Factory/getNextCustomerNumber");
      const result = await ctx.http.write("POST", "/Contact", {
        tier: "write",
        body: {
          name: `${data(ctx).tag} numbering`,
          category: { id: 3, objectName: "Category" },
          status: 1000,
        },
      });
      const id = createdId(result.objects);
      if (!result.ok || id === undefined) {
        return {
          verdict: "observed",
          finding: `Refused: ${String(result.status ?? result.kind)} ${result.message ?? ""}.`,
        };
      }
      data(ctx).register("Contact", id, "active (can be deleted in the web app)");
      const row = await ctx.read.byId("Contact", id, { depth: 1 });
      const assigned = str(row, "customerNumber");
      const announced =
        typeof next.objects === "string" ? next.objects : JSON.stringify(next.objects ?? null);
      return {
        verdict: assigned === "" ? "contradicted" : "confirmed",
        finding:
          `getNextCustomerNumber announced ${announced}; the new contact ${id} (status ${str(row, "status")}) has customerNumber ` +
          `${assigned === "" ? "none" : assigned}${assigned === announced ? " (the announced one)" : ""}.`,
      };
    },
  },
  {
    id: "write-contact-partial-update",
    title: "PUT /Contact/{id} with one field",
    mode: "write",
    question:
      "Is PUT /Contact/{id} a partial update: does sending only description keep name, customerNumber, category and status?",
    deviations: ["NEW"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const created = await ctx.http.write("POST", "/Contact", {
        tier: "write",
        body: {
          name: `${tag} partial`,
          category: { id: 3, objectName: "Category" },
          status: 1000,
          description: "before",
        },
      });
      const id = createdId(created.objects);
      if (!created.ok || id === undefined) {
        return inconclusive(
          `Could not create the contact: ${String(created.status ?? created.kind)} ${created.message ?? ""}.`,
        );
      }
      data(ctx).register("Contact", id, "active (can be deleted in the web app)");
      const before = await ctx.read.byId("Contact", id, { depth: 1 });
      const updated = await ctx.http.write("PUT", `/Contact/${id}`, {
        tier: "write",
        body: { description: `${tag} after` },
      });
      const after = await ctx.read.byId("Contact", id, { depth: 1 });
      const changes = changedFields(before, after);
      const onlyDescription =
        changes !== "" && changes.split("; ").every((change) => change.startsWith("description:"));
      return {
        verdict: !updated.ok ? "observed" : onlyDescription ? "confirmed" : "contradicted",
        finding: `PUT ${updated.ok ? "ok" : `refused (${String(updated.status)}: ${updated.message ?? ""})`}; changed: ${changes || "nothing"}.`,
      };
    },
  },
  {
    id: "write-invoice-from-order",
    title: "Invoice from an order (createInvoiceFromOrder)",
    mode: "write",
    question:
      "What does createInvoiceFromOrder answer, which invoice type does a full invoice (partialType RE) get: RE or ER, is `amount` (with type percentage, partialType TR) the part to invoice or the amount already paid, and what happens to the order's status and the invoice's origin?",
    deviations: ["D-063", "D-064", "D-010"],
    async run(ctx) {
      const variants = [
        { label: "partialType RE", body: { partialType: "RE" } },
        {
          label: "partialType TR, type percentage, amount 30",
          body: { partialType: "TR", type: "percentage", amount: 30 },
        },
      ] as const;
      const lines: string[] = [];
      let fullInvoiceType = "";
      for (const variant of variants) {
        const order = await data(ctx).draft("Order", { orderType: "AB" });
        if (order.id === undefined) {
          lines.push(`${variant.label}: order refused (${order.result.message ?? ""})`);
          continue;
        }
        const finalized = await data(ctx).finalize("Order", order.id);
        const before = await ctx.read.byId("Order", order.id);
        const result = await ctx.http.write("POST", "/Invoice/Factory/createInvoiceFromOrder", {
          tier: "write",
          body: { order: { id: order.id, objectName: "Order" }, ...variant.body },
        });
        const invoiceId = createdId(result.objects, "invoice");
        if (!result.ok || invoiceId === undefined) {
          lines.push(
            `${variant.label} (order ${order.id}, status ${str(before, "status")}, sendBy ${finalized.ok ? "ok" : "failed"}): ` +
              `refused (${String(result.status ?? result.kind)}: ${result.message ?? ""})`,
          );
          continue;
        }
        data(ctx).register("Invoice", invoiceId, "draft from an order (deletable)");
        const invoice = await ctx.read.byId("Invoice", invoiceId);
        const after = await ctx.read.byId("Order", order.id);
        if (variant.body.partialType === "RE") fullInvoiceType = str(invoice, "invoiceType");
        lines.push(
          `${variant.label}: answer ${shapeOf(result.objects)}; invoice ${invoiceId} type ${str(invoice, "invoiceType")}, status ${str(invoice, "status")}, ` +
            `sumNet ${str(invoice, "sumNet")} of order sumNet ${str(before, "sumNet")}, origin ${str(invoice, "origin") || "none"}; ` +
            `order status ${str(before, "status")} → ${str(after, "status")}`,
        );
      }
      const typeNote =
        fullInvoiceType === ""
          ? "The full invoice could not be created."
          : `A full invoice (partialType RE) gets type ${fullInvoiceType}${fullInvoiceType === "RE" ? " (a normal invoice)" : fullInvoiceType === "ER" ? " (a final invoice, Schlussrechnung)" : ""}.`;
      return {
        verdict: "observed",
        finding: `${typeNote} ${lines.join(". ")}.`,
        deviations: { "D-063": "informs", "D-064": "informs", "D-010": "informs" },
      };
    },
  },
];
