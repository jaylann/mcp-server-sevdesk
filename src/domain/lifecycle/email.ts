/**
 * Sending a document by email through sevDesk (`POST /{Invoice|CreditNote|Order}/{id}/sendViaEmail`):
 * local validation of every address and of the text, and the strict request body.
 *
 * Body (spec `sendInvoiceViaEMail`, `sendCreditNoteViaEMail`, `sendorderViaEMail`): `toEmail`,
 * `subject`, `text` (may contain HTML) required; `copy` (a copy to the sevDesk user), `ccEmail` and
 * `bccEmail` (addresses "separated by ','"), `sendXml` (invoices only: the e-invoice XML instead of
 * the PDF). `toEmail` is "the recipient", one address; nothing shows that it takes several.
 * `additionalAttachments` (ids of other sevDesk documents) is deliberately not offered: attaching
 * arbitrary account documents to an email to a third party is an exfiltration path a prompt
 * injection could use, and the use case is rare. No request or response of these endpoints has
 * been recorded publicly (jernoxit/sevdesk-rs: "per spec, unmeasured").
 */
import { z } from "zod";

import { codePointLabel, findHiddenCharacters } from "../../safety/fence.js";
import type { LifecycleKind } from "./documents.js";
import { refuse } from "./transitions.js";

/** At most this many cc and this many bcc recipients. */
export const MAX_COPY_RECIPIENTS = 10;
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_TEXT_LENGTH = 10_000;

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
/** Unquoted local part (RFC 5322 atext and dots); no commas, which separate cc/bcc lists. */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** A top-level domain: letters, or an internationalized one in punycode (`xn--…`). */
const TOP_LEVEL_DOMAIN = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;

/**
 * Whether `value` is a plain email address: ASCII `local@domain.tld`, unquoted local part, a
 * domain of at least two labels and a real top-level domain (no IP literals). Deliberately
 * stricter than RFC 5322: an address sevDesk would mangle is refused here, before anything leaves.
 */
export function isEmailAddress(value: string): boolean {
  if (value.length > MAX_ADDRESS_LENGTH) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split(".");
  const tld = labels.at(-1) ?? "";
  return (
    local.length <= MAX_LOCAL_PART_LENGTH &&
    LOCAL_PART.test(local) &&
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL.test(label)) &&
    TOP_LEVEL_DOMAIN.test(tld)
  );
}

/** One email address argument, trimmed and checked locally. */
export const emailAddressInput = z.string().trim().refine(isEmailAddress, {
  message: "expected one email address such as buchhaltung@example.com (ASCII, no name part)",
});

/** The email arguments of the send tools. */
export interface EmailRequest {
  readonly to: string;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly subject: string;
  readonly text: string;
  readonly sendCopyToMe?: boolean | undefined;
  /** Invoices only. */
  readonly attachXml?: boolean | undefined;
}

/** Outgoing body (strict: sevDesk ignores unknown fields silently, D-003). */
const sendEmailPayloadSchema = z.strictObject({
  toEmail: z.string().min(1),
  subject: z.string().min(1),
  text: z.string().min(1),
  copy: z.literal(true).optional(),
  ccEmail: z.string().min(1).optional(),
  bccEmail: z.string().min(1).optional(),
  sendXml: z.literal(true).optional(),
});

export type SendEmailPayload = z.output<typeof sendEmailPayloadSchema>;

/** Every recipient of an email, as entered. */
export interface Recipients {
  readonly to: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

/** Code points named in a refusal; the rest is counted. */
const MAX_LISTED_CODE_POINTS = 10;

/**
 * Refuses `value` when it holds characters a human would not see as they are (the shared rule
 * `findHiddenCharacters`: control, format and other default-ignorable characters, CR, U+2028,
 * U+2029, tab; line feeds unless `allowNewlines`). The message names the field and the code
 * points, never the text itself.
 */
function refuseHidden(field: "subject" | "text", value: string, allowNewlines: boolean): void {
  const hidden = findHiddenCharacters(value, { allowNewlines });
  if (hidden.length === 0) return;
  const listed = hidden.slice(0, MAX_LISTED_CODE_POINTS).map(codePointLabel).join(", ");
  const more =
    hidden.length > MAX_LISTED_CODE_POINTS
      ? ` and ${String(hidden.length - MAX_LISTED_CODE_POINTS)} more`
      : "";
  const rule = allowNewlines
    ? "only plain line breaks (U+000A) are allowed"
    : "the subject must be a single line";
  refuse(
    `The email ${field} contains characters a reader would not see as they are ` +
      `(${listed}${more}); ${rule}. Remove them so the approved text is exactly what the ` +
      `recipient reads.`,
  );
}

/**
 * Checks the email locally and builds the body. Refuses an address that appears twice (across
 * to, cc and bcc, ignoring case), a subject with line breaks, and hidden characters in the subject
 * or text (a human approves this text; nothing may hide in it). `copy` and `sendXml` are sent only
 * when true.
 */
export function buildEmail(
  kind: LifecycleKind,
  request: EmailRequest,
): { payload: SendEmailPayload; recipients: Recipients } {
  const cc = [...(request.cc ?? [])];
  const bcc = [...(request.bcc ?? [])];
  const seen = new Set<string>();
  for (const address of [request.to, ...cc, ...bcc]) {
    const key = address.toLowerCase();
    if (seen.has(key)) {
      refuse("The same email address is listed twice (to, cc, bcc); list each recipient once.");
    }
    seen.add(key);
  }
  refuseHidden("subject", request.subject, false);
  refuseHidden("text", request.text, true);
  if (request.attachXml === true && kind !== "invoice") {
    refuse("Only invoices can attach the e-invoice XML.");
  }
  const payload = sendEmailPayloadSchema.parse({
    toEmail: request.to,
    subject: request.subject,
    text: request.text,
    ...(request.sendCopyToMe === true ? { copy: true } : {}),
    ...(cc.length === 0 ? {} : { ccEmail: cc.join(",") }),
    ...(bcc.length === 0 ? {} : { bccEmail: bcc.join(",") }),
    ...(request.attachXml === true ? { sendXml: true } : {}),
  });
  return { payload, recipients: { to: request.to, cc, bcc } };
}
