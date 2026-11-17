/**
 * POST requests that only read. sevDesk answers some reads to a POST, and the client otherwise
 * counts every non-GET as a change (refused in read-only and dry-run mode and in `prepare`, tier
 * required). This list names the exceptions, each by its exact shape, so nothing else can pass as
 * a read:
 *
 * - `POST /{Invoice|Order|CreditNote}/{id}/render` with the body `{forceReload: false}`: the
 *   spec's "retrieval of the pdf location" (`invoiceRender`; `forceReload: true` is its "forceful
 *   re-render of an already sent invoice" and stays a write; the order and credit-note variants
 *   are not in the spec, D-024). It answers `{docId, pdf, parameters}` (the print options:
 *   language, template, letterpaper and others) and leaves status, `sendDate`, `sendType`,
 *   number and `update` unchanged (spec/deviations.md D-113): recorded on 2026-11-16 on an
 *   invoice draft, and on 2026-11-17 on an order draft and a credit-note draft (with and without
 *   a PDF preview before it) and on a finalized invoice. It is the only call that reads a
 *   document's layout without changing it; the finalize approval shows the layout of a draft
 *   with it.
 *
 * The path must match exactly, case included (the form this server builds); any other body as
 * sent (a missing or true `forceReload`, extra keys), a query or a form keeps the request a write.
 * The body is judged by its JSON text, never by the object: a `toJSON` or an inherited key cannot
 * make the sent text differ from what was checked. The HTTP client serializes a body once and
 * passes that very text to {@link isReadingPostText}, so even a getter that answers differently
 * on a second read cannot. A reading POST is still never retried (only GETs are, see
 * `client.ts`).
 */
import type { SevdeskRequest } from "./types.js";

/** `/{Invoice|Order|CreditNote}/{id}/render` with a canonical id. */
const DOCUMENT_RENDER = /^\/(?:Invoice|Order|CreditNote)\/[1-9]\d*\/render$/;

/** The JSON text of {@link RENDER_WITHOUT_RELOAD}, the only body a reading render sends. */
const NO_RELOAD_TEXT = '{"forceReload":false}';

/**
 * Whether `request` is a POST that only reads (see the module doc), its body judged by its JSON
 * text. For the wrappers that classify a request without sending it; the HTTP client, which
 * sends it, uses {@link isReadingPostText} with the text it sends.
 */
export function isReadingPost(
  request: Pick<SevdeskRequest, "method" | "path" | "query" | "body" | "form">,
): boolean {
  return isReadingPostText(request, jsonText(request.body));
}

/**
 * Whether `request` with the JSON body text `bodyText` (`undefined`: no body, or none with a JSON
 * text) is a POST that only reads: exactly `{"forceReload":false}`.
 */
export function isReadingPostText(
  request: Pick<SevdeskRequest, "method" | "path" | "query" | "form">,
  bodyText: string | undefined,
): boolean {
  if (request.method !== "POST" || !DOCUMENT_RENDER.test(request.path)) return false;
  if (request.form !== undefined) return false;
  if (request.query !== undefined && Object.keys(request.query).length > 0) return false;
  return bodyText === NO_RELOAD_TEXT;
}

/** The JSON text of `body`, or `undefined` when it has none (none given, a cycle, a `BigInt`). */
function jsonText(body: unknown): string | undefined {
  try {
    return stringify(body);
  } catch {
    return undefined;
  }
}

/** `JSON.stringify`, typed as it behaves: `undefined`, a function or a symbol has no JSON text. */
const stringify: (value: unknown) => string | undefined = JSON.stringify;

/** The body of the reading render request (see the module doc). */
export const RENDER_WITHOUT_RELOAD: { readonly forceReload: false } = Object.freeze({
  forceReload: false,
});
