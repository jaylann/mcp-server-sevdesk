/**
 * Responses of the approval inbox (`approval-routes.ts`) and the other pages of the HTTP server:
 * HTML pages under the strict page headers of `htmlResponse` (CSP with a fresh style nonce, no
 * framing, `no-store`, COOP), and the 303 redirect after a sign-in.
 *
 * Every response is built for one {@link PageContext} ({@link pageOf}): the language of the
 * request. The texts are the trusted ones of `src/pages/text`; dynamic values reach the HTML only
 * through the escaping renderers in `src/safety/approval-page.ts`.
 */
import { type PageContext, pageContext, type RenderContext } from "../pages/context.js";
import { type MessageTone, renderMessagePage, toneForStatus } from "../pages/message.js";
import type { PageMessage } from "../pages/text/index.js";
import { htmlResponse, styleNonce } from "../safety/web.js";

export const INBOX_PATH = "/approvals";
export const LOGIN_PATH = "/approvals/login";
export const LOGOUT_PATH = "/approvals/logout";
/** Prefix of the approval detail pages, `/approvals/<id>`. */
export const DETAIL_PREFIX = "/approvals/";

/** The page context of a request to the server at `origin` (its public origin). */
export function pageOf(request: Request, origin: string): PageContext {
  return pageContext(request.headers.get("accept-language"), origin);
}

/** An HTML page rendered with a fresh style nonce. */
export function pageResponse(
  page: PageContext,
  status: number,
  render: (ctx: RenderContext) => string,
  headers?: Readonly<Record<string, string>>,
): Response {
  const nonce = styleNonce();
  return htmlResponse(render({ ...page, nonce }), {
    status,
    nonce,
    page,
    ...(headers === undefined ? {} : { headers }),
  });
}

/**
 * A message page, with a link back to the inbox unless `link` is false. Its tone follows the
 * status (`toneForStatus`) unless `tone` says otherwise.
 */
export function messageResponse(
  page: PageContext,
  status: number,
  text: PageMessage,
  options: {
    readonly link?: boolean;
    readonly tone?: MessageTone;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Response {
  return pageResponse(
    page,
    status,
    (ctx) =>
      renderMessagePage(text, ctx, {
        tone: options.tone ?? toneForStatus(status),
        ...(options.link === false ? {} : { link: { href: INBOX_PATH, label: page.t.inbox.back } }),
      }),
    options.headers,
  );
}

/** `303 See Other` to `location` (an absolute URL on the public origin), setting `cookie`. */
export function redirectResponse(location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Set-Cookie": cookie,
      "Cache-Control": "no-store, no-transform",
    },
  });
}
