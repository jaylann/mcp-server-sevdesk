/**
 * M4 probes for bank reconciliation (Zuordnung von Kontoumsätzen): hand-made transactions on a
 * tagged file-import bank account (sevDesk refuses them on offline accounts), one transaction
 * split over two invoices, the undocumented `CheckAccountTransactionLog` and its filters, marking
 * a transaction private (status 300) and back, and what `resetToOpen` on a document does to the
 * log (D-057, D-060). Without a file-import account the split probe falls back to the transaction
 * a booking without a link creates on the offline account (D-071).
 *
 * Write probes create tagged transactions (purpose and counterparty carry the run tag), one tagged
 * file-import account and tagged invoices through the shared test data; everything is registered
 * for cleanup. Nothing here enshrines a transaction.
 */
import { addDays, type ProbeContext, type ProbeDefinition, type Row, str } from "./core.js";
import {
  berlinNoon,
  changedFields,
  createTransaction,
  data,
  describeLogEntry,
  describeTransaction,
  importAccount,
  inconclusive,
  keysOf,
  offlineAccount,
  outcomeOf,
  transactionLog,
  transactionsOf,
} from "./m4-shared-probes.js";

/**
 * Creates and finalizes a tagged invoice of 100.00 net / 119.00 gross (or `net` at 19 %); the
 * failure text when that is impossible.
 */
async function finalizedInvoice(ctx: ProbeContext, net = 100): Promise<number | string> {
  const draft = await data(ctx).draft("Invoice", { positions: [{ price: net }] });
  if (draft.id === undefined) return `the draft invoice was ${outcomeOf(draft.result)}`;
  const finalized = await data(ctx).finalize("Invoice", draft.id);
  if (!finalized.ok) return `finalizing invoice ${draft.id} was ${outcomeOf(finalized)}`;
  return draft.id;
}

/** `PUT /Invoice/{id}/bookAmount`, linking a transaction when one is given. */
function bookInvoice(
  ctx: ProbeContext,
  invoiceId: number,
  account: number,
  transaction: number | undefined,
  options: {
    readonly amount?: number;
    readonly type?: "FULL_PAYMENT" | "N";
    readonly createFeed?: boolean;
  } = {},
) {
  return ctx.http.write("PUT", `/Invoice/${invoiceId}/bookAmount`, {
    tier: "commit",
    body: {
      amount: options.amount ?? 119,
      date: berlinNoon(ctx.today),
      type: options.type ?? "FULL_PAYMENT",
      checkAccount: { id: account, objectName: "CheckAccount" },
      ...(transaction === undefined
        ? {}
        : { checkAccountTransaction: { id: transaction, objectName: "CheckAccountTransaction" } }),
      ...(options.createFeed === undefined ? {} : { createFeed: options.createFeed }),
    },
  });
}

/** A booking's answer, then the invoice's and the transaction's state and the log. */
async function bookingNote(
  ctx: ProbeContext,
  label: string,
  booked: Awaited<ReturnType<typeof bookInvoice>>,
  invoiceId: number,
  transaction: number,
): Promise<string> {
  const invoice = await ctx.read.byId("Invoice", invoiceId);
  const row = await ctx.read.byId("CheckAccountTransaction", transaction);
  const log = await transactionLog(ctx, transaction);
  if (booked.ok) {
    data(ctx).mark("Invoice", invoiceId, "finalized, booked via a transaction (resettable)");
  }
  return (
    `${label}: ${outcomeOf(booked)}; invoice ${invoiceId} status ${str(invoice, "status")}, paidAmount ${JSON.stringify(invoice?.["paidAmount"] ?? null)}; ` +
    `transaction status ${str(row, "status")}; log ${logNote(log)}`
  );
}

function describeLog(rows: readonly Row[]): string {
  return rows.length === 0
    ? "no entries"
    : `${rows.length}: ${rows.map(describeLogEntry).join("; ")}`;
}

function logNote(log: Awaited<ReturnType<typeof transactionLog>>): string {
  return log.result.ok ? describeLog(log.rows) : outcomeOf(log.result);
}

const LOG_PATH = "/CheckAccountTransactionLog";

/** Which log filters sevDesk honors: each answer against what the filter should leave. */
async function logFilterNotes(ctx: ProbeContext, invoiceId: number): Promise<string> {
  const tomorrow = berlinNoon(addDays(ctx.today, 1));
  const ofInvoice = (row: Row) => JSON.stringify(row).includes(`"id":"${String(invoiceId)}"`);
  const filters = [
    {
      label: "object[id]=invoice",
      query: { "object[id]": invoiceId, "object[objectName]": "Invoice" },
      expect: ofInvoice,
    },
    {
      label: "invoice[id]=invoice",
      query: { "invoice[id]": invoiceId, "invoice[objectName]": "Invoice" },
      expect: ofInvoice,
    },
    { label: "createAfter=tomorrow", query: { createAfter: tomorrow }, expect: () => false },
    { label: "startDate=tomorrow", query: { startDate: tomorrow }, expect: () => false },
  ];
  const all = await ctx.read.page(LOG_PATH, undefined, 1000);
  const notes: string[] = [];
  for (const filter of filters) {
    const page = await ctx.read.page(LOG_PATH, filter.query, 1000);
    const wanted = all.rows.filter(filter.expect).length;
    const honored =
      page.result.ok && page.rows.length === wanted && page.rows.length < all.rows.length;
    notes.push(
      `${filter.label}: ${page.result.ok ? `${page.rows.length} rows (expected ${wanted} of ${all.rows.length}): ${honored ? "honored" : "ignored or different"}` : outcomeOf(page.result)}`,
    );
  }
  return `Log filters: ${notes.join("; ")}`;
}

/** `resetToOpen` on an invoice, and what it did to the invoice, a transaction and its log. */
async function resetNote(
  ctx: ProbeContext,
  invoiceId: number,
  transaction: number,
): Promise<string> {
  const reset = await ctx.http.write("PUT", `/Invoice/${invoiceId}/resetToOpen`, {
    tier: "commit",
  });
  const after = await ctx.http.get(`/CheckAccountTransaction/${transaction}`);
  const row = Array.isArray(after.objects) ? (after.objects[0] as Row | undefined) : undefined;
  const log = await transactionLog(ctx, transaction);
  const invoice = await ctx.read.byId("Invoice", invoiceId);
  if (reset.ok) data(ctx).mark("Invoice", invoiceId, "finalized, payment reset (open)");
  return (
    `resetToOpen on invoice ${invoiceId}: ${outcomeOf(reset)}; invoice status ${str(invoice, "status")}, paidAmount ${JSON.stringify(invoice?.["paidAmount"] ?? null)}; ` +
    `transaction ${row === undefined ? `gone (${after.ok ? "empty answer" : String(after.status ?? after.kind)})` : `status ${str(row, "status")}`}; log ${logNote(log)}`
  );
}

export const M4_BANKING_PROBES: readonly ProbeDefinition[] = [
  {
    id: "write-transaction-create",
    title: "POST /CheckAccountTransaction on a tagged file-import account",
    mode: "write",
    question:
      "Does POST /CheckAccount/Factory/fileImportAccount create a tagged bank account, and does POST /CheckAccountTransaction then create a transaction (status 100) on it with valueDate three days before entryDate; how do amount and the two dates read back? (The later read probe read-transaction-date-filters can then tell which date the startDate/endDate filters compare, D-047.)",
    deviations: ["NEW", "D-016", "D-047"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) {
        return {
          verdict: "observed",
          finding: `No account for hand-made transactions: ${imported.note} (offline accounts refuse them with 422).`,
        };
      }
      const valueDate = addDays(ctx.today, -3);
      const created = await createTransaction(ctx, imported.id, {
        amount: 119,
        label: "incoming",
        valueDate,
        entryDate: ctx.today,
      });
      if (created.id === undefined) {
        return {
          verdict: "contradicted",
          finding: `${imported.note}; POST /CheckAccountTransaction ${outcomeOf(created.result)}.`,
        };
      }
      const row = await ctx.read.byId("CheckAccountTransaction", created.id);
      const kept =
        str(row, "valueDate").slice(0, 10) === valueDate &&
        str(row, "entryDate").slice(0, 10) === ctx.today &&
        str(row, "status") === "100";
      return {
        verdict: kept ? "confirmed" : "observed",
        finding:
          `${imported.note}. Sent valueDate ${valueDate} and entryDate ${ctx.today} (12:00 Berlin as ISO in UTC), amount 119: ` +
          `${describeTransaction(row)}; amount is a ${typeof row?.["amount"]}; answer keys ${keysOf(created.result.objects).join(", ")}.`,
        deviations: { "D-016": "informs", "D-047": "informs" },
      };
    },
  },
  {
    id: "write-transaction-split-booking",
    title: "One transaction for two invoices: statuses, log, filters, resetToOpen",
    mode: "write",
    question:
      "A transaction of +238 on the tagged file-import account linked to invoice A (119) and then invoice B (119) via bookAmount with checkAccountTransaction: which status does the transaction get after the first (200?) and the second (400?) booking, what does GET /CheckAccountTransactionLog?checkAccountTransaction[id]=… answer (amountPaid, object), which log filters work (object[id], invoice[id], createAfter, startDate), and does resetToOpen on invoice A remove its log entry and give the transaction back its status (D-060)? Without a file-import account: the same questions on the transaction a booking without a link creates on the offline account (D-071).",
    deviations: ["D-057", "D-060", "D-071", "NEW"],
    async run(ctx) {
      const invoiceA = await finalizedInvoice(ctx);
      if (typeof invoiceA === "string") return inconclusive(`Could not prepare: ${invoiceA}.`);
      const imported = await importAccount(ctx);
      const transaction =
        imported.id === undefined
          ? undefined
          : await createTransaction(ctx, imported.id, { amount: 238, label: "two invoices" });
      const lines: string[] = [];

      if (imported.id === undefined || transaction?.id === undefined) {
        // Fallback: the transaction sevDesk creates for a booking without a link (D-071).
        const offline = await offlineAccount(ctx);
        if (offline === undefined) {
          return inconclusive(`${imported.note}; and no offline bank account for the fallback.`);
        }
        const before = new Set((await transactionsOf(ctx, offline)).map((row) => str(row, "id")));
        const booked = await bookInvoice(ctx, invoiceA, offline, undefined);
        const made = (await transactionsOf(ctx, offline)).find(
          (row) => !before.has(str(row, "id")),
        );
        if (booked.ok) data(ctx).mark("Invoice", invoiceA, "finalized and paid (resettable)");
        const madeId = Number(made?.["id"]);
        lines.push(
          `No hand-made transaction (${imported.id === undefined ? imported.note : `transaction ${transaction === undefined ? "not created" : outcomeOf(transaction.result)}`}); fallback on offline account ${offline}`,
          `booking invoice ${invoiceA} without a link: ${outcomeOf(booked)}; created ${describeTransaction(made)}`,
        );
        if (made === undefined || !Number.isSafeInteger(madeId)) {
          return { verdict: "observed", finding: `${lines.join(". ")}.` };
        }
        const log = await transactionLog(ctx, madeId);
        lines.push(
          `its log ${logNote(log)}${log.rows[0] === undefined ? "" : `; entry keys ${Object.keys(log.rows[0]).join(", ")}`}`,
          await logFilterNotes(ctx, invoiceA),
          await resetNote(ctx, invoiceA, madeId),
        );
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}.`,
          deviations: { "D-057": "informs", "D-060": "informs", "D-071": "informs" },
        };
      }

      const account = imported.id;
      const id = transaction.id;
      const invoiceB = await finalizedInvoice(ctx);
      if (typeof invoiceB === "string") return inconclusive(`Could not prepare: ${invoiceB}.`);
      const first = await bookInvoice(ctx, invoiceA, account, id);
      const afterFirst = await ctx.read.byId("CheckAccountTransaction", id);
      const logFirst = await transactionLog(ctx, id);
      if (first.ok) {
        data(ctx).mark("Invoice", invoiceA, "finalized, paid via a transaction (resettable)");
      }
      lines.push(
        `Invoice A ${invoiceA}, 119 of 238: ${outcomeOf(first)}; transaction status ${str(afterFirst, "status")}; ` +
          `log ${logNote(logFirst)}` +
          (logFirst.rows[0] === undefined
            ? ""
            : `; entry keys ${Object.keys(logFirst.rows[0]).join(", ")}`),
      );
      const second = await bookInvoice(ctx, invoiceB, account, id);
      const afterSecond = await ctx.read.byId("CheckAccountTransaction", id);
      const logSecond = await transactionLog(ctx, id);
      if (second.ok) {
        data(ctx).mark("Invoice", invoiceB, "finalized, paid via a transaction (resettable)");
      }
      lines.push(
        `Invoice B ${invoiceB}, the other 119: ${outcomeOf(second)}; transaction status ${str(afterSecond, "status")}; log ${logNote(logSecond)}`,
        await logFilterNotes(ctx, invoiceA),
        await resetNote(ctx, invoiceA, id),
      );
      return {
        verdict: first.ok && second.ok ? "observed" : "contradicted",
        finding: `Transaction ${id} on ${imported.note}. ${lines.join(". ")}.`,
        deviations: { "D-057": "informs", "D-060": "informs", "D-071": "informs" },
      };
    },
  },
  {
    id: "write-transaction-split-variants",
    title: "Booking types for split and partial payments through one transaction",
    mode: "write",
    question:
      "FULL_PAYMENT 119 linked to a +238 transaction was refused (422 \"Payment difference amount must be 0.0 when using type 'NONE'\"). On the tagged file-import account: (1) does type N (partial) 119 link invoice A and then invoice B (119 each) to one +238 transaction (statuses 200 → 400, log)? (2) if (1) is refused for A: type N with createFeed false? (3) does type N 119 on a 238 invoice link a +119 transaction exactly (invoice 750, transaction 400)? (4) does the plain 1:1 case work: FULL_PAYMENT 119 on a 119 invoice with a +119 transaction? Every booked invoice is reset to open at the end.",
    deviations: ["D-057", "D-060", "NEW"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = imported.id;
      const lines: string[] = [];
      const booked: number[] = [];
      const remember = (ok: boolean, invoice: number) => {
        if (ok && !booked.includes(invoice)) booked.push(invoice);
      };

      // (1) and (2): one +238 transaction for two invoices of 119.
      const invoiceA = await finalizedInvoice(ctx);
      const invoiceB = await finalizedInvoice(ctx);
      const split = await createTransaction(ctx, account, { amount: 238, label: "split N" });
      if (typeof invoiceA === "string" || typeof invoiceB === "string" || split.id === undefined) {
        lines.push(
          `split: could not prepare (${typeof invoiceA === "string" ? invoiceA : typeof invoiceB === "string" ? invoiceB : `transaction ${outcomeOf(split.result)}`})`,
        );
      } else {
        let form: { readonly label: string; readonly createFeed?: boolean } = { label: "type N" };
        let first = await bookInvoice(ctx, invoiceA, account, split.id, { type: "N" });
        lines.push(await bookingNote(ctx, `(1) A, type N 119 of 238`, first, invoiceA, split.id));
        remember(first.ok, invoiceA);
        if (!first.ok) {
          form = { label: "type N, createFeed false", createFeed: false };
          first = await bookInvoice(ctx, invoiceA, account, split.id, {
            type: "N",
            createFeed: false,
          });
          lines.push(
            await bookingNote(
              ctx,
              `(2) A, type N 119 with createFeed false`,
              first,
              invoiceA,
              split.id,
            ),
          );
          remember(first.ok, invoiceA);
        }
        if (first.ok) {
          const second = await bookInvoice(ctx, invoiceB, account, split.id, {
            type: "N",
            ...(form.createFeed === undefined ? {} : { createFeed: form.createFeed }),
          });
          lines.push(
            await bookingNote(ctx, `B, ${form.label} 119 (the rest)`, second, invoiceB, split.id),
          );
          remember(second.ok, invoiceB);
        }
      }

      // (3) a transaction that pays part of one invoice exactly.
      const invoiceC = await finalizedInvoice(ctx, 200);
      const partial = await createTransaction(ctx, account, { amount: 119, label: "partial N" });
      if (typeof invoiceC === "string" || partial.id === undefined) {
        lines.push(
          `(3) could not prepare (${typeof invoiceC === "string" ? invoiceC : `transaction ${outcomeOf(partial.result)}`})`,
        );
      } else {
        const result = await bookInvoice(ctx, invoiceC, account, partial.id, { type: "N" });
        lines.push(
          await bookingNote(
            ctx,
            "(3) C (238), type N 119 = the whole transaction",
            result,
            invoiceC,
            partial.id,
          ),
        );
        remember(result.ok, invoiceC);
      }

      // (4) the plain 1:1 case.
      const invoiceD = await finalizedInvoice(ctx);
      const exact = await createTransaction(ctx, account, { amount: 119, label: "exact" });
      if (typeof invoiceD === "string" || exact.id === undefined) {
        lines.push(
          `(4) could not prepare (${typeof invoiceD === "string" ? invoiceD : `transaction ${outcomeOf(exact.result)}`})`,
        );
      } else {
        const result = await bookInvoice(ctx, invoiceD, account, exact.id);
        lines.push(
          await bookingNote(
            ctx,
            "(4) D (119), FULL_PAYMENT 119 = the transaction",
            result,
            invoiceD,
            exact.id,
          ),
        );
        remember(result.ok, invoiceD);
      }

      // Cleanup: every booked invoice back to open (D-060 unlinks the transactions).
      const resets: string[] = [];
      for (const invoice of booked) {
        const reset = await ctx.http.write("PUT", `/Invoice/${invoice}/resetToOpen`, {
          tier: "commit",
        });
        if (reset.ok) data(ctx).mark("Invoice", invoice, "finalized, payment reset (open)");
        resets.push(`${invoice} ${outcomeOf(reset)}`);
      }
      const statuses: string[] = [];
      for (const id of [split.id, partial.id, exact.id]) {
        if (id === undefined) continue;
        statuses.push(`${id} ${str(await ctx.read.byId("CheckAccountTransaction", id), "status")}`);
      }
      lines.push(
        `Cleanup resetToOpen: ${resets.join(", ") || "nothing booked"}; transactions afterwards: ${statuses.join(", ") || "none"}`,
      );
      return {
        verdict: "observed",
        finding: `On ${imported.note}. ${lines.join(". ")}.`,
        deviations: { "D-057": "informs", "D-060": "informs" },
      };
    },
  },
  {
    id: "write-transaction-reset-one-of-split",
    title: "resetToOpen on one of two invoices that share a transaction",
    mode: "write",
    question:
      "A +238 transaction on the tagged file-import account linked to invoices A and B (119 each) with type N (status 400): after resetToOpen on A only, which status has the transaction (200? 100?), which log entries are left (B's?), and what are B's status and paidAmount? B is reset as well at the end.",
    deviations: ["D-060", "D-057", "NEW"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = imported.id;
      const invoiceA = await finalizedInvoice(ctx);
      const invoiceB = await finalizedInvoice(ctx);
      const split = await createTransaction(ctx, account, { amount: 238, label: "reset one" });
      if (typeof invoiceA === "string" || typeof invoiceB === "string" || split.id === undefined) {
        return inconclusive(
          `Could not prepare: ${typeof invoiceA === "string" ? invoiceA : typeof invoiceB === "string" ? invoiceB : `transaction ${outcomeOf(split.result)}`}.`,
        );
      }
      const id = split.id;
      const lines: string[] = [];
      const first = await bookInvoice(ctx, invoiceA, account, id, { type: "N" });
      lines.push(await bookingNote(ctx, "A, type N 119", first, invoiceA, id));
      const second = await bookInvoice(ctx, invoiceB, account, id, { type: "N" });
      lines.push(await bookingNote(ctx, "B, type N 119", second, invoiceB, id));
      if (!first.ok || !second.ok) {
        return { verdict: "inconclusive", finding: `On ${imported.note}. ${lines.join(". ")}.` };
      }
      lines.push(await resetNote(ctx, invoiceA, id));
      const b = await ctx.read.byId("Invoice", invoiceB);
      lines.push(
        `B ${invoiceB} afterwards: status ${str(b, "status")}, paidAmount ${JSON.stringify(b?.["paidAmount"] ?? null)}, payDate ${str(b, "payDate") || "none"}`,
      );
      lines.push(`Cleanup: ${await resetNote(ctx, invoiceB, id)}`);
      return {
        verdict: "observed",
        finding: `Transaction ${id} on ${imported.note}. ${lines.join(". ")}.`,
        deviations: { "D-060": "informs", "D-057": "informs" },
      };
    },
  },
  {
    id: "write-transaction-private-status",
    title: "Marking a transaction private (status 300) and back",
    mode: "write",
    question:
      "Does PUT /CheckAccountTransaction/{id} {status: 300} mark an unlinked hand-made transaction (on the tagged file-import account) private (Privatentnahme), does anything else change or get booked (fields, log entries), and does {status: 100} set it back? (Never tried on a booked transaction: that would change a booking.)",
    deviations: ["NEW", "D-057"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) {
        return inconclusive(
          `${imported.note}; a booked transaction (status 400) was not used instead, since marking it private would change a booking.`,
        );
      }
      const created = await createTransaction(ctx, imported.id, { amount: -25, label: "private" });
      if (created.id === undefined) {
        return inconclusive(`The transaction was ${outcomeOf(created.result)}.`);
      }
      const id = created.id;
      const before = await ctx.read.byId("CheckAccountTransaction", id);
      const toPrivate = await ctx.http.write("PUT", `/CheckAccountTransaction/${id}`, {
        tier: "commit",
        body: { status: 300 },
      });
      const privateRow = await ctx.read.byId("CheckAccountTransaction", id);
      const log = await transactionLog(ctx, id);
      const back = await ctx.http.write("PUT", `/CheckAccountTransaction/${id}`, {
        tier: "commit",
        body: { status: 100 },
      });
      const after = await ctx.read.byId("CheckAccountTransaction", id);
      data(ctx).mark(
        "CheckAccountTransaction",
        id,
        `status ${str(after, "status")} (deletable in the web app)`,
      );
      const roundTrip =
        toPrivate.ok && str(privateRow, "status") === "300" && str(after, "status") === "100";
      return {
        verdict: roundTrip ? "confirmed" : "observed",
        finding:
          `Transaction ${id} on ${imported.note}: status 300 ${outcomeOf(toPrivate)} → changed: ${changedFields(before, privateRow) || "nothing"}; ` +
          `log ${logNote(log)}. ` +
          `Back to 100 ${outcomeOf(back)} → changed against the start: ${changedFields(before, after) || "nothing"}.`,
        deviations: { "D-057": "informs" },
      };
    },
  },
  {
    id: "read-transaction-log",
    title: "GET /CheckAccountTransactionLog without a filter",
    mode: "read",
    question:
      "Does GET /CheckAccountTransactionLog without a filter list every entry of the account, with countAll total and limit/offset paging, and which keys does an entry have?",
    deviations: ["D-057", "D-024"],
    async run(ctx) {
      const all = await ctx.read.page(LOG_PATH, undefined, 1000);
      if (!all.result.ok) {
        return { verdict: "observed", finding: `Refused: ${outcomeOf(all.result)}.` };
      }
      if (all.rows.length === 0) {
        return inconclusive(
          `GET ${LOG_PATH} answered no entries (total ${String(all.total)}); book a payment with a transaction first.`,
        );
      }
      const bare = await ctx.http.get(LOG_PATH);
      const firstPage = await ctx.http.get(LOG_PATH, { limit: 1, offset: 0 });
      const secondPage = await ctx.http.get(LOG_PATH, { limit: 1, offset: 1 });
      const idOf = (objects: unknown) =>
        Array.isArray(objects) ? str(objects[0] as Row | undefined, "id") : "";
      const paging =
        all.rows.length < 2
          ? "needs two entries to check offset"
          : idOf(firstPage.objects) !== "" && idOf(firstPage.objects) !== idOf(secondPage.objects)
            ? "limit=1 with offset 0 and 1 give different entries (paging works)"
            : "offset 0 and 1 give the same entry (offset ignored?)";
      const first = all.rows[0];
      return {
        verdict: "observed",
        finding:
          `${all.rows.length} entries with limit=1000, countAll total ${JSON.stringify(all.total ?? null)}; ` +
          `without parameters ${Array.isArray(bare.objects) ? `${bare.objects.length} entries` : outcomeOf(bare)}; ${paging}. ` +
          `Entry keys: ${first === undefined ? "none" : Object.keys(first).join(", ")}; first entry: ${first === undefined ? "none" : describeLogEntry(first)}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
];
