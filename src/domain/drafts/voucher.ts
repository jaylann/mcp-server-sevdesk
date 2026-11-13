/**
 * Voucher (Beleg) drafts through `POST /Voucher/Factory/saveVoucher`: create a draft (status 50)
 * or update one by sending its id, and the save every voucher write shares (create, update,
 * finalize in `voucher-finalize.ts`, the e-invoice import in `voucher-import.ts`). The checks
 * live in `voucher-checks.ts`, the wire format in `voucher-payload.ts`, the stored state in
 * `voucher-current.ts`, the tool arguments in `voucher-inputs.ts`.
 *
 * Every `prepare` validates locally first, then reads (bookkeeping generation, regime,
 * ReceiptGuidance, AccountDatev, supplier, duplicates) and builds the exact body; nothing is
 * written. {@link executeVoucherSave} uploads the receipt file when there is one
 * (`POST /Voucher/Factory/uploadTempFile`; the temp-file token goes into the top-level `filename`,
 * B5), sends the one `saveVoucher` request (never retried) and reads the voucher back
 * (`getVoucherDetails`).
 */
import { z } from "zod";

import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { parseUpstream, zIntish, zRef } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import type { TaxRegime } from "../account-settings.js";
import { cleanText } from "../common.js";
import { compare, format } from "../money.js";
import { inLanguage } from "../preview-text.js";
import type { TaxRule } from "../reference-data.js";
import {
  creditDebitForKind,
  getVoucherDetails,
  type VoucherDetails,
  type VoucherKind,
} from "../vouchers.js";
import { assertChanges, ChangeLog, draftPreview, positionCount } from "./document.js";
import { formatPeriod, resolveDeliveryPeriod, todayInBerlin, wireDocumentDate } from "./fields.js";
import { savedDocumentId, strictBody } from "./payloads.js";
import type { Amounts } from "./positions.js";
import { type DraftPreview, fact, moneyText, type PreviewFact, totalsText } from "./preview.js";
import { readBack } from "./read-back.js";
import { taxRuleLabel } from "./tax.js";
import {
  type AmountMode,
  assertUpdate2,
  checkVoucherAccounts,
  duplicateCheck,
  expectedVoucherTotals,
  findVoucherDuplicates,
  kindText,
  loadSupplierName,
  partyLabel,
  readReceiptFile,
  receiptText,
  resolveVoucherPositions,
  resolveVoucherRule,
  supplierText,
  type VoucherCallOptions,
  type VoucherPosition,
  voucherPositionAmounts,
  type VoucherPositionInput,
  voucherRegime,
  voucherRuleScope,
} from "./voucher-checks.js";
import {
  carriedVoucher,
  checkDraft,
  loadStoredVoucher,
  nonBlank,
  storedAmountMode,
  storedPositionsFor,
  storedRule,
  storedTotal,
} from "./voucher-current.js";
import type { VoucherCreateArgs, VoucherUpdateArgs } from "./voucher-inputs.js";
import {
  exactJsonNumber,
  readUploadAnswer,
  type ReceiptFile,
  type SaveVoucherBody,
  saveVoucherBodySchema,
  type UploadedReceipt,
  uploadForm,
  VOUCHER_DRAFT_STATUS,
  voucherPosDelete,
  type VoucherPositionPayload,
  voucherRef,
} from "./voucher-payload.js";

const FINALIZE_TOOL = "sevdesk_voucher_finalize";

// ---------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------

/** What `execute` needs: the exact body the preview describes, and the file to upload first. */
export interface VoucherSaveState {
  readonly body: SaveVoucherBody;
  readonly file?: ReceiptFile | undefined;
  /** Set for updates and the finalize: the voucher the save must keep. */
  readonly voucherId?: number | undefined;
  /** Expected totals when the call set the positions. */
  readonly expected?: Amounts | undefined;
  /** The status the voucher must have afterwards (50 draft, 100 open). */
  readonly expectStatus: number;
  /** Set by the e-invoice import: no "use the import" hint when sevDesk sees an e-invoice. */
  readonly fromEInvoice?: boolean | undefined;
  /**
   * Updates and the finalize: re-read the voucher right before the save and refuse when it is no
   * longer a draft (it changed after the preview; `saveVoucher` with an id would otherwise rewrite
   * a booked voucher).
   */
  readonly recheckDraft?: boolean | undefined;
  /** The stored voucher had a receipt attached and this save sends no new one: check it stays. */
  readonly keepsDocument?: boolean | undefined;
}

export interface VoucherSavePlan {
  readonly preview: DraftPreview;
  /** The German preview: set by the finalize, which a human confirms (see `preview-text.ts`). */
  readonly previewDe?: DraftPreview;
  readonly state: VoucherSaveState;
}

/** Extra preview content of a create made by another tool (the e-invoice import). */
export interface CreateExtras {
  /** Appended to the action sentence, e.g. " from e-invoice RE-4711". */
  readonly source?: string | undefined;
  readonly facts?: readonly PreviewFact[] | undefined;
  readonly warnings?: readonly string[] | undefined;
  /** Called with the computed totals before anything is read; throws to refuse. */
  readonly checkTotals?:
    ((totals: Amounts, positions: readonly VoucherPosition[], rule: TaxRule) => void) | undefined;
}

/** A create call with defaults applied and the file already read. */
export interface VoucherCreateSpec {
  readonly kind: VoucherKind;
  readonly supplierId?: number | undefined;
  readonly supplierName?: string | undefined;
  readonly number?: string | undefined;
  readonly date: string;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly paymentDeadline?: string | undefined;
  readonly taxRuleId?: number | undefined;
  readonly amountMode: AmountMode;
  readonly positions: readonly VoucherPositionInput[];
  readonly allowDuplicate: boolean;
}

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** Prepares a new draft voucher: validates, reads the file, checks, builds body and preview. */
export async function prepareVoucherCreate(
  client: SevdeskClient,
  args: VoucherCreateArgs,
  options: VoucherCallOptions,
): Promise<VoucherSavePlan> {
  checkSupplierArgs(args.supplierId, args.supplierName, true);
  const file =
    args.file === undefined ? undefined : await readReceiptFile(options.files, args.file);
  return prepareVoucherCreateSpec(
    client,
    {
      kind: args.kind ?? "expense",
      supplierId: args.supplierId,
      supplierName: args.supplierName,
      number: args.number,
      date: args.date ?? todayInBerlin(),
      deliveryDate: args.deliveryDate,
      deliveryDateUntil: args.deliveryDateUntil,
      paymentDeadline: args.paymentDeadline,
      taxRuleId: args.taxRuleId,
      amountMode: args.amountMode ?? "gross",
      positions: args.positions,
      allowDuplicate: args.allowDuplicate === true,
    },
    file,
    options,
  );
}

/**
 * The create path behind `sevdesk_voucher_create_draft` and the e-invoice import: everything
 * after the arguments are known and the file is read.
 */
export async function prepareVoucherCreateSpec(
  client: SevdeskClient,
  spec: VoucherCreateSpec,
  file: ReceiptFile | undefined,
  options: VoucherCallOptions,
  extras: CreateExtras = {},
): Promise<VoucherSavePlan> {
  const { signal } = options;
  checkSupplierArgs(spec.supplierId, spec.supplierName, true);
  const delivery = resolveDeliveryPeriod(
    spec.date,
    spec.deliveryDate,
    spec.deliveryDateUntil,
    false,
  );
  await assertUpdate2(client, signal, options.cacheOwner);
  const regime = await voucherRegime(client, options);
  const { rule, warnings: ruleWarnings } = resolveVoucherRule(spec.kind, spec.taxRuleId, regime);
  const positions = resolveVoucherPositions(rule, spec.positions, regime);
  const expected = expectedVoucherTotals(positions, spec.amountMode);
  extras.checkTotals?.(expected, positions, rule);
  const accounts = await checkVoucherAccounts(
    client,
    spec.kind,
    rule,
    positions,
    spec.date,
    options,
  );
  const supplierName =
    spec.supplierId === undefined
      ? spec.supplierName
      : await loadSupplierName(client, spec.supplierId, signal);
  const duplicateQuery = {
    kind: spec.kind,
    supplierId: spec.supplierId,
    supplierName: spec.supplierName,
    number: spec.number,
    date: spec.date,
    gross: expected.gross,
  };
  const duplicate = duplicateCheck(
    await findVoucherDuplicates(client, duplicateQuery, signal),
    duplicateQuery,
    spec.allowDuplicate,
  );

  const body = strictBody(
    saveVoucherBodySchema,
    {
      voucher: {
        objectName: "Voucher",
        mapAll: true,
        voucherDate: wireDocumentDate(spec.date),
        supplier: spec.supplierId === undefined ? null : voucherRef(spec.supplierId, "Contact"),
        supplierName: spec.supplierId === undefined ? spec.supplierName : undefined,
        description: spec.number,
        paymentDeadline:
          spec.paymentDeadline === undefined ? undefined : wireDocumentDate(spec.paymentDeadline),
        deliveryDate: wireDocumentDate(delivery.from),
        deliveryDateUntil:
          delivery.until === undefined ? undefined : wireDocumentDate(delivery.until),
        status: VOUCHER_DRAFT_STATUS,
        taxRule: voucherRef(rule.id, "TaxRule"),
        creditDebit: creditDebitForKind(spec.kind),
        voucherType: "VOU",
        currency: "EUR",
      },
      voucherPosSave: positions.map((position) => positionPayload(position, spec.amountMode)),
      voucherPosDelete: null,
    },
    "voucher",
  );

  const supplier = supplierText(supplierName, spec.supplierId);
  const facts: PreviewFact[] = [
    fact("Kind", kindText(spec.kind)),
    fact(partyLabel(spec.kind), supplier),
    fact("Belegnummer", spec.number ?? "(none)"),
    fact("Voucher date (Belegdatum)", spec.date),
    fact("Delivery date (Leistungsdatum)", formatPeriod(delivery)),
    ...(spec.paymentDeadline === undefined
      ? []
      : [fact("Payment deadline (Fälligkeit)", spec.paymentDeadline)]),
    fact("Tax rule (Steuerregel)", taxRuleLabel(rule)),
    fact("Amounts entered as", spec.amountMode),
    ...positionFacts(positions, spec.amountMode, accounts.labels),
    fact("Total (expected)", totalsText(expected, "EUR")),
    ...(file === undefined ? [] : [fact("Receipt file (Belegbild)", receiptText(file))]),
    ...(extras.facts ?? []),
    fact("Status after saving", `draft (${String(VOUCHER_DRAFT_STATUS)}), not booked yet`),
  ];
  // The action holds only our wording, dates and amounts; supplier, Belegnummer and file name are
  // third-party or local text and appear as fact values only.
  const preview = draftPreview(
    `Create a draft ${spec.kind} voucher (Beleg) dated ${spec.date}${extras.source ?? ""}, ` +
      `with ${positionCount(positions.length)}, gross ${moneyText(expected.gross, "EUR")}` +
      `${file === undefined ? "" : ", and attach the receipt file"}.`,
    facts,
    [
      duplicate,
      ...ruleWarnings,
      ...inLanguage(accounts.warnings, "en"),
      ...deadlineWarnings(spec.date, spec.paymentDeadline),
      ...(extras.warnings ?? []),
      ...(spec.number === undefined
        ? [
            "No Belegnummer: sevDesk saves the draft but books it only with one (D-080); add " +
              "it with sevdesk_voucher_update_draft (number) before finalizing.",
          ]
        : []),
      `The voucher is saved as a draft: it is not booked until ${FINALIZE_TOOL} finalizes it.`,
    ],
  );
  return { preview, state: { body, file, expected, expectStatus: VOUCHER_DRAFT_STATUS } };
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

/** Prepares an update of a draft voucher (header fields, all positions, an attached file). */
export async function prepareVoucherUpdate(
  client: SevdeskClient,
  args: VoucherUpdateArgs,
  options: VoucherCallOptions,
): Promise<VoucherSavePlan> {
  const { signal } = options;
  assertChanges(args, "voucher");
  checkSupplierArgs(args.supplierId, args.supplierName, false);
  const file =
    args.file === undefined ? undefined : await readReceiptFile(options.files, args.file);
  const stored = await loadStoredVoucher(client, args.id, signal);
  const kind = checkDraft(stored, "changed");
  await assertUpdate2(client, signal, options.cacheOwner);
  const regime = await voucherRegime(client, options);

  const storedMode = storedAmountMode(stored.positions);
  const mode = args.amountMode ?? storedMode;
  if (mode !== storedMode && args.positions === undefined) {
    refuse(
      `Changing amountMode from ${storedMode} to ${mode} would make sevDesk read every stored ` +
        `amount as ${mode}. Pass the positions again with ${mode} amounts.`,
    );
  }

  const warnings: string[] = [];
  let rule: TaxRule;
  if (args.taxRuleId === undefined) {
    rule = storedRule(stored, "Pass taxRuleId to set one.");
    warnings.push(...keptRuleWarnings(rule, kind, regime));
  } else {
    const resolved = resolveVoucherRule(kind, args.taxRuleId, regime);
    rule = resolved.rule;
    warnings.push(...resolved.warnings);
  }

  let positions: VoucherPosition[] | undefined;
  let labels: ReadonlyMap<number, string> = new Map();
  const date = args.date ?? stored.dates.voucherDate ?? todayInBerlin();
  if (args.positions !== undefined) {
    positions = resolveVoucherPositions(rule, args.positions, regime);
    const check = await checkVoucherAccounts(client, kind, rule, positions, date, options);
    labels = check.labels;
    warnings.push(...inLanguage(check.warnings, "en"));
  } else if (args.taxRuleId !== undefined) {
    const kept = storedPositionsFor(stored, rule, regime);
    const check = await checkVoucherAccounts(client, kind, rule, kept, date, options);
    warnings.push(...inLanguage(check.warnings, "en"));
  }

  const delivery = resolveDeliveryPeriod(
    date,
    args.deliveryDate ?? stored.dates.deliveryDate ?? date,
    args.deliveryDateUntil ?? stored.dates.deliveryDateUntil,
    false,
  );
  const paymentDeadline = args.paymentDeadline ?? stored.dates.paymentDeadline;
  const record = stored.record;
  const supplierId =
    args.supplierId ?? (args.supplierName === undefined ? record.supplier?.id : undefined);
  const supplierName =
    args.supplierName ??
    (args.supplierId === undefined ? nonBlank(record.supplierName) : undefined);
  const supplierChanged = args.supplierId !== undefined || args.supplierName !== undefined;
  const shownName =
    args.supplierId === undefined
      ? supplierName
      : await loadSupplierName(client, args.supplierId, signal);
  const expected = positions === undefined ? undefined : expectedVoucherTotals(positions, mode);

  const body = strictBody(
    saveVoucherBodySchema,
    {
      voucher: carriedVoucher(stored, {
        status: VOUCHER_DRAFT_STATUS,
        voucherDate: date,
        supplierId,
        // A new contact gets no stale typed-in name; an unchanged supplier keeps the stored one.
        supplierName,
        description: args.number ?? nonBlank(record.description),
        paymentDeadline,
        deliveryDate: delivery.from,
        deliveryDateUntil: delivery.until,
        taxRuleId: rule.id,
      }),
      voucherPosSave:
        positions === undefined
          ? null
          : positions.map((position) => positionPayload(position, mode)),
      voucherPosDelete:
        positions === undefined ? null : voucherPosDelete(stored.positions.map((row) => row.id)),
    },
    "voucher",
  );

  const log = new ChangeLog();
  if (supplierChanged) {
    log.value(
      "supplier",
      partyLabel(kind),
      supplierText(nonBlank(record.supplierName), record.supplier?.id),
      supplierText(shownName, supplierId),
    );
  }
  if (args.number !== undefined) {
    log.value("Belegnummer", "Belegnummer", cleanText(record.description, 100), args.number);
  }
  log.value("date", "Voucher date (Belegdatum)", stored.dates.voucherDate, date);
  log.value(
    "delivery date",
    "Delivery date (Leistungsdatum)",
    stored.dates.deliveryDate === undefined
      ? undefined
      : formatPeriod({ from: stored.dates.deliveryDate, until: stored.dates.deliveryDateUntil }),
    formatPeriod(delivery),
  );
  log.value(
    "payment deadline",
    "Payment deadline (Fälligkeit)",
    stored.dates.paymentDeadline,
    paymentDeadline,
  );
  if (args.taxRuleId !== undefined) {
    log.value(
      "tax rule",
      "Tax rule (Steuerregel)",
      record.taxRule === undefined ? undefined : `tax rule ${String(record.taxRule.id)}`,
      taxRuleLabel(rule),
    );
  }
  if (mode !== storedMode) log.value("amount mode", "Amounts entered as", storedMode, mode);
  if (positions !== undefined) {
    log.note(
      "positions",
      "Positions",
      `replace ${positionCount(stored.positions.length)} with ${positionCount(positions.length)}`,
    );
  }
  if (file !== undefined)
    log.note("file", "Receipt file (Belegbild)", `attach ${receiptText(file)}`);

  if (file !== undefined && stored.hasDocument === true) {
    warnings.push(
      "The voucher already has an attached file. sevDesk attaches the new one; whether the " +
        "earlier file stays attached is not documented.",
    );
  }
  const facts: PreviewFact[] = [
    fact("Voucher (Beleg)", `${String(record.id)}, draft`),
    fact("Kind", kindText(kind)),
    ...log.facts,
    ...(positions === undefined ? [] : positionFacts(positions, mode, labels)),
    expected === undefined
      ? fact("Total (unchanged)", storedTotal(stored))
      : fact("Total (expected)", totalsText(expected, "EUR")),
  ];
  const preview = draftPreview(
    `Update draft voucher ${String(record.id)}: change ` +
      `${log.changed.join(", ") || "nothing visible"}.`,
    facts,
    [...warnings, ...deadlineWarnings(date, paymentDeadline)],
  );
  return {
    preview,
    state: {
      body,
      file,
      voucherId: record.id,
      expected,
      expectStatus: VOUCHER_DRAFT_STATUS,
      recheckDraft: true,
      keepsDocument: file === undefined && stored.hasDocument === true,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Execute (create, update, finalize)
// ---------------------------------------------------------------------------------------------

/** Result of a saved voucher: the read-back voucher and trusted notes. */
export interface VoucherSaveResult {
  readonly id: number;
  readonly details: VoucherDetails;
  readonly notes: readonly string[];
  /**
   * Attachment identity from the recheck immediately before an update: `null` means no
   * attachment, `undefined` means unknown (or no recheck). A different read-back document id
   * confirms a new attachment; mere document presence cannot confirm replacement of a receipt.
   */
  readonly previousDocumentId?: number | null | undefined;
  /** The uploaded receipt (name, kind, size, pages), when a file was attached. */
  readonly receipt?:
    | {
        readonly name: string;
        readonly kind: string;
        readonly bytes: number;
        readonly pages?: number;
      }
    | undefined;
}

/**
 * Uploads the receipt (if any), sends the prepared `saveVoucher` (one request each, never
 * retried) and reads the voucher back.
 */
export async function executeVoucherSave(
  client: SevdeskClient,
  state: VoucherSaveState,
  signal: AbortSignal | undefined,
): Promise<VoucherSaveResult> {
  const withSignal = signal === undefined ? {} : { signal };
  const previousDocumentId =
    state.recheckDraft === true && state.voucherId !== undefined
      ? await assertStillDraft(client, state.voucherId, signal)
      : undefined;
  let uploaded: UploadedReceipt | undefined;
  if (state.file !== undefined) {
    uploaded = readUploadAnswer(
      await client.request({
        method: "POST",
        path: "/Voucher/Factory/uploadTempFile",
        form: uploadForm(state.file),
        ...withSignal,
      }),
    );
  }
  const body =
    uploaded === undefined
      ? state.body
      : strictBody(
          saveVoucherBodySchema,
          { ...state.body, filename: uploaded.filename },
          "voucher",
        );

  let response: unknown;
  try {
    response = await client.request({
      method: "POST",
      path: "/Voucher/Factory/saveVoucher",
      body,
      ...withSignal,
    });
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    const mapped = notDraftAnymore(error, state.voucherId);
    throw uploaded === undefined ? mapped : afterUpload(mapped);
  }
  const id = savedId(response, state.voucherId);
  const saved = { objectName: "Voucher", id: String(id) };
  if (state.voucherId !== undefined && id !== state.voucherId) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk saved voucher ${String(id)} instead of changing voucher ` +
        `${String(state.voucherId)}. Check both in sevDesk and delete the extra one there ` +
        "before repeating the call.",
      completedWrites: [saved],
    });
  }
  const details = await readBack(saved, () => getVoucherDetails(client, id, signal));
  const receipt =
    state.file === undefined
      ? undefined
      : {
          name: cleanText(state.file.name, 200) ?? "file",
          kind: state.file.kind,
          bytes: state.file.bytes.length,
          ...(uploaded?.pages === undefined ? {} : { pages: uploaded.pages }),
        };
  const notes = readBackNotes(details, state);
  if (uploaded?.isEInvoice === true && state.fromEInvoice !== true) {
    notes.push(
      "sevDesk recognized the attached file as an e-invoice. Its data was not used: " +
        "sevdesk_voucher_import_einvoice can check it and prefill a voucher from it.",
    );
  }
  return { id, details, notes, receipt, previousDocumentId };
}

/**
 * Refuses (validation, nothing sent) when the voucher is no longer an unlocked draft right before
 * an update or finalize saves it: it was finalized or enshrined after the preview.
 * Returns the current attachment id, `null` for explicitly absent, `undefined` for unknown.
 * The snapshot from `prepare` may be stale; compare this id with the save's read-back instead.
 */
async function assertStillDraft(
  client: SevdeskClient,
  voucherId: number,
  signal: AbortSignal | undefined,
): Promise<number | null | undefined> {
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Voucher", voucherId),
    ...(signal === undefined ? {} : { signal }),
  });
  const record = parseUpstream(
    z.object({ status: zIntish, enshrined: z.unknown().optional(), document: zRef().nullish() }),
    expectSingle(payload, `voucher ${String(voucherId)}`),
    "a voucher",
  );
  const enshrined =
    record.enshrined !== undefined && record.enshrined !== null && record.enshrined !== "";
  if (record.status !== VOUCHER_DRAFT_STATUS || enshrined) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Voucher ${String(voucherId)} is no longer an unlocked draft (status ` +
        `${String(record.status)}${enshrined ? ", enshrined" : ""}): it changed after the ` +
        "preview. Nothing was sent to sevDesk; check it with sevdesk_voucher_get and prepare " +
        "the call again.",
    });
  }
  return record.document === null ? null : record.document?.id;
}

/**
 * sevDesk's refusal to save a voucher that is no longer a draft (M4 probe run 4: saveVoucher with
 * an id and status 50 on an open voucher → 400 "You can only update draft documents. Use
 * resetToDraft first.") as a trusted message; any other error is returned unchanged.
 */
function notDraftAnymore(error: SevdeskError, voucherId: number | undefined): SevdeskError {
  if (
    voucherId === undefined ||
    error.kind !== "validation" ||
    !/only update draft/i.test(error.upstreamMessage ?? "")
  ) {
    return error;
  }
  return new SevdeskError({
    kind: "validation",
    message:
      `sevDesk refused to change voucher ${String(voucherId)}: it is no longer a draft (it was ` +
      "finalized after the preview). Nothing was changed. If the change is still needed, reset " +
      'it to draft first with sevdesk_voucher_reset (to "draft").',
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
    cause: error,
  });
}

/**
 * The voucher id in a save answer. For an update or finalize the voucher is known, so an answer
 * without an id says so in update wording and names the voucher as written.
 */
function savedId(response: unknown, voucherId: number | undefined): number {
  try {
    return savedDocumentId(response, "voucher", "voucher");
  } catch (error) {
    if (voucherId === undefined || !(error instanceof SevdeskError)) throw error;
    throw new SevdeskError({
      kind: error.kind,
      message:
        `sevDesk accepted the save of voucher ${String(voucherId)}, but its answer did not name ` +
        "the voucher, so it could not be read back. Do not repeat the call; check the voucher " +
        "with sevdesk_voucher_get.",
      cause: error,
      completedWrites: [{ objectName: "Voucher", id: String(voucherId) }],
    });
  }
}

/**
 * A failed save after a successful upload: the uploaded temp file is not a record, so there is
 * nothing to clean up (no completed write), but the message says what happened. When the failure
 * leaves it open whether sevDesk saved (timeout, network, server error), it says so.
 */
function afterUpload(error: SevdeskError): SevdeskError {
  const unknownOutcome = ["timeout", "network", "server", "aborted"].includes(error.kind);
  return new SevdeskError({
    kind: error.kind,
    message:
      `${error.message} The receipt file had been uploaded to sevDesk's temporary file storage ` +
      "first; that upload is not a voucher or a document and needs no cleanup. " +
      (unknownOutcome
        ? "Whether the voucher itself was saved is unknown: check sevdesk_vouchers_list before " +
          "repeating the call."
        : "The voucher was not saved."),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.exceptionUuid === undefined ? {} : { exceptionUuid: error.exceptionUuid }),
    ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.path === undefined ? {} : { path: error.path }),
    cause: error,
    completedWrites: error.completedWrites,
  });
}

/** Trusted notes about what the read-back shows (empty when everything matches). */
function readBackNotes(details: VoucherDetails, state: VoucherSaveState): string[] {
  const notes: string[] = [];
  const { voucher } = details;
  const gross = voucher.totals.gross?.amount;
  if (
    state.expected !== undefined &&
    gross !== undefined &&
    compare(gross, state.expected.gross) !== 0
  ) {
    notes.push(
      `sevDesk computed a gross total of ${gross} EUR; the preview expected ` +
        `${state.expected.gross} EUR. Check the positions and amountMode (gross/net) before ` +
        `finalizing.`,
    );
  }
  if (voucher.status !== undefined && voucher.status.code !== state.expectStatus) {
    notes.push(
      `The voucher reads back with status ${String(voucher.status.code)} ` +
        `(${voucher.status.label}), not ${String(state.expectStatus)}. Check it in sevDesk.`,
    );
  }
  if (state.keepsDocument === true && voucher.hasDocument !== true) {
    notes.push(
      "The voucher had a receipt file attached before this call, and sevDesk's answer after the " +
        "save does not show it anymore. Check the voucher in sevDesk and attach the receipt " +
        "again if it is missing.",
    );
  }
  if (state.file !== undefined) {
    if (voucher.hasDocument === false) {
      notes.push(
        "sevDesk reports no attached file although the receipt was uploaded and sent as the " +
          "voucher's filename. Check the voucher in sevDesk and attach the receipt there.",
      );
    } else if (voucher.hasDocument === undefined) {
      notes.push(
        "sevDesk's answer does not say whether the receipt file is attached (spec/deviations.md " +
          "D-044); check the voucher in sevDesk once.",
      );
    }
  }
  if (!details.positionsComplete) {
    notes.push("sevDesk has more positions than could be read back; positions is partial.");
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** One position as sent: `net` and only the sum sevDesk reads with it. */
function positionPayload(position: VoucherPosition, mode: AmountMode): VoucherPositionPayload {
  const sum = exactJsonNumber(position.amount);
  return {
    objectName: "VoucherPos",
    mapAll: true,
    accountDatev: voucherRef(position.accountDatevId, "AccountDatev"),
    taxRate: position.taxRateNumber,
    net: mode === "net",
    ...(mode === "net" ? { sumNet: sum } : { sumGross: sum }),
    ...(position.comment === undefined ? {} : { comment: position.comment }),
    isAsset: position.isAsset,
  };
}

/** Warnings for a stored rule kept by an update although it does not fit. */
function keptRuleWarnings(
  rule: TaxRule,
  kind: VoucherKind,
  regime: TaxRegime | undefined,
): string[] {
  const warnings: string[] = [];
  if (!voucherRuleScope(kind).allowedRuleIds.includes(rule.id)) {
    warnings.push(
      `The draft keeps tax rule ${String(rule.id)} (${rule.nameDe}), which is not a rule for ` +
        `${kind} vouchers; pass taxRuleId to fix it before finalizing.`,
    );
  } else if (regime !== undefined && !rule.regimes.includes(regime)) {
    warnings.push(
      `The draft keeps tax rule ${String(rule.id)} (${rule.nameDe}), which does not fit this ` +
        "account's VAT regulation: sevDesk will refuse to book it. Pass taxRuleId to fix it.",
    );
  }
  if (rule.notSupportedFor?.includes("vouchers") === true) {
    warnings.push(
      `Tax rule ${String(rule.id)} is not supported for vouchers; pass taxRuleId to fix it.`,
    );
  }
  return warnings;
}

function positionFacts(
  positions: readonly VoucherPosition[],
  mode: AmountMode,
  labels: ReadonlyMap<number, string>,
): PreviewFact[] {
  return positions.map((position, index) => {
    const amounts = voucherPositionAmounts(position, mode);
    const comment = position.comment === undefined ? "" : `; ${position.comment}`;
    const asset = position.isAsset ? " (Anlagegut)" : "";
    return fact(
      `Position ${String(index + 1)}`,
      `${labels.get(position.accountDatevId) ?? `account ${String(position.accountDatevId)}`}: ` +
        `${moneyText(format(position.amount, 2), "EUR")} ${mode}, ${position.taxRate} % VAT → ` +
        `net ${amounts.net}, tax ${amounts.tax}, gross ${amounts.gross}${asset}${comment}`,
    );
  });
}

/** Refuses both supplier fields together, and (on create) neither. */
function checkSupplierArgs(
  supplierId: number | undefined,
  supplierName: string | undefined,
  required: boolean,
): void {
  if (supplierId !== undefined && supplierName !== undefined) {
    refuse("Pass either supplierId (a contact) or supplierName (text), not both.");
  }
  if (required && supplierId === undefined && supplierName === undefined) {
    refuse(
      "Name the supplier (Lieferant; the customer of a revenue voucher): supplierId from " +
        "sevdesk_contacts_search, or supplierName as text.",
    );
  }
}

function deadlineWarnings(date: string, deadline: string | undefined): string[] {
  return deadline !== undefined && deadline < date
    ? [`The payment deadline ${deadline} is before the voucher date ${date}.`]
    : [];
}
