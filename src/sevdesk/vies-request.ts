/**
 * The request to VIES, the European Commission's VAT Information Exchange System, behind
 * `sevdesk_vat_id_check`: the transport only. What an answer means is the domain layer's
 * (`src/domain/vat/vies.ts`), which is also the only caller, and only when the operator switched
 * the check on (`SEVDESK_VIES_CHECK`, off by default), because the request sends the VAT ID to the
 * Commission.
 *
 * Besides the DATEV download (`export-download.ts`) and the client metadata fetch of OAuth mode
 * (`src/http/oauth/cimd.ts`) this is the only request the server sends anywhere but the sevDesk
 * API, and it is built as narrowly:
 *
 * - **one fixed https URL** ({@link VIES_ENDPOINT}); nothing in it comes from the caller;
 * - **only the number is sent**: the JSON body holds the prefix (`countryCode`) and the rest of
 *   the VAT ID (`vatNumber`), nothing else: no requester VAT ID, no name, no sevDesk token, no
 *   cookies or credentials;
 * - **no redirects** (`redirect: "manual"`; a 3xx is reported, never followed);
 * - **a timeout** ({@link VIES_TIMEOUT_MS}) and a **capped body** ({@link MAX_VIES_BYTES},
 *   streamed through `readCappedBody`);
 * - **nothing is logged**, and no result or error carries the VAT ID or VIES's own text.
 *
 * Wire format: the Commission's Swagger file of the VIES REST API
 * (https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml, read 2026-11-16):
 * `POST /check-vat-number` with `CheckVatRequest {countryCode, vatNumber, …}`. The Swagger names
 * no host; the base `https://ec.europa.eu/taxation_customs/vies/rest-api` is the one the VIES web
 * app and public clients use. Not recorded against the live service.
 */
import { readCappedBody } from "./client.js";
import { SevdeskError } from "./errors.js";

/** The one URL this module sends to. */
export const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/** Time for the whole check; VIES waits for the member state's own service. */
const VIES_TIMEOUT_MS = 15_000;
/** Largest answer read: a VIES answer is well under 2 KiB. */
const MAX_VIES_BYTES = 64 * 1024;

/**
 * Test seam: the `fetch` {@link postViesCheck} uses, looked up on every call. Production code never
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

/** Why no answer could be read. */
export type ViesRequestFailure = "network" | "timeout" | "redirect" | "too_large";

/**
 * What came back: an answer with its HTTP status and its body as JSON (`undefined` when the body
 * is not JSON), or why there is none.
 */
export type ViesHttpResult =
  | { readonly kind: "answer"; readonly status: number; readonly body: unknown }
  | { readonly kind: "failed"; readonly reason: ViesRequestFailure };

export interface ViesRequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** Defaults to {@link VIES_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Defaults to {@link MAX_VIES_BYTES}. */
  readonly maxBytes?: number | undefined;
}

/**
 * Sends `{countryCode, vatNumber}` to {@link VIES_ENDPOINT} under the rules of the module doc.
 * Callers pass only a number whose format they checked. Resolves also when no answer could be
 * read; throws only a `SevdeskError` of kind `aborted` when the caller cancels.
 */
export async function postViesCheck(
  countryCode: string,
  vatNumber: string,
  options: ViesRequestOptions = {},
): Promise<ViesHttpResult> {
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
      body: JSON.stringify({ countryCode, vatNumber }),
      signal,
    });
  } catch {
    return failed(options.signal, timeout, "network");
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "failed", reason: "redirect" };
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
    if (error === TOO_LARGE) return { kind: "failed", reason: "too_large" };
    return failed(options.signal, timeout, "network");
  }
  return { kind: "answer", status: response.status, body: parseJson(text) };
}

/** The JSON value of `text`, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Thrown by the body cap; never leaves this module. */
const TOO_LARGE = new Error("VIES answer too large");

/** A failed request: the caller cancelled (thrown), the timeout fired, or `fallback`. */
function failed(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
  fallback: ViesRequestFailure,
): ViesHttpResult {
  if (caller?.aborted === true) {
    throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
  return { kind: "failed", reason: timeout.aborted ? "timeout" : fallback };
}
