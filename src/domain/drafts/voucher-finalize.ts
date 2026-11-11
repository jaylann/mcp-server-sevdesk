/**
 * The finalize (draft 50 → open 100) and the delete of a draft voucher (Beleg).
 *
 * Finalize: sevDesk documents no finalize endpoint for vouchers; `resetToDraft`'s description
 * says "To change to higher status use /Voucher/Factory/saveVoucher" and `saveVoucher` takes
 * status 50 or 100; `PUT /Voucher/{id}` with `status: 100` answers 400 "You cannot change the
 * status this way. Use /Voucher/Factory/saveVoucher instead." (M4 probe, 2026-11-08). So
 * `saveVoucher` with `voucher.id`, `status: 100`, every stored field carried over and the
 * positions left alone (`voucherPosSave`/`voucherPosDelete` null) books the voucher (probe:
 * 50 → 100); built in {@link finalizeBody}. The HTTP client requires the commit tier
 * for a `saveVoucher` body whose status is not 50. The save itself runs through
 * `executeVoucherSave` (`voucher.ts`).
 *
 * Delete: `DELETE /Voucher/{voucherId}` is undocumented (spec/deviations.md D-024); the M4 probe
 * deleted a draft (GET then 404) and saw 409 "Voucher can only be deleted in status 50 but is
 * status 100" on an open one. Drafts only, refused locally first; a GET afterwards confirms it.
 */
import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { type LifecycleDocument, readLifecycleDocument, statusOf } from "../lifecycle/documents.js";
import { documentFacts, documentTitle } from "../lifecycle/preview.js";
import {
  bothPreviews,
  dateText,
  inLanguage,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../preview-text.js";
import type { TaxRule } from "../reference-data.js";
import type { VoucherDetailDto } from "../vouchers.js";
import { todayInBerlin } from "./fields.js";
import { strictBody } from "./payloads.js";
import { type DraftPreview, fact, type PreviewFact } from "./preview.js";
import { checkTaxRuleRegime, checkTaxRuleUseCase, regimeReason, taxRuleLabel } from "./tax.js";
import type { VoucherSavePlan } from "./voucher.js";
import {
  assertUpdate2,
  checkVoucherAccounts,
  kindText,
  partyLabel,
  supplierText,
  type VoucherCallOptions,
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
  storedPositionText,
  storedRule,
  storedTotal,
  type StoredVoucher,
} from "./voucher-current.js";
import {
  type SaveVoucherBody,
  saveVoucherBodySchema,
  VOUCHER_DRAFT_STATUS,
  VOUCHER_OPEN_STATUS,
} from "./voucher-payload.js";

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

// ---------------------------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------------------------

/** The fact labels and fixed values of the finalize preview, per language. */
const FINALIZE_TEXT = {
  en: {
    voucher: "Voucher (Beleg)",
    draft: "draft",
    open: "open",
    kind: "Kind",
    noNumber: "(none)",
    date: "Voucher date (Belegdatum)",
    noDate: "(none)",
    rule: "Tax rule (Steuerregel)",
    account: "account",
    total: "Total",
  },
  de: {
    voucher: "Beleg",
    draft: "Entwurf",
    open: "offen",
    kind: "Art",
    noNumber: "(keine)",
    date: "Belegdatum",
    noDate: "(keins)",
    rule: "Steuerregel",
    account: "Konto",
    total: "Summe",
  },
} as const;

/**
 * Prepares the finalize of a draft voucher (50 → open 100): the stored voucher must be a complete
 * Update 2.0 draft whose tax rule fits the account's regime and whose every position passes the
 * ReceiptGuidance check, since sevDesk refuses those only when booking.
 */
export async function prepareVoucherFinalize(
  client: SevdeskClient,
  voucherId: number,
  options: VoucherCallOptions,
): Promise<VoucherSavePlan & { readonly previewDe: DraftPreview; readonly binding: string }> {
  const { signal } = options;
  const stored = await loadStoredVoucher(client, voucherId, signal);
  const id = stored.record.id;
  if (stored.record.status === VOUCHER_OPEN_STATUS || stored.record.status > VOUCHER_OPEN_STATUS) {
    refuse(
      `Voucher ${String(id)} is already finalized (status ${String(stored.record.status)}); ` +
        "there is nothing to do. Book its payment with sevdesk_voucher_book_payment.",
    );
  }
  const kind = checkDraft(stored, "finalized");
  await assertUpdate2(client, signal);
  if (stored.positions.length === 0) {
    refuse(
      `Voucher ${String(id)} has no positions. Add them with sevdesk_voucher_update_draft first.`,
    );
  }
  // D-080: a draft may lack the Belegnummer, but sevDesk refuses to book one without it.
  if (nonBlank(stored.record.description) === undefined) {
    refuse(
      `Voucher ${String(id)} has no Belegnummer, and sevDesk books no voucher without one. Set ` +
        "it with sevdesk_voucher_update_draft (number) first: the receipt's invoice or receipt " +
        "number, or your own reference if it has none.",
    );
  }
  const regime = await voucherRegime(client, options);
  const rule = storedRule(stored, "Set one with sevdesk_voucher_update_draft (taxRuleId) first.");
  const scope = voucherRuleScope(kind);
  if (!scope.allowedRuleIds.includes(rule.id)) {
    refuse(
      `Voucher ${String(id)} has tax rule ${String(rule.id)} (${rule.nameDe}), which is not a ` +
        `rule for ${kind} vouchers. Change it with sevdesk_voucher_update_draft (taxRuleId) first.`,
    );
  }
  checkTaxRuleRegime(
    rule,
    regime,
    scope,
    (bad, actual) =>
      `${regimeReason(bad, actual, "vouchers")} Change the tax rule of voucher ${String(id)} ` +
      "with sevdesk_voucher_update_draft (taxRuleId) first.",
  );
  checkTaxRuleUseCase(rule, "vouchers", "voucher");
  const kept = storedPositionsFor(stored, rule, regime);
  const date = stored.dates.voucherDate ?? todayInBerlin();
  const accounts = await checkVoucherAccounts(client, kind, rule, kept, date, options);

  const body = finalizeBody(stored, rule);
  const mode = storedAmountMode(stored.positions);
  const facts = (lang: PreviewLanguage): PreviewFact[] => {
    const t = FINALIZE_TEXT[lang];
    return [
      fact(t.voucher, `${String(id)}, ${t.draft}`),
      fact(t.kind, kindText(kind, lang)),
      fact(
        partyLabel(kind, lang),
        supplierText(nonBlank(stored.record.supplierName), stored.record.supplier?.id, lang),
      ),
      fact("Belegnummer", stored.record.description ?? t.noNumber),
      fact(
        t.date,
        stored.dates.voucherDate === undefined
          ? t.noDate
          : dateText(stored.dates.voucherDate, lang),
      ),
      fact(t.rule, taxRuleLabel(rule)),
      ...stored.positions.map((row, index) =>
        fact(
          `Position ${String(index + 1)}`,
          `${(lang === "de" ? accounts.labelsDe : accounts.labels).get(row.accountDatev?.id ?? 0) ?? t.account}: ` +
            storedPositionText(row, mode, lang),
        ),
      ),
      fact(t.total, storedTotal(stored, lang)),
      fact(
        "Status",
        `${t.draft} ${String(VOUCHER_DRAFT_STATUS)} → ${t.open} ${String(VOUCHER_OPEN_STATUS)}`,
      ),
    ];
  };
  const warnings: Phrase[] = [
    phrase(
      "Finalizing books the voucher (open 100): it counts in the books (EÜR, UStVA) from now " +
        "on and its payment can be booked (sevdesk_voucher_book_payment). While it is not " +
        "enshrined it can be reset to draft with sevdesk_voucher_reset.",
      "Das Fertigstellen verbucht den Beleg (offen 100): Er zählt ab jetzt in der Buchhaltung " +
        "(EÜR, UStVA), und seine Zahlung kann gebucht werden (sevdesk_voucher_book_payment). " +
        "Solange er nicht festgeschrieben ist, lässt er sich mit sevdesk_voucher_reset auf " +
        "Entwurf zurücksetzen.",
    ),
    ...(stored.hasDocument === false
      ? [
          phrase(
            "The voucher has no receipt file attached; GoBD expects the receipt with the " +
              "voucher.",
            "An diesem Beleg hängt keine Belegdatei; nach den GoBD gehört der Originalbeleg dazu.",
          ),
        ]
      : []),
    ...(regime === undefined
      ? [
          phrase(
            "The VAT regulation of this sevDesk account could not be read, so the tax rule " +
              "was not checked against it; sevDesk refuses to book a rule that does not fit.",
            "Die Umsatzsteuerregelung dieses sevDesk-Kontos konnte nicht gelesen werden, daher " +
              "wurde die Steuerregel nicht dagegen geprüft; eine unpassende Regel lehnt sevDesk " +
              "beim Buchen ab.",
          ),
        ]
      : []),
    ...accounts.warnings,
  ];
  return {
    ...bothPreviews((lang) => ({
      action:
        lang === "de"
          ? `Belegentwurf ${String(id)} fertigstellen (${kind === "expense" ? "Ausgabe" : "Einnahme"}, ` +
            `brutto ${storedTotal(stored, lang)}): Entwurf → offen, verbucht.`
          : `Finalize draft voucher ${String(id)} (${kind}, gross ${storedTotal(stored)}): ` +
            `draft → open, booked.`,
      facts: facts(lang),
      warnings: inLanguage(warnings, lang),
      irreversible: false,
    })),
    // The approval covers the exact save payload and the stored voucher, positions included: the
    // preview leaves out dates such as the delivery date and the payment deadline, and a draft
    // changed after the human was asked must be asked about again (security review 2026-11,
    // wave 2).
    binding: sha256Hex(canonicalJson({ body, record: stored.record, positions: stored.positions })),
    state: {
      body,
      voucherId: id,
      expectStatus: VOUCHER_OPEN_STATUS,
      recheckDraft: true,
      keepsDocument: stored.hasDocument === true,
    },
  };
}

/**
 * The body that finalizes a stored draft (see the module doc): every stored field carried over,
 * `status: 100`, positions untouched (`voucherPosSave`/`voucherPosDelete` null), no file.
 */
function finalizeBody(stored: StoredVoucher, rule: TaxRule): SaveVoucherBody {
  const record = stored.record;
  return strictBody(
    saveVoucherBodySchema,
    {
      voucher: carriedVoucher(stored, {
        status: VOUCHER_OPEN_STATUS,
        voucherDate: stored.dates.voucherDate ?? todayInBerlin(),
        supplierId: record.supplier?.id,
        supplierName: nonBlank(record.supplierName),
        description: nonBlank(record.description),
        paymentDeadline: stored.dates.paymentDeadline,
        deliveryDate: stored.dates.deliveryDate ?? stored.dates.voucherDate ?? todayInBerlin(),
        deliveryDateUntil: stored.dates.deliveryDateUntil,
        taxRuleId: rule.id,
      }),
      voucherPosSave: null,
      voucherPosDelete: null,
    },
    "voucher",
  );
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export interface VoucherDeletePlan {
  readonly preview: DraftPreview;
  /** The German preview, for the approval page (see `preview-text.ts`). */
  readonly previewDe: DraftPreview;
  readonly state: { readonly voucher: VoucherDetailDto };
}

/** Prepares deleting a draft voucher that is not enshrined (`DELETE /Voucher/{id}`). */
export async function prepareVoucherDelete(
  client: SevdeskClient,
  voucherId: number,
  signal: AbortSignal | undefined,
): Promise<VoucherDeletePlan> {
  let doc: LifecycleDocument<"voucher">;
  try {
    doc = await readLifecycleDocument(client, "voucher", voucherId, signal);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      refuse(`Voucher ${String(voucherId)} does not exist in sevDesk (or was deleted already).`);
    }
    throw error;
  }
  if (doc.enshrined) {
    refuse(
      `Voucher ${String(doc.id)} is enshrined (festgeschrieben) and can never be deleted (GoBD).`,
    );
  }
  if (doc.status !== statusOf(doc).draft) {
    refuse(
      `Voucher ${String(doc.id)} is not a draft (status ${String(doc.status)}, ` +
        `${doc.statusLabel}); only drafts are deleted here. A booked voucher stays in the ` +
        'books: reset it to draft first with sevdesk_voucher_reset (to "draft"), if that is ' +
        "really intended.",
    );
  }
  const warnings = [
    phrase(
      "The draft and all its positions are deleted from sevDesk; this cannot be undone.",
      "Der Entwurf und alle seine Positionen werden aus sevDesk gelöscht; das lässt sich nicht " +
        "rückgängig machen.",
    ),
  ];
  if (doc.dto.hasDocument === true) {
    warnings.push(
      phrase(
        "The voucher has an attached receipt file; whether sevDesk deletes it too or keeps it " +
          "among the documents is not documented.",
        "Am Beleg hängt eine Belegdatei; ob sevDesk sie mitlöscht oder unter den Dokumenten " +
          "behält, ist nicht dokumentiert.",
      ),
    );
  }
  return {
    ...bothPreviews((lang) => ({
      action:
        lang === "de"
          ? `${documentTitle(doc, lang)} (Entwurf) aus sevDesk löschen.`
          : `Delete ${documentTitle(doc)} (draft) from sevDesk.`,
      facts: documentFacts(doc, lang),
      warnings: inLanguage(warnings, lang),
      irreversible: true,
    })),
    state: { voucher: doc.dto },
  };
}

/** Result of a delete: whether a read afterwards confirmed it. */
export interface VoucherDeleteResult {
  readonly deleted: boolean;
  readonly notes: readonly string[];
}

/** Sends `DELETE /Voucher/{id}` (never retried), then checks with a GET that it is gone. */
export async function executeVoucherDelete(
  client: SevdeskClient,
  voucherId: number,
  signal: AbortSignal | undefined,
): Promise<VoucherDeleteResult> {
  const withSignal = signal === undefined ? {} : { signal };
  try {
    await client.request({
      method: "DELETE",
      path: sevdeskPath("Voucher", voucherId),
      ...withSignal,
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.status === 409) {
      throw new SevdeskError({
        kind: error.kind,
        status: 409,
        message:
          `sevDesk refused to delete voucher ${String(voucherId)}: only drafts (status 50) can ` +
          "be deleted, and it is no longer one (probably finalized in the meantime). Nothing was " +
          "deleted; check it with sevdesk_voucher_get.",
        ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
        cause: error,
      });
    }
    throw error;
  }
  try {
    await client.request({ method: "GET", path: sevdeskPath("Voucher", voucherId), ...withSignal });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      return { deleted: true, notes: [] };
    }
    if (error instanceof SevdeskError) {
      throw new SevdeskError({
        kind: error.kind,
        message:
          `sevDesk accepted the deletion of voucher ${String(voucherId)}, but the check ` +
          `afterwards failed: ${error.message} Do not delete again; check with ` +
          "sevdesk_voucher_get.",
        cause: error,
        completedWrites: [{ objectName: "Voucher", id: String(voucherId) }],
      });
    }
    throw error;
  }
  return {
    deleted: false,
    notes: [
      `sevDesk accepted the deletion, but still returns voucher ${String(voucherId)}. Check it ` +
        "with sevdesk_voucher_get.",
    ],
  };
}
