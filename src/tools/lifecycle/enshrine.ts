/**
 * `sevdesk_{invoice,credit_note,voucher}_enshrine`: enshrine (festschreiben, GoBD) a document with
 * `PUT /{Invoice|CreditNote|Voucher}/{id}/enshrine` (no body, answer `{objects: null}`). Spec
 * `invoiceEnshrine`: "only possible if the status is Open (200) or higher … cannot be undone";
 * `voucherEnshrine`: the same from voucher status open (100).
 * Measured by jernoxit/sevdesk-rs: 422 on drafts, idempotent on enshrined documents (refused here:
 * nothing to do), payments can still be booked afterwards.
 */
import { z } from "zod";

import {
  KINDS,
  type PaymentKind,
  readLifecycleDocument,
} from "../../domain/lifecycle/documents.js";
import { documentFacts, documentTitle, KIND_DE } from "../../domain/lifecycle/preview.js";
import { assertEnshrinable } from "../../domain/lifecycle/transitions.js";
import { bothPreviews, type Phrase, phrase } from "../../domain/preview-text.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import {
  capitalize,
  COMMIT_ANNOTATIONS,
  documentObject,
  documentOutput,
  documentOutputSchema,
  idInput,
  KIND_TOOLS,
  readBack,
} from "./shared.js";

const DESCRIPTIONS: Readonly<Record<PaymentKind, string>> = {
  invoice:
    "Enshrine an invoice (Rechnung festschreiben, GoBD): lock it permanently so it can never be " +
    "changed, deleted or reset to draft again; corrections then need a cancellation " +
    "(sevdesk_invoice_cancel) or a credit note. Irreversible. Payments can still be booked. " +
    "Only finalized invoices (status open 200 or later) that are not enshrined yet. Commit " +
    "tier: asks a human to confirm the preview, with an irreversibility warning; dryRun only " +
    "previews. Before: sevdesk_invoice_get (check it is final).",
  creditNote:
    "Enshrine a credit note (Gutschrift festschreiben, GoBD): lock it permanently so it can " +
    "never be reset to draft or deleted again. Irreversible. Payments can still be booked. Only " +
    "finalized credit notes (status open 200 or later) that are not enshrined yet. Commit tier: " +
    "asks a human to confirm the preview, with an irreversibility warning; dryRun only " +
    "previews. Before: sevdesk_credit_note_get (check it is final).",
  voucher:
    "Enshrine a voucher (Beleg festschreiben, GoBD): lock it permanently so it can never be " +
    "changed, reset to draft or deleted again; corrections then need a new voucher. " +
    "Irreversible. Only finalized vouchers (status open 100 or later, see " +
    "sevdesk_voucher_finalize) that are not enshrined yet. Commit tier: asks a human to confirm " +
    "the preview, with an irreversibility warning; dryRun only previews. Before: " +
    "sevdesk_voucher_get (check positions, accounts and the attached receipt).",
};

/** What enshrining means for the document, and that payments stay possible. */
function enshrineWarnings(kind: PaymentKind): Phrase[] {
  const correction =
    kind === "invoice"
      ? phrase(
          "corrections are then only possible with a cancellation (Storno) or a credit note",
          "Korrekturen sind dann nur noch mit einem Storno oder einer Gutschrift möglich",
        )
      : phrase(
          "corrections are then only possible with a new document",
          "Korrekturen sind dann nur noch mit einem neuen Dokument möglich",
        );
  return [
    phrase(
      `Irreversible (GoBD): the ${KINDS[kind].noun} can never be changed, deleted or reset to ` +
        `draft again; ${correction.en}.`,
      `Nicht umkehrbar (GoBD): ${capitalize(KIND_DE[kind].nominative)} kann nie wieder ` +
        `geändert, gelöscht oder auf Entwurf zurückgesetzt werden; ${correction.de}.`,
    ),
    phrase(
      "Payments can still be booked on it; unlinking them later stays possible only while " +
        "their bank transactions are not enshrined.",
      "Zahlungen können weiterhin darauf gebucht werden; sie später wieder zu lösen ist nur " +
        "möglich, solange ihre Kontoumsätze nicht festgeschrieben sind.",
    ),
  ];
}

/** Builds the enshrine tool of invoices, credit notes or vouchers. */
export function enshrineTool(kind: PaymentKind) {
  const info = KINDS[kind];
  const names = KIND_TOOLS[kind];
  return defineWriteTool({
    name: `${info.toolPrefix}_enshrine`,
    title: `Enshrine a sevDesk ${names.title}`,
    description: DESCRIPTIONS[kind],
    toolset: names.toolset,
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({ id: idInput(kind), ...dryRunInputShape }),
    output: documentOutputSchema(kind),
    prepare: async (args, ctx) => {
      const doc = await readLifecycleDocument(ctx.client, kind, args.id, ctx.signal);
      assertEnshrinable(doc);
      const warnings = enshrineWarnings(kind);
      return {
        ...bothPreviews((lang) => ({
          action:
            lang === "de"
              ? `${documentTitle(doc, lang)} festschreiben (GoBD): dauerhaft sperren.`
              : `Enshrine ${documentTitle(doc)} (festschreiben, GoBD): lock it permanently.`,
          facts: documentFacts(doc, lang),
          warnings: warnings.map((warning) => warning[lang]),
          irreversible: true,
        })),
        state: {},
      };
    },
    execute: async (args, _plan, ctx) => {
      await ctx.client.request({
        method: "PUT",
        path: sevdeskPath(info.objectName, args.id, "enshrine"),
        signal: ctx.signal,
      });
      const changed = documentObject(kind, args.id);
      const after = await readBack(ctx, kind, args.id, [changed]);
      return {
        data: documentOutput(kind, after.dto),
        summary: `${capitalize(info.noun)} ${String(args.id)} enshrined (festgeschrieben).`,
        affected: [changed],
      };
    },
  });
}
