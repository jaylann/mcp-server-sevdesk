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
 * sent (a missing or true `forceReload`, extra keys), a query or a form keeps the request a write. A
 * reading POST is still never retried (only GETs are, see `client.ts`).
 */
import type { SevdeskRequest } from "./types.js";

/** `/{Invoice|Order|CreditNote}/{id}/render` with a canonical id. */
const DOCUMENT_RENDER = /^\/(?:Invoice|Order|CreditNote)\/[1-9]\d*\/render$/;

/** Whether `request` is a POST that only reads (see the module doc). */
export function isReadingPost(
  request: Pick<SevdeskRequest, "method" | "path" | "query" | "body" | "form">,
): boolean {
  if (request.method !== "POST" || !DOCUMENT_RENDER.test(request.path)) return false;
  if (request.form !== undefined) return false;
  if (request.query !== undefined && Object.keys(request.query).length > 0) return false;
  return isNoReloadBody(request.body);
}

/** The JSON text of {@link RENDER_WITHOUT_RELOAD}, the only body a reading render sends. */
const NO_RELOAD_TEXT = '{"forceReload":false}';

/**
 * Whether `body` goes out as exactly `{"forceReload":false}`. It reads the body as the client
 * sends it (`JSON.stringify`), not the object, so a `toJSON` or an inherited key cannot make the
 * sent text differ from what was checked. A body without a JSON text (none, a cycle, a `BigInt`)
 * is no reading body.
 */
function isNoReloadBody(body: unknown): boolean {
  try {
    return stringify(body) === NO_RELOAD_TEXT;
  } catch {
    return false;
  }
}

/** `JSON.stringify`, typed as it behaves: `undefined`, a function or a symbol has no JSON text. */
const stringify: (value: unknown) => string | undefined = JSON.stringify;

/** The body of the reading render request (see the module doc). */
export const RENDER_WITHOUT_RELOAD: { readonly forceReload: false } = Object.freeze({
  forceReload: false,
});
