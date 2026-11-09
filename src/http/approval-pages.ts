/**
 * Responses of the approval inbox (`approval-routes.ts`): HTML pages under the strict page headers
 * of `htmlResponse` (CSP with a fresh style nonce, no framing, `no-store`, COOP), the trusted texts
 * they show, and the 303 redirect after a sign-in.
 *
 * Texts are trusted English; dynamic values reach the HTML only through the escaping renderers in
 * `src/safety/approval-page.ts`.
 */
import { renderMessagePage } from "../safety/approval-page.js";
import { htmlResponse, styleNonce } from "../safety/web.js";

export const INBOX_PATH = "/approvals";
export const LOGIN_PATH = "/approvals/login";
export const LOGOUT_PATH = "/approvals/logout";
/** Prefix of the approval detail pages, `/approvals/<id>`. */
export const DETAIL_PREFIX = "/approvals/";

/** Link back to the list, below result and error pages. */
const INBOX_LINK = { href: INBOX_PATH, label: "Back to the inbox" } as const;

/** A trusted page message: a title and one paragraph. */
export interface PageText {
  readonly title: string;
  readonly message: string;
}

export const TEXT = {
  approved: {
    title: "Approved",
    message:
      "You approved this action. Go back to your assistant: it runs the action when it calls " +
      "the tool again with the same arguments, before the request expires.",
  },
  rejected: {
    title: "Rejected",
    message: "You rejected this action. Nothing was changed in sevDesk.",
  },
  notFound: {
    title: "Approval not found",
    message:
      "This approval request is unknown, has expired or was already used. Ask your assistant " +
      "to try again if you still want the action.",
  },
  expired: {
    title: "Approval expired",
    message: "This approval request is no longer valid. Ask your assistant to try again.",
  },
  foreignPost: {
    title: "Request refused",
    message: "The request did not come from this server's own page.",
  },
  csrf: {
    title: "Request refused",
    message: "The request could not be verified. Reload the page and try again.",
  },
  signedOutPost: {
    title: "Sign in again",
    message: "Your sign-in has ended. Open the inbox, sign in again, and repeat your decision.",
  },
  noDecision: { title: "Bad request", message: "Choose Approve or Reject." },
  badForm: { title: "Bad request", message: "The form could not be read." },
  method: { title: "Method not allowed", message: "Use the buttons on the inbox pages." },
  tooLarge: { title: "Request too large", message: "The form is larger than this page sends." },
  signedOut: {
    title: "Signed out",
    message: "You are signed out of the approval inbox in this browser.",
  },
  notReady: {
    title: "Inbox not ready",
    message: "The approval inbox is starting. Try again in a moment.",
  },
} as const satisfies Readonly<Record<string, PageText>>;

/** Sign-in messages (shown above the form). */
export const LOGIN_TEXT = {
  empty: "Paste the API token of your sevDesk account exactly as sevDesk shows it.",
  refused: "The token was not accepted.",
  unavailable: "The token could not be checked right now. Try again in a moment.",
  limited: "Too many sign-in attempts from this network. Wait a minute, then try again.",
} as const;

/** An HTML page rendered with a fresh style nonce. */
export function pageResponse(
  status: number,
  render: (nonce: string) => string,
  headers?: Readonly<Record<string, string>>,
): Response {
  const nonce = styleNonce();
  return htmlResponse(render(nonce), {
    status,
    nonce,
    ...(headers === undefined ? {} : { headers }),
  });
}

/** A message page, with a link back to the inbox unless `link` is false. */
export function messageResponse(
  status: number,
  text: PageText,
  options: { readonly link?: boolean; readonly headers?: Readonly<Record<string, string>> } = {},
): Response {
  return pageResponse(
    status,
    (nonce) =>
      renderMessagePage(
        text.title,
        text.message,
        nonce,
        options.link === false ? undefined : INBOX_LINK,
      ),
    options.headers,
  );
}

/** `303 See Other` to `location` (an absolute URL on the public origin), setting `cookie`. */
export function redirectResponse(location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
