/**
 * Every probe of `pnpm probe`, and the checks that are deliberately not probed because they are
 * irreversible or reach third parties.
 */
import type { ProbeDefinition } from "./core.js";
import { READ_PROBES } from "./read-probes.js";
import { WRITE_PROBES } from "./write-probes.js";

export const ALL_PROBES: readonly ProbeDefinition[] = [...WRITE_PROBES, ...READ_PROBES];

/** A question the probe never asks sevDesk; it belongs to a human, by hand, if at all. */
export interface ManualCheck {
  readonly what: string;
  readonly why: string;
  readonly deviations: readonly string[];
}

export const NOT_PROBED: readonly ManualCheck[] = [
  {
    what: "POST /Export/createDatevXmlZipExportJob, and whether it marks documents as exported",
    why: "May mark or lock the exported documents; not reversible.",
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
    what:
      "POST /CreditNote|Order/{id}/sendViaEmail, GET /CreditNote/{id}/sendByWithRender, and " +
      "invoice e-mails to anyone but the --probe-email address",
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
];
