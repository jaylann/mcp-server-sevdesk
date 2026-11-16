/**
 * Live check of an EU VAT ID with VIES, the European Commission's VAT Information Exchange
 * System: does the member state confirm that the number is valid today? Used only by
 * `sevdesk_vat_id_check`, and only when the operator switched it on (`SEVDESK_VIES_CHECK`, off by
 * default), because the request sends the VAT ID to the Commission.
 *
 * Besides the DATEV download (`src/sevdesk/export-download.ts`) and the client metadata fetch of
 * OAuth mode (`src/http/oauth/cimd.ts`) this is the only request the server sends anywhere but the
 * sevDesk API, and it is built as narrowly:
 *
 * - **one fixed https URL** ({@link VIES_ENDPOINT}); nothing in it comes from the caller;
 * - **only the number is sent**: the JSON body holds the prefix (`countryCode`) and the rest of
 *   the VAT ID (`vatNumber`), nothing else: no requester VAT ID, no name, no sevDesk token, no
 *   cookies or credentials;
 * - **no redirects** (`redirect: "manual"`; a 3xx counts as an unexpected answer);
 * - **a timeout** ({@link VIES_TIMEOUT_MS}) and a **capped body** ({@link MAX_VIES_BYTES},
 *   streamed through `readCappedBody`);
 * - **nothing is logged**, and no result or error carries the VAT ID; VIES's own error text is
 *   never passed on, only a known error code mapped to our reason.
 *
 * Wire format: the Commission's Swagger file of the VIES REST API
 * (https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml, read 2026-11-16):
 * `POST /check-vat-number` with `CheckVatRequest {countryCode, vatNumber, …}` answers
 * `CheckVatResponse {valid, requestDate, name, address, …}`; failures answer HTTP 400 or 500 with
 * `CommonResponse {actionSucceed, errorWrappers: [{error, message}]}`. The Swagger names no host;
 * the base `https://ec.europa.eu/taxation_customs/vies/rest-api` is the one the VIES web app and
 * public clients use. The error codes are those the web app explains (`exceptionError_lbl_*` in
 * its `assets/i18n/en.json`). Not recorded against the live service: parsing is lenient, and an
 * answer that fits neither shape is reported as unexpected rather than guessed.
 */
import { z } from "zod";

import { readCappedBody } from "../../sevdesk/client.js";
import { isIsoDate } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { cleanText } from "../common.js";

/** The one URL this module sends to. */
export const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/** Time for the whole check; VIES waits for the member state's own service. */
const VIES_TIMEOUT_MS = 15_000;
/** Largest answer read: a VIES answer is well under 2 KiB. */
const MAX_VIES_BYTES = 64 * 1024;
/** Longest name and address kept from an answer. */
const NAME_MAX = 200;
const ADDRESS_MAX = 300;

/**
 * Test seam: the `fetch` {@link checkVies} uses, looked up on every call. Production code never
 * changes it; tests swap it with {@link swapViesFetch} and restore it. It is never the global
 * `fetch` that is replaced, so nothing else is affected.
 */
export const viesTransport: { fetch: typeof fetch } = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

/** Replaces {@link viesTransport}'s fetch; returns the function that restores the previous one. */
export function swapViesFetch(replacement: typeof fetch): () => void {
  const previous = viesTransport.fetch;
  viesTransport.fetch = replacement;
  return () => {
    viesTransport.fetch = previous;
  };
}

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

/** `CheckVatResponse`: only the members read here. */
const answerSchema = z.object({
  valid: z.boolean(),
  requestDate: z.string().optional().catch(undefined),
  name: z.string().nullish().catch(undefined),
  address: z.string().nullish().catch(undefined),
});

/** `CommonResponse` of a failure. */
const failureSchema = z.object({
  errorWrappers: z.array(z.object({ error: z.string() }).loose()).min(1),
});

export interface ViesCheckOptions {
  readonly signal?: AbortSignal | undefined;
  /** Defaults to {@link VIES_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Defaults to {@link MAX_VIES_BYTES}. */
  readonly maxBytes?: number | undefined;
}

/**
 * Asks VIES about the VAT ID made of `prefix` (two letters, e.g. "EL") and `number` (the rest).
 * Callers pass only a number whose format `checkVatIdFormat` accepted. Resolves with the outcome,
 * also when VIES cannot answer; throws only a `SevdeskError` of kind `aborted` when the caller
 * cancels.
 */
export async function checkVies(
  prefix: string,
  number: string,
  options: ViesCheckOptions = {},
): Promise<ViesResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? VIES_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await viesTransport.fetch(VIES_ENDPOINT, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ countryCode: prefix, vatNumber: number }),
      signal,
    });
  } catch {
    return failed(options.signal, timeout, "network");
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    return unavailable("unexpected_response");
  }
  let text: string;
  try {
    const bytes = await readCappedBody(
      response,
      options.maxBytes ?? MAX_VIES_BYTES,
      () => TOO_LARGE,
    );
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error === TOO_LARGE) return unavailable("unexpected_response");
    return failed(options.signal, timeout, "network");
  }
  return readAnswer(response.status, parseJson(text));
}

/** The JSON value of `text`, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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

/** Thrown by the body cap; never leaves this module. */
const TOO_LARGE = new Error("VIES answer too large");

function unavailable(reason: ViesUnavailableReason): ViesResult {
  return { status: "unavailable", reason };
}

/** A failed request: the caller cancelled (thrown), the timeout fired, or `fallback`. */
function failed(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
  fallback: ViesUnavailableReason,
): ViesResult {
  if (caller?.aborted === true) {
    throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
  return unavailable(timeout.aborted ? "timeout" : fallback);
}
