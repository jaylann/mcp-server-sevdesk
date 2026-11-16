/**
 * The VAT-ID check behind `sevdesk_vat_id_check`: the offline format check (`vat-id.ts`) and,
 * only when the operator switched it on (`SEVDESK_VIES_CHECK`), the live VIES check (`vies.ts`)
 * for a number whose format is valid. With the switch off nothing is sent anywhere; a number in
 * the wrong format is never sent either. Every message here is trusted text; VIES's name and
 * address are untrusted and only cleaned.
 */
import { z } from "zod";

import { checkVatIdFormat, vatIdFormatSchema } from "./vat-id.js";
import { checkVies, VIES_UNAVAILABLE_REASONS, type ViesUnavailableReason } from "./vies.js";

/** The check's result (also the tool's output). */
export const vatIdCheckSchema = z.object({
  format: vatIdFormatSchema,
  vies: z.object({
    status: z
      .enum(["off", "not_sent", "valid", "invalid", "unavailable"])
      .describe(
        "off: the live check is switched off on this server; not_sent: the format is not valid, " +
          "so nothing was asked; valid / invalid: what VIES answered; unavailable: VIES gave no " +
          "answer about the number.",
      ),
    checkedOn: z.string().optional().describe("The day VIES answered, YYYY-MM-DD."),
    name: z
      .string()
      .optional()
      .describe("The holder's name if the member state discloses it (text from VIES)."),
    address: z
      .string()
      .optional()
      .describe("The holder's address if the member state discloses it (text from VIES)."),
    reason: z.enum(VIES_UNAVAILABLE_REASONS).optional(),
    message: z.string().describe("What the status means."),
  }),
  notes: z.array(z.string()),
});
export type VatIdCheck = z.output<typeof vatIdCheckSchema>;

export interface VatIdCheckOptions {
  /** `Config.viesCheck`: whether the live VIES check may run. */
  readonly vies: boolean;
  readonly signal?: AbortSignal | undefined;
}

const UNAVAILABLE_MESSAGES: Readonly<Record<ViesUnavailableReason, string>> = {
  member_state_unavailable:
    "The member state's service behind VIES did not answer; try again later.",
  busy: "VIES is busy or unavailable; try again later.",
  rejected: "VIES refused the request.",
  timeout: "VIES did not answer in time; try again later.",
  network: "VIES could not be reached.",
  unexpected_response: "VIES answered in a form this server does not read.",
};

const FORMAT_IS_NOT_PROOF =
  "A valid format is not proof that the number was issued or is still valid. Before an " +
  "intra-Community supply, confirm it with VIES (https://ec.europa.eu/taxation_customs/vies/) " +
  "or the Bundeszentralamt für Steuern (§ 18e UStG) and keep the confirmation.";

/** Checks `value` (see the module doc). Throws only when the caller cancels. */
export async function checkVatId(value: string, options: VatIdCheckOptions): Promise<VatIdCheck> {
  const format = checkVatIdFormat(value);
  const vatId = format.vatId;
  if (format.status !== "valid_format" || vatId === undefined) {
    return {
      format,
      vies: {
        status: options.vies ? "not_sent" : "off",
        message: options.vies
          ? "Not sent to VIES: only a VAT ID in the valid format of an EU member state is checked " +
            "there."
          : "The live VIES check is off on this server; only the format was checked.",
      },
      notes: formatNotes(format.status),
    };
  }
  if (!options.vies) {
    return {
      format,
      vies: {
        status: "off",
        message:
          "The live VIES check is off on this server (setting SEVDESK_VIES_CHECK); only the " +
          "format was checked and nothing was sent anywhere.",
      },
      notes: [FORMAT_IS_NOT_PROOF],
    };
  }
  const result = await checkVies(vatId.slice(0, 2), vatId.slice(2), { signal: options.signal });
  switch (result.status) {
    case "valid":
      return {
        format,
        vies: {
          ...result,
          message:
            "VIES confirms the VAT ID as valid" +
            (result.checkedOn === undefined ? "" : ` on ${result.checkedOn}`) +
            ". Keep this result with the invoice.",
        },
        notes: [],
      };
    case "invalid":
      return {
        format,
        vies: {
          ...result,
          message:
            "VIES reports the VAT ID as not valid (not issued, or no longer valid). Clarify it " +
            "with the customer before treating the sale as one to a business with a valid VAT ID.",
        },
        notes: [],
      };
    case "unavailable":
      return {
        format,
        vies: { ...result, message: UNAVAILABLE_MESSAGES[result.reason] },
        notes: [FORMAT_IS_NOT_PROOF],
      };
  }
}

function formatNotes(status: VatIdCheck["format"]["status"]): string[] {
  switch (status) {
    case "invalid_format":
      return ["Check the number with the customer: it does not fit its member state's format."];
    case "not_eu":
      return [
        "Only VAT IDs of the 27 EU member states are checked (Greece: EL). Numbers of other " +
          "countries (e.g. CHE for Switzerland, GB, or XI for Northern Ireland) are not.",
      ];
    case "unreadable":
      return ["Pass the VAT ID with its two-letter prefix, e.g. ATU12345678."];
    case "valid_format":
      return [];
  }
}
