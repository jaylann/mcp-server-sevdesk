/**
 * Live check of an EU VAT ID with VIES, the European Commission's VAT Information Exchange
 * System: does the member state confirm that the number is valid today? Used only by
 * `sevdesk_vat_id_check`, and only when the operator switched it on (`SEVDESK_VIES_CHECK`, off by
 * default), because the request sends the VAT ID to the Commission.
 *
 * This module reads VIES's answer; the request itself (one fixed https URL, only the number, no
 * redirects, a timeout and a capped body) is sent by `src/sevdesk/vies-request.ts`. No result
 * carries the VAT ID, and VIES's own error text is never passed on, only a known error code
 * mapped to our reason.
 *
 * Answers: the Commission's Swagger file of the VIES REST API
 * (https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml, read 2026-11-16):
 * `CheckVatResponse {valid, requestDate, name, address, …}`; failures answer HTTP 400 or 500 with
 * `CommonResponse {actionSucceed, errorWrappers: [{error, message}]}`. VIES also reports a member
 * state it could not ask in a `userError` field next to `valid: false` (seen on its GET endpoint;
 * read here too, so an outage is never taken for an invalid number). The error codes are those
 * the web app explains (`exceptionError_lbl_*` in its `assets/i18n/en.json`). Not recorded against
 * the live service: parsing is lenient, and an answer that fits neither shape is reported as
 * unexpected rather than guessed.
 */
import { z } from "zod";

import { isIsoDate } from "../../sevdesk/dates.js";
import {
  postViesCheck,
  type ViesRequestFailure,
  type ViesRequestOptions,
} from "../../sevdesk/vies-request.js";
import { cleanText } from "../common.js";

/** Longest name and address kept from an answer. */
const NAME_MAX = 200;
const ADDRESS_MAX = 300;

/** Why VIES gave no answer about the number. */
export const VIES_UNAVAILABLE_REASONS = [
  "member_state_unavailable",
  "busy",
  "rejected",
  "timeout",
  "network",
  "unexpected_response",
] as const;
export type ViesUnavailableReason = (typeof VIES_UNAVAILABLE_REASONS)[number];

/** The outcome of one check. Name and address are untrusted text, cleaned. */
export type ViesResult =
  | {
      readonly status: "valid";
      readonly checkedOn?: string;
      readonly name?: string;
      readonly address?: string;
    }
  | { readonly status: "invalid"; readonly checkedOn?: string }
  | { readonly status: "unavailable"; readonly reason: ViesUnavailableReason };

/** VIES error codes (web app texts, see the module doc) and what they mean here. */
const ERROR_REASONS: Readonly<Record<string, ViesUnavailableReason>> = {
  MS_UNAVAILABLE: "member_state_unavailable",
  MS_MAX_CONCURRENT_REQ: "member_state_unavailable",
  GLOBAL_MAX_CONCURRENT_REQ: "busy",
  SERVICE_UNAVAILABLE: "busy",
  TIMEOUT: "timeout",
  INVALID_INPUT: "rejected",
  VAT_BLOCKED: "rejected",
  IP_BLOCKED: "rejected",
};

/** The `userError` values that are an answer about the number, not a failure. */
const ANSWER_CODES: ReadonlySet<string> = new Set(["VALID", "INVALID"]);

/** What a failed request means here. */
const FAILURE_REASONS: Readonly<Record<ViesRequestFailure, ViesUnavailableReason>> = {
  network: "network",
  timeout: "timeout",
  redirect: "unexpected_response",
  too_large: "unexpected_response",
};

/** `CheckVatResponse`: only the members read here. */
const answerSchema = z.object({
  valid: z.boolean(),
  requestDate: z.string().optional().catch(undefined),
  name: z.string().nullish().catch(undefined),
  address: z.string().nullish().catch(undefined),
  userError: z.string().nullish().catch(undefined),
});

/** `CommonResponse` of a failure. */
const failureSchema = z.object({
  errorWrappers: z.array(z.object({ error: z.string() }).loose()).min(1),
});

/**
 * Asks VIES about the VAT ID made of `prefix` (two letters, e.g. "EL") and `number` (the rest).
 * Callers pass only a number whose format `checkVatIdFormat` accepted. Resolves with the outcome,
 * also when VIES cannot answer; throws only a `SevdeskError` of kind `aborted` when the caller
 * cancels.
 */
export async function checkVies(
  prefix: string,
  number: string,
  options: ViesRequestOptions = {},
): Promise<ViesResult> {
  const result = await postViesCheck(prefix, number, options);
  switch (result.kind) {
    case "failed":
      return unavailable(FAILURE_REASONS[result.reason]);
    case "answer":
      return readAnswer(result.status, result.body);
  }
}

/** The outcome of an answer with HTTP `status` and its JSON body (undefined: not JSON). */
function readAnswer(status: number, body: unknown): ViesResult {
  const failure = failureSchema.safeParse(body);
  if (failure.success) {
    const code = failure.data.errorWrappers[0]?.error.trim().toUpperCase() ?? "";
    return unavailable(ERROR_REASONS[code] ?? (status >= 500 ? "busy" : "rejected"));
  }
  if (status < 200 || status >= 300) {
    return unavailable(status >= 500 ? "busy" : "unexpected_response");
  }
  const answer = answerSchema.safeParse(body);
  if (!answer.success) return unavailable("unexpected_response");
  const userError = answer.data.userError?.trim().toUpperCase() ?? "";
  if (userError !== "" && !ANSWER_CODES.has(userError)) {
    return unavailable(ERROR_REASONS[userError] ?? "unexpected_response");
  }
  const checkedOn = dayOf(answer.data.requestDate);
  const dated = checkedOn === undefined ? {} : { checkedOn };
  if (!answer.data.valid) return { status: "invalid", ...dated };
  const name = disclosed(answer.data.name, NAME_MAX);
  const address = disclosed(answer.data.address, ADDRESS_MAX);
  return {
    status: "valid",
    ...dated,
    ...(name === undefined ? {} : { name }),
    ...(address === undefined ? {} : { address }),
  };
}

/** The calendar day of VIES's `requestDate` (e.g. "2026-11-16+01:00"), if it is one. */
function dayOf(value: string | undefined): string | undefined {
  const day = value?.trim().slice(0, 10);
  return day !== undefined && isIsoDate(day) ? day : undefined;
}

/**
 * A name or address VIES disclosed, cleaned; undefined when the member state withholds it
 * (VIES then sends "---") or nothing visible is left. Line breaks become ", ".
 */
function disclosed(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = cleanText(value.replace(/\s*\n\s*/g, ", "), max);
  return text === undefined || /^-+$/.test(text) ? undefined : text;
}

function unavailable(reason: ViesUnavailableReason): ViesResult {
  return { status: "unavailable", reason };
}
