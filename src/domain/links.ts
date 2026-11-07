/**
 * Deep links into the sevDesk web app. The web app's routes are not documented, so a pattern is
 * only shipped when a public source shows it; tools add a `link` field only when one exists.
 *
 * Evidence (checked 2026-11-07):
 * - The web app's own router (public bundle `https://my.sevdesk.de/main.<hash>.bundle.js`) runs
 *   in HTML5 mode (`$locationProvider.html5Mode(!0)`), so routes are plain paths without `#/`,
 *   and declares, among others:
 *   `app.fiDetail` `/fi/detail/type/{type:RE|WKR|SR|TR|ER|AR|MA}/id/:id`,
 *   `app.fiEdit` `/fi/edit/type/{type:RE|WKR|SR|TR|ER|AR}/id/:id` (MA: `app.fiEditMa`, same shape),
 *   `app.cnDetail`/`app.cnEdit` `/cn/{detail|edit}/type/{type:CN}/id/:id`,
 *   `app.omDetail`/`app.omEdit` `/om/{detail|edit}/type/{type:AN|LI|AB}/id/:id`,
 *   `app.crmDetail` `/crm/detail/id/:id`, `app.exDetail` `/ex/detail/id/:id`.
 * - The app's own link builder opens drafts (status 100) in the editor and everything else in the
 *   detail view (`100===parseInt(model.status) ? "/fi/edit/type/…" : "/fi/detail/…"`, the same for
 *   credit notes and orders); the editor redirects non-drafts to the detail view anyway.
 * - Independent integrations use the same routes, e.g. the "Invoicing integration for sevDesk and
 *   WooCommerce" WordPress plugin (`https://my.sevdesk.de/fi/detail/type/RE/id/`), numtide's
 *   sevdesk-invoicer, phelmig/sevdesk-mcp and the tyme-app plugin (`/fi/edit/type/RE/id/…`, the
 *   legacy `#/` form, which the HTML5 router rewrites).
 *
 * Not shipped: single bank transactions (the app has no route for one).
 */
import { isSevdeskId } from "../sevdesk/paths.js";

/** The sevDesk web app. Independent of `SEVDESK_BASE_URL`, which points at the API. */
const WEB_APP = "https://my.sevdesk.de";

const DRAFT_STATUS = 100;
const INVOICE_TYPES: ReadonlySet<string> = new Set(["RE", "WKR", "SR", "TR", "ER", "AR", "MA"]);
const ORDER_TYPES: ReadonlySet<string> = new Set(["AN", "AB", "LI"]);

function documentLink(
  area: "fi" | "cn" | "om",
  type: string,
  id: number,
  status: number,
): string | undefined {
  if (!isSevdeskId(id)) return undefined;
  const view = status === DRAFT_STATUS ? "edit" : "detail";
  return `${WEB_APP}/${area}/${view}/type/${type}/id/${String(id)}`;
}

/** Invoice (Rechnung) of any type; `undefined` for a type the web app has no route for. */
export function invoiceLink(id: number, invoiceType: string, status: number): string | undefined {
  return INVOICE_TYPES.has(invoiceType) ? documentLink("fi", invoiceType, id, status) : undefined;
}

/** Credit note (Gutschrift). */
export function creditNoteLink(id: number, status: number): string | undefined {
  return documentLink("cn", "CN", id, status);
}

/** Offer, order confirmation or delivery note; `undefined` for an unknown order type. */
export function orderLink(id: number, orderType: string, status: number): string | undefined {
  return ORDER_TYPES.has(orderType) ? documentLink("om", orderType, id, status) : undefined;
}

/** Contact (Kontakt). */
export function contactLink(id: number): string | undefined {
  return isSevdeskId(id) ? `${WEB_APP}/crm/detail/id/${String(id)}` : undefined;
}

/** Voucher (Beleg). */
export function voucherLink(id: number): string | undefined {
  return isSevdeskId(id) ? `${WEB_APP}/ex/detail/id/${String(id)}` : undefined;
}
