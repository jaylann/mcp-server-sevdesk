/**
 * Every probe of `pnpm probe`, and the checks that are deliberately not probed because they are
 * irreversible or reach third parties.
 */
import type { ProbeDefinition } from "./core.js";
import { M4_BANKING_PROBES } from "./m4-banking-probes.js";
import { M4_EINVOICE_PROBES } from "./m4-einvoice-probes.js";
import { M4_REPORT_PROBES } from "./m4-reports-probes.js";
import { M4_VOUCHER_PROBES } from "./m4-voucher-probes.js";
import { READ_PROBES } from "./read-probes.js";
import { WRITE_PROBES } from "./write-probes.js";

/** M3 probes first, then the M4 ones (receipts, banking, reports, e-invoices). */
export const ALL_PROBES: readonly ProbeDefinition[] = [
  ...WRITE_PROBES,
  ...READ_PROBES,
  ...M4_VOUCHER_PROBES,
  ...M4_BANKING_PROBES,
  ...M4_REPORT_PROBES,
  ...M4_EINVOICE_PROBES,
];

/** A question the probe never asks sevDesk; it belongs to a human, by hand, if at all. */
export interface ManualCheck {
  readonly what: string;
  readonly why: string;
  readonly deviations: readonly string[];
}

export const NOT_PROBED: readonly ManualCheck[] = [
  {
    what: "POST /Export/createDatevXmlZipExportJob, and whether it marks documents as exported",
    why: "May mark or lock the exported documents; not reversible. (The CSV job is probed, without any enshrine flag.)",
    deviations: ["D-023"],
  },
  {
    what: "GET /Export/createDatevCsvZipExportJob with enshrineDocuments, GET /Export/datevCSV with enshrine",
    why: "Enshrines (festschreiben) every exported document: irreversible under GoBD.",
    deviations: ["D-023"],
  },
  {
    what: "PUT /Invoice|CreditNote|Voucher/{id}/enshrine and PUT /CheckAccountTransaction/{id}/enshrine",
    why: "Irreversible (festschreiben).",
    deviations: [],
  },
  {
    what: "resetToOpen on a document whose payment transaction is enshrined",
    why: "Needs an enshrined transaction first, which is irreversible (D-060 documents the 422 from sevdesk-rs).",
    deviations: ["D-060"],
  },
  {
    what:
      "POST /CreditNote|Order/{id}/sendViaEmail, GET /CreditNote/{id}/sendByWithRender, and " +
      "invoice e-mails to anyone but the --probe-email address (e-invoices included)",
    why:
      "Reach third parties (external tier). Only write-send-email-shape e-mails, only with " +
      "--probe-email, only to that address.",
    deviations: ["D-023", "D-025"],
  },
  {
    what: "GET /Order/Factory/getNextOrderNumber with useNextNumber=true",
    why: "Consumes a number of the offer sequence.",
    deviations: ["D-027"],
  },
  {
    what: "getPdf with preventSendBy=1 instead of the literal true",
    why: "The client always sends the verified literal true; a wrong guess would finalize a draft.",
    deviations: ["D-023"],
  },
  {
    what: "Bank reconciliation on an online bank account (imported transactions, status 350 auto-booked)",
    why:
      "A trial account has no online bank connection; the banking probes use hand-made " +
      "transactions on the offline account, which sevDesk's booking rules may treat differently.",
    deviations: ["D-031", "D-057"],
  },
  {
    what: "POST /Voucher/Factory/createVoucherFromFile",
    why: "Uncertain, undocumented endpoint that no tool uses (D-024); vouchers are saved with saveVoucher.",
    deviations: ["D-024"],
  },
];
