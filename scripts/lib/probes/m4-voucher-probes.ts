/**
 * M4 write probes for receipts (Belege, vouchers): the temp-file upload, `saveVoucher` (file
 * placement, sums, updates, invalid combinations, revenue), deleting, finalizing, booking payments
 * and resetting. Each probe creates its own tagged vouchers (description and supplier name carry
 * the run tag) and registers them for cleanup. Booking accounts come from ReceiptGuidance (SKR04
 * 6815 Bürobedarf with rule 9, 4400 with rule 1, or the first account that fits).
 *
 * Nothing here enshrines a voucher.
 */
import {
  addDays,
  createdId,
  germanDate,
  type ProbeContext,
  type ProbeDefinition,
  type Row,
  str,
} from "./core.js";
import {
  berlinNoon,
  bookingAccounts,
  bookVoucher,
  changedFields,
  createTransaction,
  createVoucher,
  data,
  describeLogEntry,
  describePositions,
  describeTransaction,
  describeUpload,
  firstRow,
  importAccount,
  inconclusive,
  isGone,
  isoNoon,
  offlineAccount,
  outcomeOf,
  saveVoucherStatus,
  shapeOf,
  slug,
  TINY_PNG,
  tinyPdf,
  transactionLog,
  transactionsOf,
  uploadTempFile,
  voucherFailure,
  voucherHeader,
  voucherPosition,
  voucherPositions,
  voucherState,
} from "./m4-shared-probes.js";

/** A tagged one-page receipt PDF. */
function receiptPdf(ctx: ProbeContext, label: string): Promise<Uint8Array> {
  return tinyPdf([
    `${data(ctx).tag} ${label}`,
    "Test receipt of the sevDesk MCP API probe (trial account).",
    "Bürobedarf 100,00 EUR + 19 % USt 19,00 EUR = 119,00 EUR",
  ]);
}

/** Whether a voucher read carries a document: absent key, null, or a reference. */
function documentState(row: Row | undefined): "absent" | "null" | "set" {
  if (row === undefined || !Object.hasOwn(row, "document")) return "absent";
  return row["document"] === null ? "null" : "set";
}

/** Preserve absent/null and JSON scalar types when reporting the currency contract. */
function currencyValues(ctx: ProbeContext, row: Row | undefined): string {
  const fields = [
    "currency",
    "status",
    "sumNet",
    "sumTax",
    "sumGross",
    "sumNetForeignCurrency",
    "sumTaxForeignCurrency",
    "sumGrossForeignCurrency",
    "propertyExchangeRate",
    "propertyForeignCurrencyDeadline",
  ];
  const safe = ctx.scrubber.scrub(row ?? {}) as Row;
  return fields
    .map((key) => `${key}=${safe[key] === undefined ? "absent" : JSON.stringify(safe[key])}`)
    .join(", ");
}

/** Only creates tagged status-50 vouchers; every returned id goes into the cleanup list. */
async function createUsdDraft(
  ctx: ProbeContext,
  property: { propertyExchangeRate: string } | { propertyForeignCurrencyDeadline: string },
) {
  const accounts = await bookingAccounts(ctx);
  if (accounts.expense === undefined) return { why: accounts.note };
  const position = voucherPosition(data(ctx).tag, accounts.expense, {
    net: true,
    amount: 100,
    label: "USD 100 net at 19 percent",
  });
  const header = {
    ...voucherHeader(ctx, { label: "USD exchange rate", status: 50 }),
    currency: "USD",
    ...property,
  };
  const result = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
    tier: "write",
    body: { voucher: header, voucherPosSave: [position], voucherPosDelete: null },
  });
  const id = createdId(result.objects, "voucher");
  if (id !== undefined) data(ctx).register("Voucher", id, "draft voucher (deletable)");
  if (!result.ok || id === undefined) return { why: `USD create: ${outcomeOf(result)}` };
  return { id, header, position };
}

/** New transactions of `accountId` compared with the ids in `before`. */
async function newTransactions(
  ctx: ProbeContext,
  accountId: number,
  before: ReadonlySet<string>,
): Promise<Row[]> {
  return (await transactionsOf(ctx, accountId)).filter((row) => !before.has(str(row, "id")));
}

async function transactionIds(ctx: ProbeContext, accountId: number): Promise<Set<string>> {
  return new Set((await transactionsOf(ctx, accountId)).map((row) => str(row, "id")));
}

export const M4_VOUCHER_PROBES: readonly ProbeDefinition[] = [
  {
    id: "write-voucher-upload-temp-file",
    title: "uploadTempFile: answer for a PDF, a PNG and plain text",
    mode: "write",
    question:
      "What does POST /Voucher/Factory/uploadTempFile (multipart part `file`) answer for a tiny PDF and a 1×1 PNG (filename token, mimeType, pages, contentHash, size of the content preview), and what does it do with plain text?",
    deviations: ["D-011", "B6"],
    async run(ctx) {
      const name = slug(data(ctx).tag);
      const cases = [
        {
          label: "PDF",
          bytes: await receiptPdf(ctx, "upload"),
          file: `${name}-receipt.pdf`,
          type: "application/pdf",
        },
        { label: "PNG", bytes: TINY_PNG, file: `${name}-receipt.png`, type: "image/png" },
        {
          label: "plain text",
          bytes: new TextEncoder().encode(`${data(ctx).tag}: plain text, not a receipt.\n`),
          file: `${name}-note.txt`,
          type: "text/plain",
        },
      ];
      const lines: string[] = [];
      let pdfToken = false;
      for (const item of cases) {
        const upload = await uploadTempFile(ctx, item.bytes, item.file, item.type);
        if (item.label === "PDF") pdfToken = upload.token !== undefined;
        lines.push(
          `${item.label} (${item.bytes.length} bytes): ${upload.result.ok ? describeUpload(upload.result.objects) : outcomeOf(upload.result)}`,
        );
      }
      return {
        verdict: pdfToken ? "confirmed" : "contradicted",
        finding: `${lines.join(". ")}.`,
        deviations: { B6: "informs" },
      };
    },
  },
  {
    id: "write-voucher-save-with-file",
    title: "saveVoucher with an uploaded file: where `filename` must go",
    mode: "write",
    question:
      "Does a draft voucher (status 50) saved with the token as top-level `filename` (keys voucher, voucherPosSave, voucherPosDelete, filename) get a document, does the same with `filename` first, and is `filename` inside `voucher` dropped silently? Do GET /Voucher/{id} and the list row carry `document`? Is supplierName kept without a supplier contact?",
    deviations: ["B5", "D-026", "D-044"],
    async run(ctx) {
      const variants = [
        { label: "top-level, spec order", placement: "top-level" },
        { label: "top-level, filename first", placement: "first" },
        { label: "inside voucher", placement: "inside-voucher" },
      ] as const;
      const lines: string[] = [];
      const states = new Map<string, string>();
      const ids: number[] = [];
      let supplierNote = "";
      for (const variant of variants) {
        const upload = await uploadTempFile(
          ctx,
          await receiptPdf(ctx, variant.placement),
          `${slug(data(ctx).tag)}-${variant.placement}.pdf`,
          "application/pdf",
        );
        if (upload.token === undefined) {
          lines.push(`${variant.label}: upload ${outcomeOf(upload.result)}, no token`);
          continue;
        }
        const created = await createVoucher(ctx, {
          label: `B5 ${variant.placement}`,
          file: { token: upload.token, placement: variant.placement },
        });
        if (created.id === undefined) {
          lines.push(`${variant.label}: ${voucherFailure(created)}`);
          continue;
        }
        ids.push(created.id);
        const row = await ctx.read.byId("Voucher", created.id);
        const state = documentState(row);
        states.set(variant.placement, state);
        lines.push(
          `${variant.label}: voucher ${created.id} status ${str(row, "status")}, document ${state}${state === "set" ? ` (${JSON.stringify(row?.["document"])})` : ""}`,
        );
        supplierNote ||= `supplier ${JSON.stringify(row?.["supplier"] ?? null)}, supplierName kept: ${str(row, "supplierName") !== ""}`;
      }
      const list = await ctx.read.page("/Voucher", undefined, 100);
      const listed = list.rows.filter((row) => ids.includes(Number(row["id"])));
      const listNote = `list rows: ${listed.map((row) => `${str(row, "id")} document ${documentState(row)}`).join(", ") || "not found"}`;
      if (states.size === 0) return inconclusive(`${lines.join(". ")}.`);
      const top = states.get("top-level");
      const inside = states.get("inside-voucher");
      const attachedTop = top === "set";
      const droppedInside = inside !== "set";
      const unknown = top === "absent";
      return {
        verdict: unknown ? "observed" : attachedTop && droppedInside ? "confirmed" : "contradicted",
        finding: `${lines.join(". ")}. ${listNote}. ${supplierNote}.`,
        deviations: {
          "D-044": top === "absent" ? "confirms" : "contradicts",
          ...(unknown ? { B5: "informs", "D-026": "informs" } : {}),
        },
      };
    },
  },
  {
    id: "write-voucher-net-gross",
    title: "saveVoucher positions with net true vs false: which sums are stored",
    mode: "write",
    question:
      "A draft with one position `net: true, sumNet: 100` and one with `net: false, sumGross: 119` (19 %, rule 9): which sumNet/sumTax/sumGross do the voucher and the position store, and do positions carry accountDatev or accountingType (D-045)?",
    deviations: ["NEW", "D-045"],
    async run(ctx) {
      const lines: string[] = [];
      let both = 0;
      let made = 0;
      let accountDatev = "";
      for (const net of [true, false]) {
        const created = await createVoucher(ctx, { label: `net-${String(net)}`, net });
        if (created.id === undefined) {
          lines.push(`net ${String(net)}: ${voucherFailure(created)}`);
          continue;
        }
        made += 1;
        const row = await ctx.read.byId("Voucher", created.id);
        const positions = await voucherPositions(ctx, created.id);
        if (
          Number(str(row, "sumNet")) === 100 &&
          Number(str(row, "sumGross")) === 119 &&
          Number(str(row, "sumTax")) === 19
        ) {
          both += 1;
        }
        const first = positions[0];
        accountDatev ||=
          first === undefined
            ? ""
            : `position keys accountDatev ${Object.hasOwn(first, "accountDatev") ? JSON.stringify(first["accountDatev"]) : "absent"}, accountingType ${Object.hasOwn(first, "accountingType") ? JSON.stringify(first["accountingType"]) : "absent"}`;
        lines.push(
          `net ${String(net)} → voucher ${created.id}: sumNet ${str(row, "sumNet")}, sumTax ${str(row, "sumTax")}, sumGross ${str(row, "sumGross")}; positions ${describePositions(positions)}`,
        );
      }
      if (made === 0) return inconclusive(`${lines.join(". ")}.`);
      return {
        verdict: both === 2 ? "confirmed" : "observed",
        finding: `${lines.join(". ")}. ${accountDatev}.`,
        deviations: { "D-045": "informs" },
      };
    },
  },
  {
    id: "write-voucher-open-directly",
    title: "saveVoucher with status 100",
    mode: "write",
    question:
      "Does saveVoucher create an open voucher (status 100) directly, and what does it read back with (status, number, enshrined)?",
    deviations: ["NEW"],
    async run(ctx) {
      const created = await createVoucher(ctx, { label: "open", status: 100 });
      if (created.id === undefined) {
        return {
          verdict: "observed",
          finding: `saveVoucher with status 100 was ${voucherFailure(created)}.`,
        };
      }
      const row = await ctx.read.byId("Voucher", created.id);
      return {
        verdict: "observed",
        finding:
          `Voucher ${created.id}: ${voucherState(row)}, voucherNumber ${JSON.stringify(row?.["voucherNumber"] ?? null)}, ` +
          `enshrined ${JSON.stringify(row?.["enshrined"] ?? null)}, answer ${shapeOf(created.result.objects)}.`,
      };
    },
  },
  {
    id: "write-voucher-update-draft",
    title: "Updating a draft voucher through saveVoucher with voucher.id",
    mode: "write",
    question:
      "Does saveVoucher with `voucher: {id, objectName, mapAll}` keep the header fields it leaves out, and does voucherPosDelete replace a position as a single {id, objectName} object and as a list?",
    deviations: ["NEW", "D-054"],
    async run(ctx) {
      const accounts = await bookingAccounts(ctx);
      if (accounts.expense === undefined) return inconclusive(accounts.note);
      const created = await createVoucher(ctx, { label: "update" });
      if (created.id === undefined) return inconclusive(voucherFailure(created));
      const id = created.id;
      const tag = data(ctx).tag;
      const before = await ctx.read.byId("Voucher", id);
      const lines: string[] = [];
      let replacedBoth = true;
      for (const [index, form] of (["single object", "list"] as const).entries()) {
        const old = (await voucherPositions(ctx, id)).at(-1);
        const reference =
          old === undefined ? null : { id: Number(old["id"]), objectName: "VoucherPos" };
        const result = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
          tier: "write",
          body: {
            // status 50 keeps it a draft save (the client needs commit for anything else).
            voucher: { id, objectName: "Voucher", mapAll: true, status: 50 },
            voucherPosSave: [
              voucherPosition(tag, accounts.expense, {
                net: false,
                amount: index === 0 ? 50 : 30,
                label: `replacement ${index + 1}`,
              }),
            ],
            voucherPosDelete: form === "list" && reference !== null ? [reference] : reference,
          },
        });
        const positions = await voucherPositions(ctx, id);
        const gone =
          old !== undefined && !positions.some((row) => str(row, "id") === str(old, "id"));
        replacedBoth &&= result.ok && gone && positions.length === 1;
        lines.push(
          `voucherPosDelete as ${form} (old position ${str(old, "id") || "none"}): save ${outcomeOf(result)}` +
            `${result.ok ? `, answer id ${String(createdId(result.objects, "voucher") ?? "none")}` : ""}; positions now ${describePositions(positions)}`,
        );
      }
      const after = await ctx.read.byId("Voucher", id);
      return {
        verdict: replacedBoth ? "confirmed" : "observed",
        finding: `Voucher ${id}: ${lines.join(". ")}. Header changes after both updates: ${changedFields(before, after) || "none"}.`,
        deviations: { "D-054": "informs" },
      };
    },
  },
  {
    id: "write-voucher-usd-rate",
    title: "Creating a USD draft with an explicit decimal exchange rate",
    mode: "write",
    question:
      "With a USD 100 net position at 19 percent and propertyExchangeRate string 0.9, which sums and position amounts are stored? Is the rate EUR per USD or USD per EUR, and what are the GET property types?",
    deviations: ["D-043", "D-082"],
    async run(ctx) {
      const created = await createUsdDraft(ctx, { propertyExchangeRate: "0.9" });
      if (created.id === undefined) return inconclusive(created.why);
      const row = await ctx.read.byId("Voucher", created.id);
      const positions = await voucherPositions(ctx, created.id);
      return {
        verdict:
          str(row, "status") === "50" && str(row, "currency") === "USD" && positions.length === 1
            ? "observed"
            : "inconclusive",
        finding: `Voucher ${created.id}; sent USD net 100, tax 19 percent, propertyExchangeRate string 0.9. GET: ${currencyValues(ctx, row)}. Positions: ${describePositions(positions)}. EUR-per-USD would give EUR net 90, tax 17.10, gross 107.10; USD-per-EUR would give EUR net 111.11 and gross 132.22 after rounding to cents. Compare the recorded fields before choosing a direction.`,
      };
    },
  },
  {
    id: "write-voucher-usd-deadline",
    title: "Creating a USD draft with an exchange-rate date only",
    mode: "write",
    question:
      "Does propertyForeignCurrencyDeadline as dd.mm.yyyy select a stored rate without propertyExchangeRate? What types and formats do the rate and date have on GET?",
    deviations: ["D-043", "D-082"],
    async run(ctx) {
      const deadline = germanDate(addDays(ctx.today, -1));
      const created = await createUsdDraft(ctx, { propertyForeignCurrencyDeadline: deadline });
      if (created.id === undefined) return inconclusive(created.why);
      const row = await ctx.read.byId("Voucher", created.id);
      const positions = await voucherPositions(ctx, created.id);
      return {
        verdict:
          str(row, "status") === "50" && str(row, "currency") === "USD" && positions.length === 1
            ? "observed"
            : "inconclusive",
        finding: `Voucher ${created.id}; sent USD net 100, tax 19 percent, propertyForeignCurrencyDeadline ${deadline}, no propertyExchangeRate. GET: ${currencyValues(ctx, row)}. Positions: ${describePositions(positions)}.`,
      };
    },
  },
  {
    id: "write-voucher-usd-rate-update",
    title: "Changing a USD draft exchange rate with and without replacement positions",
    mode: "write",
    question:
      "Does changing propertyExchangeRate from string 0.9 to 0.8 recalculate a USD draft when positions are untouched? Does resending the same USD amounts change the result?",
    deviations: ["D-043", "D-082"],
    async run(ctx) {
      const created = await createUsdDraft(ctx, { propertyExchangeRate: "0.9" });
      if (created.id === undefined) return inconclusive(created.why);
      const before = await ctx.read.byId("Voucher", created.id);
      if (str(before, "status") !== "50" || str(before, "currency") !== "USD") {
        return inconclusive(`USD draft setup was not stored: ${currencyValues(ctx, before)}.`);
      }
      const initialPositions = await voucherPositions(ctx, created.id);
      if (initialPositions.length !== 1)
        return inconclusive("USD setup needs one stored position.");
      const lines = [
        `Before: ${currencyValues(ctx, before)}. Positions: ${describePositions(initialPositions)}`,
      ];
      for (const replace of [false, true]) {
        // A successful create is insufficient: verify draft status before every further write.
        const current = await ctx.read.byId("Voucher", created.id);
        if (str(current, "status") !== "50") {
          return inconclusive(`${lines.join(". ")}. Further update refused: not a verified draft.`);
        }
        const saved = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
          tier: "write",
          body: {
            voucher: { ...created.header, id: created.id, propertyExchangeRate: "0.8" },
            voucherPosSave: replace ? [created.position] : null,
            voucherPosDelete: replace
              ? initialPositions.map((row) => ({ id: Number(row["id"]), objectName: "VoucherPos" }))
              : null,
          },
        });
        const after = await ctx.read.byId("Voucher", created.id);
        const positions = await voucherPositions(ctx, created.id);
        lines.push(
          `${replace ? "Replacement positions" : "Positions untouched"}: ${outcomeOf(saved)}; ${currencyValues(ctx, after)}. Positions: ${describePositions(positions)}`,
        );
        if (!saved.ok || str(after, "status") !== "50" || positions.length !== 1) {
          return inconclusive(lines.join(". "));
        }
      }
      return {
        verdict: "observed",
        finding: `Voucher ${created.id}; sent rate 0.9 then 0.8 with USD net 100 at 19 percent. ${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "write-voucher-convert-to-eur",
    title: "Converting a USD voucher draft to EUR with replacement amounts",
    mode: "write",
    question:
      "After explicitly setting a tagged draft to USD with propertyExchangeRate 0.8, does a full saveVoucher header with currency EUR and all-new EUR positions replace the currency and amounts? What remains in sum…ForeignCurrency and the exchange-rate properties?",
    deviations: ["D-043", "D-081"],
    async run(ctx) {
      const accounts = await bookingAccounts(ctx);
      if (accounts.expense === undefined) return inconclusive(accounts.note);
      const options = { label: "currency conversion", status: 50 } as const;
      const created = await createVoucher(ctx, options);
      if (created.id === undefined) return inconclusive(voucherFailure(created));
      const id = created.id;
      const draft = await ctx.read.byId("Voucher", id);
      if (str(draft, "status") !== "50") return inconclusive("Setup is not a verified draft.");
      const seeded = await saveVoucherStatus(ctx, id, options, {
        currency: "USD",
        propertyExchangeRate: 0.8,
      });
      const before = await ctx.read.byId("Voucher", id);
      if (!seeded.ok || str(before, "currency") !== "USD" || str(before, "status") !== "50") {
        return inconclusive(
          `Could not seed a USD draft: ${outcomeOf(seeded)}; currency ${str(before, "currency")}.`,
        );
      }
      const oldPositions = await voucherPositions(ctx, id);
      const saved = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
        tier: "write",
        body: {
          voucher: { ...voucherHeader(ctx, options), id, currency: "EUR" },
          voucherPosSave: [
            voucherPosition(data(ctx).tag, accounts.expense, {
              net: false,
              amount: 119.5,
              label: "EUR replacement",
            }),
          ],
          voucherPosDelete: oldPositions.map((row) => ({
            id: Number(row["id"]),
            objectName: "VoucherPos",
          })),
        },
      });
      const after = await ctx.read.byId("Voucher", id);
      const positions = await voucherPositions(ctx, id);
      return {
        verdict:
          saved.ok && str(after, "status") === "50" && positions.length === 1
            ? "observed"
            : "inconclusive",
        finding: `Voucher ${id}; EUR save ${outcomeOf(saved)}. Before: ${currencyValues(ctx, before)}. After: ${currencyValues(ctx, after)}. Positions: ${describePositions(positions)}. Requested one new gross EUR position of 119.50 and deletion of every old position.`,
        deviations: { "D-043": "informs", "D-081": "informs" },
      };
    },
  },
  {
    id: "write-voucher-invalid-account-rule",
    title: "saveVoucher with an account that does not take the tax rule",
    mode: "write",
    question:
      "Is an expense voucher on an expense account (6815 Bürobedarf) with the revenue tax rule 1 refused, with which status and message (ReceiptGuidance would refuse it)?",
    deviations: ["NEW", "D-065"],
    async run(ctx) {
      const created = await createVoucher(ctx, { label: "invalid rule", taxRuleId: "1" });
      if (created.why !== undefined) return inconclusive(created.why);
      if (created.id !== undefined) {
        const row = await ctx.read.byId("Voucher", created.id);
        return {
          verdict: "contradicted",
          finding: `Accepted: voucher ${created.id} (status ${str(row, "status")}, taxRule ${JSON.stringify(row?.["taxRule"] ?? null)}) was saved with rule 1 on an expense account.`,
          deviations: { "D-065": "informs" },
        };
      }
      return {
        verdict: created.result.status === 422 ? "confirmed" : "observed",
        finding: `Refused with ${String(created.result.status ?? created.result.kind)}: ${created.result.message ?? "no message"}.`,
        deviations: { "D-065": "informs" },
      };
    },
  },
  {
    id: "write-voucher-revenue",
    title: "A revenue voucher (creditDebit D)",
    mode: "write",
    question:
      "Does saveVoucher accept a revenue draft (creditDebit D, rule 1, 4400, gross 119), and how do its creditDebit and sums read back (signs)?",
    deviations: ["NEW", "D-041"],
    async run(ctx) {
      const created = await createVoucher(ctx, { label: "revenue", kind: "revenue" });
      if (created.why !== undefined) return inconclusive(created.why);
      if (created.id === undefined) {
        return {
          verdict: "observed",
          finding: `Refused: ${voucherFailure(created)}.`,
        };
      }
      const row = await ctx.read.byId("Voucher", created.id);
      const positions = await voucherPositions(ctx, created.id);
      return {
        verdict: "observed",
        finding:
          `Voucher ${created.id}: creditDebit ${str(row, "creditDebit")}, ${voucherState(row)}, taxRule ${JSON.stringify(row?.["taxRule"] ?? null)}; ` +
          `positions ${describePositions(positions)}.`,
        deviations: { "D-041": "informs" },
      };
    },
  },
  {
    id: "write-voucher-delete",
    title: "DELETE /Voucher/{id} on a draft and on an open voucher",
    mode: "write",
    question:
      "Does the undocumented DELETE /Voucher/{id} delete a draft voucher (status 50), and is it refused for an open voucher (status 100)?",
    deviations: ["D-024"],
    async run(ctx) {
      const lines: string[] = [];
      let draftDeleted = false;
      let made = 0;
      for (const status of [50, 100] as const) {
        const created = await createVoucher(ctx, { label: `delete ${status}`, status });
        if (created.id === undefined) {
          lines.push(`status ${status}: ${voucherFailure(created)}`);
          continue;
        }
        made += 1;
        const deleted = await ctx.http.write("DELETE", `/Voucher/${created.id}`, { tier: "write" });
        const after = await ctx.http.get(`/Voucher/${created.id}`);
        const gone = isGone(after);
        if (gone) data(ctx).mark("Voucher", created.id, "deleted by the probe");
        if (status === 50) draftDeleted = gone;
        lines.push(
          `status ${status} (voucher ${created.id}): DELETE ${outcomeOf(deleted)}; GET afterwards ${gone ? "finds nothing" : `still finds it (status ${str(firstRow(after.objects), "status")})`}`,
        );
      }
      if (made === 0) return inconclusive(`${lines.join(". ")}.`);
      return {
        verdict: draftDeleted ? "confirmed" : "contradicted",
        finding: `${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "write-voucher-finalize",
    title: "Draft voucher to open (50 → 100): PUT vs saveVoucher",
    mode: "write",
    question:
      "Does PUT /Voucher/{id} {status: 100} turn a draft voucher into an open one, does saveVoucher with voucher.id and status 100 do the same, and what else changes?",
    deviations: ["NEW"],
    async run(ctx) {
      const lines: string[] = [];
      let worked = 0;
      let made = 0;
      for (const route of ["PUT /Voucher/{id}", "saveVoucher with id"] as const) {
        const created = await createVoucher(ctx, { label: `finalize ${route}` });
        if (created.id === undefined) {
          lines.push(`${route}: ${voucherFailure(created)}`);
          continue;
        }
        made += 1;
        const id = created.id;
        const before = await ctx.read.byId("Voucher", id);
        const result =
          route === "PUT /Voucher/{id}"
            ? await ctx.http.write("PUT", `/Voucher/${id}`, {
                tier: "commit",
                body: { status: 100 },
              })
            : await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
                tier: "commit",
                body: {
                  voucher: { id, objectName: "Voucher", mapAll: true, status: 100 },
                  voucherPosSave: [],
                  voucherPosDelete: null,
                },
              });
        const after = await ctx.read.byId("Voucher", id);
        const open = str(after, "status") === "100";
        if (open) {
          worked += 1;
          data(ctx).mark("Voucher", id, "open voucher (status 100)");
        }
        lines.push(
          `${route} (voucher ${id}): ${outcomeOf(result)}, answer ${shapeOf(result.objects)}; changed: ${changedFields(before, after) || "nothing"}`,
        );
      }
      if (made === 0) return inconclusive(`${lines.join(". ")}.`);
      return { verdict: worked > 0 ? "observed" : "contradicted", finding: `${lines.join(". ")}.` };
    },
  },
  {
    id: "write-voucher-book-amount",
    title: "bookAmount on vouchers: date formats, sign, answer, with a transaction",
    mode: "write",
    question:
      "On an open expense voucher (gross 119) on the offline account: does PUT /Voucher/{id}/bookAmount take the date as Unix seconds, an ISO date-time and dd.mm.yyyy (which calendar day does each booking's transaction get), what does it answer (VoucherLog keys), and what does a positive amount do on an expense (D-041)? And does linking a hand-made transaction (checkAccountTransaction) on a tagged file-import account pay a voucher (transaction status, log entry)?",
    deviations: ["D-041", "D-056", "D-071", "NEW"],
    async run(ctx) {
      const account = await offlineAccount(ctx);
      if (account === undefined) return inconclusive("No offline bank account (type offline).");
      const lines: string[] = [];

      // 1. Three partial bookings of −10 with three date forms, each for a different day.
      const formats = await createVoucher(ctx, { label: "book formats", status: 100 });
      if (formats.id === undefined) return inconclusive(voucherFailure(formats));
      const forms = [
        {
          label: "Unix seconds",
          day: addDays(ctx.today, -1),
          date: (day: string): number | string => berlinNoon(day),
        },
        {
          label: "ISO date-time",
          day: addDays(ctx.today, -2),
          date: (day: string): number | string => isoNoon(day),
        },
        {
          label: "dd.mm.yyyy",
          day: addDays(ctx.today, -3),
          date: (day: string): number | string => germanDate(day),
        },
      ];
      let answerShape = "";
      for (const form of forms) {
        const before = await transactionIds(ctx, account);
        const booked = await bookVoucher(ctx, formats.id, {
          checkAccount: account,
          amount: -10,
          date: form.date(form.day),
          type: "N",
        });
        answerShape ||= booked.ok ? shapeOf(booked.objects) : "";
        const created = await newTransactions(ctx, account, before);
        const row = await ctx.read.byId("Voucher", formats.id);
        lines.push(
          `−10 with ${form.label} for ${form.day}: ${outcomeOf(booked)}; voucher ${voucherState(row)}; new transaction ${created.map(describeTransaction).join(", ") || "none"}`,
        );
      }
      data(ctx).mark("Voucher", formats.id, "open voucher, partly paid (resettable)");

      // 2. A positive amount on an expense voucher.
      const positive = await createVoucher(ctx, { label: "book positive", status: 100 });
      if (positive.id === undefined) {
        lines.push(`positive amount: ${voucherFailure(positive)}`);
      } else {
        const booked = await bookVoucher(ctx, positive.id, {
          checkAccount: account,
          amount: 119,
          date: berlinNoon(ctx.today),
          type: "FULL_PAYMENT",
        });
        const row = await ctx.read.byId("Voucher", positive.id);
        if (booked.ok)
          data(ctx).mark("Voucher", positive.id, "open voucher, booked +119 (resettable)");
        lines.push(
          `+119 FULL_PAYMENT on an expense: ${outcomeOf(booked)}; voucher ${voucherState(row)}`,
        );
      }

      // 3. Linking a hand-made transaction of −119 on a file-import account (sevDesk refuses
      //    hand-made transactions on offline accounts).
      const imported = await importAccount(ctx);
      const linked = await createVoucher(ctx, { label: "book with transaction", status: 100 });
      const transaction =
        imported.id === undefined
          ? undefined
          : await createTransaction(ctx, imported.id, { amount: -119, label: "voucher payment" });
      if (imported.id === undefined || linked.id === undefined || transaction?.id === undefined) {
        lines.push(
          `with a transaction: could not prepare (${imported.id === undefined ? imported.note : linked.id === undefined ? voucherFailure(linked) : `transaction ${transaction === undefined ? "not created" : outcomeOf(transaction.result)}`})`,
        );
      } else {
        const booked = await bookVoucher(ctx, linked.id, {
          checkAccount: imported.id,
          amount: -119,
          date: berlinNoon(ctx.today),
          type: "FULL_PAYMENT",
          transaction: transaction.id,
        });
        const row = await ctx.read.byId("Voucher", linked.id);
        const after = await ctx.read.byId("CheckAccountTransaction", transaction.id);
        const log = await transactionLog(ctx, transaction.id);
        if (booked.ok)
          data(ctx).mark("Voucher", linked.id, "open voucher, paid via a transaction (resettable)");
        lines.push(
          `−119 FULL_PAYMENT linking transaction ${transaction.id} on ${imported.note}: ${outcomeOf(booked)}; voucher ${voucherState(row)}; ` +
            `transaction now ${describeTransaction(after)}; log ${log.result.ok ? `${log.rows.length} entries${log.rows[0] === undefined ? "" : ` (${describeLogEntry(log.rows[0])}; keys ${Object.keys(log.rows[0]).join(", ")})`}` : outcomeOf(log.result)}`,
        );
      }
      return {
        verdict: "observed",
        finding: `Offline account ${account}. ${lines.join(". ")}. bookAmount answer: ${answerShape || "no successful booking"}.`,
        deviations: { "D-041": "informs", "D-056": "informs", "D-071": "informs" },
      };
    },
  },
  {
    id: "write-voucher-reset",
    title: "resetToOpen and resetToDraft on a paid voucher",
    mode: "write",
    question:
      "After paying an open expense voucher in full on the offline account (no transaction given), does PUT /Voucher/{id}/resetToOpen take the payment back (status, paidAmount, payDate, the transaction sevDesk created), and does resetToDraft then make it a draft (status 50) again?",
    deviations: ["D-060", "D-071", "NEW"],
    async run(ctx) {
      const account = await offlineAccount(ctx);
      if (account === undefined) return inconclusive("No offline bank account (type offline).");
      const created = await createVoucher(ctx, { label: "reset", status: 100 });
      if (created.id === undefined) return inconclusive(voucherFailure(created));
      const id = created.id;
      const before = await transactionIds(ctx, account);
      const booked = await bookVoucher(ctx, id, {
        checkAccount: account,
        amount: -119,
        date: berlinNoon(ctx.today),
        type: "FULL_PAYMENT",
      });
      const paid = await ctx.read.byId("Voucher", id);
      const made = await newTransactions(ctx, account, before);
      if (booked.ok) data(ctx).mark("Voucher", id, "paid voucher");
      const toOpen = await ctx.http.write("PUT", `/Voucher/${id}/resetToOpen`, { tier: "commit" });
      const open = await ctx.read.byId("Voucher", id);
      const remaining = await transactionsOf(ctx, account);
      const left = made.map((row) => remaining.find((item) => str(item, "id") === str(row, "id")));
      const toDraft = await ctx.http.write("PUT", `/Voucher/${id}/resetToDraft`, {
        tier: "commit",
      });
      const draft = await ctx.read.byId("Voucher", id);
      data(ctx).mark(
        "Voucher",
        id,
        str(draft, "status") === "50"
          ? "draft voucher again (deletable)"
          : `voucher status ${str(draft, "status")}`,
      );
      return {
        verdict: "observed",
        finding:
          `Voucher ${id}: booking −119 ${outcomeOf(booked)} → ${voucherState(paid)}; created ${made.map(describeTransaction).join(", ") || "no transaction"}. ` +
          `resetToOpen ${outcomeOf(toOpen)} (answer ${shapeOf(toOpen.objects)}) → ${voucherState(open)}; ` +
          `the created transaction ${left.map((row) => (row === undefined ? "is gone" : `is still there: ${describeTransaction(row)}`)).join(", ") || "(none to check)"}. ` +
          `resetToDraft ${outcomeOf(toDraft)} → ${voucherState(draft)}.`,
        deviations: { "D-060": "informs", "D-071": "informs" },
      };
    },
  },
  {
    id: "write-voucher-save-id-status50-on-open",
    title: "saveVoucher with voucher.id and status 50 on an open voucher",
    mode: "write",
    question:
      "A draft voucher finalized with saveVoucher (id + status 100, positions null, commit): does a second saveVoucher with the same header, voucher.id and status 50 (write tier, positions null) get refused, or does it set the open voucher back to draft? The voucher is deleted at the end (after resetToDraft when needed).",
    deviations: ["NEW", "D-054"],
    async run(ctx) {
      const label = "status 50 on open";
      const created = await createVoucher(ctx, { label });
      if (created.id === undefined) return inconclusive(voucherFailure(created));
      const id = created.id;
      const finalized = await saveVoucherStatus(ctx, id, { label, status: 100 });
      const open = await ctx.read.byId("Voucher", id);
      if (str(open, "status") !== "100") {
        return inconclusive(
          `Finalizing voucher ${id} with saveVoucher ${outcomeOf(finalized)} left status ${str(open, "status")}.`,
        );
      }
      data(ctx).mark("Voucher", id, "open voucher (status 100)");
      const back = await saveVoucherStatus(ctx, id, { label, status: 50 });
      const after = await ctx.read.byId("Voucher", id);
      const toDraft = str(after, "status") === "50";
      // Cleanup: back to draft (resetToDraft when the save did not do it), then delete.
      const reset = toDraft
        ? undefined
        : await ctx.http.write("PUT", `/Voucher/${id}/resetToDraft`, { tier: "commit" });
      const deleted = await ctx.http.write("DELETE", `/Voucher/${id}`, { tier: "write" });
      const gone = isGone(await ctx.http.get(`/Voucher/${id}`));
      data(ctx).mark("Voucher", id, gone ? "deleted by the probe" : "left behind (see finding)");
      return {
        verdict: "observed",
        finding:
          `Voucher ${id} finalized (${outcomeOf(finalized)}, status 100). saveVoucher with id + status 50 (write): ` +
          `${outcomeOf(back)}; status now ${str(after, "status")}${toDraft ? " (the save set it back to draft)" : " (still open)"}; ` +
          `changed: ${changedFields(open, after) || "nothing"}. Cleanup: ${reset === undefined ? "" : `resetToDraft ${outcomeOf(reset)}, `}DELETE ${outcomeOf(deleted)}${gone ? ", gone" : ", still there"}.`,
        deviations: { "D-054": "informs" },
      };
    },
  },
  {
    id: "write-voucher-finalize-keeps-document",
    title: "Does the attached document survive finalizing and a header update?",
    mode: "write",
    question:
      "A draft voucher saved with an uploaded PDF (top-level filename) has a document. After saveVoucher with voucher.id + status 100 and positions null (no filename), does the read-back still carry the same document? And on another draft with a file: does a header update (id, status 50, new supplierName, positions null, no filename) keep the document?",
    deviations: ["D-026", "D-044", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      let kept = 0;
      let checked = 0;
      for (const variant of ["finalize (status 100)", "update a draft (status 50)"] as const) {
        const upload = await uploadTempFile(
          ctx,
          await receiptPdf(ctx, variant),
          `${slug(data(ctx).tag)}-keeps-document.pdf`,
          "application/pdf",
        );
        if (upload.token === undefined) {
          lines.push(`${variant}: upload ${outcomeOf(upload.result)}, no token`);
          continue;
        }
        const label = `keeps document ${variant.startsWith("finalize") ? "finalize" : "update"}`;
        const created = await createVoucher(ctx, {
          label,
          file: { token: upload.token, placement: "top-level" },
        });
        if (created.id === undefined) {
          lines.push(`${variant}: ${voucherFailure(created)}`);
          continue;
        }
        const id = created.id;
        const before = await ctx.read.byId("Voucher", id);
        const status = variant.startsWith("finalize") ? 100 : 50;
        const saved = await saveVoucherStatus(
          ctx,
          id,
          { label, status },
          status === 50 ? { supplierName: `${data(ctx).tag} Lieferant geändert` } : {},
        );
        const after = await ctx.read.byId("Voucher", id);
        if (status === 100 && str(after, "status") === "100") {
          data(ctx).mark("Voucher", id, "open voucher with a document (status 100)");
        }
        const was = JSON.stringify(before?.["document"] ?? null);
        const now = JSON.stringify(after?.["document"] ?? null);
        if (before?.["document"] !== undefined && before["document"] !== null) {
          checked += 1;
          if (was === now) kept += 1;
        }
        lines.push(
          `${variant} of voucher ${id}: ${outcomeOf(saved)}; status ${str(before, "status")} → ${str(after, "status")}, ` +
            `document ${was} → ${now}${was === now ? " (kept)" : " (CHANGED)"}`,
        );
      }
      if (checked === 0) return inconclusive(`${lines.join(". ")}.`);
      return {
        verdict: kept === checked ? "confirmed" : "contradicted",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-044": "informs" },
      };
    },
  },
];
