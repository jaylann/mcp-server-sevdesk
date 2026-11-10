/**
 * The English texts of the server's own pages, and the shape every language has: {@link Texts} is
 * the type of this object, so a text missing from another language is a type error.
 *
 * Everything here is trusted text written by the project. Values that reach a text through a
 * parameter (a host, an account id, a size) are escaped where the page is rendered, like the text
 * itself.
 */

import { TIER_DESCRIPTIONS } from "../../safety/tiers.js";
import { type Html, markup } from "../html.js";

/** A page that says one thing: a title and one paragraph. */
export interface PageMessage {
  readonly title: string;
  readonly message: string;
}

export function message(title: string, text: string): PageMessage {
  return { title, message: text };
}

const APPROVED = message(
  "Approved",
  "You approved this action. Go back to your assistant: it runs the action when it calls " +
    "the tool again with the same arguments, before the request expires.",
);
const REJECTED = message("Rejected", "You rejected this action. Nothing was changed in sevDesk.");
const APPROVAL_NOT_FOUND = message(
  "Approval not found",
  "This approval request is unknown, has expired or was already used. Ask your assistant " +
    "to try again if you still want the action.",
);

export const en = {
  /** Around every page. */
  frame: {
    disclaimer:
      "Unofficial community project. Not affiliated with sevdesk GmbH, nor supported or endorsed " +
      "by it.",
  },

  /** The approval page: the preview of one action, with Approve and Reject. */
  approval: {
    title: "Approve sevDesk action",
    eyebrow: "sevDesk MCP asks for your approval",
    heading: "Approve this action?",
    lead: "Your AI assistant wants to make this change in sevDesk. Read it through, then decide.",
    /** What a tool of each tier does, in plain words. */
    tier: {
      write: "Changes reversible records",
      commit: "Legally binding bookkeeping",
      external: "Reaches people outside sevDesk",
    },
    irreversible: "This cannot be undone.",
    changed:
      "The record changed after you were asked, so this is a new request. Check the details again.",
    unless: "Nothing happens unless you approve.",
    approve: "Approve",
    reject: "Reject",
    reference: "Reference",
    /**
     * Which tool asks: `name` is its marked-up name, `title` its (English) title. The German
     * page names the tool only, as tool titles exist in English alone.
     */
    tool: (name: Html, title: string) => markup`${title} ${name}`,
    sameCode: "Your assistant names the same reference code.",
    expiresIn: "Expires in",
    /** `time` is a UTC time such as "2026-11-09 12:15 UTC", marked up. */
    validUntil: (time: Html) => markup`Valid until ${time}.`,
    once: "It can be decided once.",
    next: "After approving, return to your assistant: it runs the action when it calls the tool again.",
    expired: "This request has expired. Ask your assistant to try again.",
    /** Labels on the page that follows a decision. */
    decided: { action: "Action" },
  },

  /** The inbox list (`/approvals`). */
  inboxPage: {
    title: "sevDesk approvals",
    heading: "sevDesk approvals",
    /** `account` is the account id, marked up. */
    lead: (account: Html) =>
      markup`Signed in for sevDesk account ${account}. Open a request to see exactly what it does, then approve or reject it.`,
    waiting: (count: number) => (count === 0 ? "Nothing waiting" : `${String(count)} waiting`),
    refresh: "Refresh",
    signOut: "Sign out",
    review: "Review",
    /** Which tool asks, on a row (see `approval.tool`). */
    tool: (name: Html, title: string) => markup`${title} (${name})`,
    status: {
      pending: "Waiting for your decision",
      approved: "Approved",
      rejected: "Rejected",
    },
    expires: (time: Html) => markup`expires ${time}`,
    runnableUntil: (time: Html) => markup`your assistant can run it until ${time}`,
    emptyTitle: "Nothing is waiting",
    empty: "No approval requests right now. When your assistant asks for one, reload this page.",
    fine:
      "Requests expire after a few minutes and can be decided once. After approving, return to " +
      "your assistant: it runs the action when it calls the tool again.",
  },

  /** The sign-in page: the sevDesk API token proves the account. */
  signIn: {
    approvals: {
      title: "Sign in: sevDesk approvals",
      heading: "Sign in to approve sevDesk actions",
      lead:
        "To see and decide approval requests from your AI assistant, sign in with the API token " +
        "of the sevDesk account.",
    },
    files: {
      title: "Sign in: sevDesk files",
      heading: "Sign in to transfer files",
      lead:
        "To upload or download files for your AI assistant, sign in with the API token of the " +
        "sevDesk account.",
    },
    /** `host` is the server's host, marked up. */
    onlyOn: (host: Html) =>
      markup`Only enter your token on ${host}. Check the address bar first: anywhere else, a page asking for it is phishing.`,
    tokenLabel: "sevDesk API token",
    where: "In sevDesk: Settings → Users → API token.",
    submit: "Sign in",
    fine: (hours: number) =>
      `The token is checked once and not stored. The sign-in lasts ${String(hours)} hours in ` +
      "this browser, or until you sign out.",
  },

  /** The permission tiers, as the consent page offers them. */
  tiers: {
    read: { label: "Read", text: TIER_DESCRIPTIONS.read },
    write: { label: "Write", text: TIER_DESCRIPTIONS.write },
    commit: { label: "Commit", text: TIER_DESCRIPTIONS.commit },
    external: { label: "External", text: TIER_DESCRIPTIONS.external },
  },

  /** The two consent steps (`/authorize`). */
  connect: {
    title: "Connect to sevDesk",
    heading: "Connect an app to sevDesk",
    steps: { token: "Permissions and token", confirm: "Confirm account" },
    /** `host` is the app's host, marked up. */
    wants: (host: Html) =>
      markup`The app at ${host} wants to use your sevDesk account through this server.`,
    /** `name` is what the app calls itself: untrusted. */
    selfDeclared: (name: string) => `It calls itself “${name}” (self-declared, not verified).`,
    returns: (host: Html) => markup`After connecting, your browser returns to ${host}.`,
    loopback: (host: Html) =>
      markup`This app runs on your own computer: after connecting, your browser returns to ${host}. Continue only if you just started connecting from an app on this device.`,
    legend: "What may it do?",
    tiersHint: "Commit and external actions still ask you to approve each one.",
    tokenLabel: "Your sevDesk API token",
    tokenHint:
      "In sevDesk: Settings → Users → API token. It is encrypted into this connection and " +
      "not stored on the server in readable form. Anyone with access to the app can use sevDesk " +
      "within the tiers you choose here, until you disconnect.",
    check: "Check token",
    cancel: "Cancel",
    confirmHeading: (accountId: string) => `Connect to sevDesk account ${accountId}?`,
    account: "sevDesk account",
    /** Label of the company name sevDesk returned: untrusted. */
    accountName: "Named in sevDesk",
    /** A name in quotation marks. */
    quoted: (name: string) => `“${name}”`,
    mayLabel: "The app may",
    submit: "Connect",
    /** `command` is the CLI command, marked up. */
    fine: (command: Html) =>
      markup`You can disconnect at any time in the app; the server's operator can revoke the connection with ${command}.`,
  },

  /** The upload page and its receipt (`/uploads/<id>`). */
  upload: {
    receipt: { title: "Upload a receipt", noun: "a receipt" },
    einvoice: { title: "Upload an e-invoice", noun: "an e-invoice (XRechnung or ZUGFeRD)" },
    /** `noun` is one of the nouns above, `account` the account id, marked up. */
    lead: (noun: string, account: Html) =>
      markup`Your AI assistant asked for ${noun} for sevDesk account ${account}. Choose the file here: it goes to this server only, and only the assistant connection that asked for it can use it.`,
    accepted: "Accepted",
    /** `kinds` is a list such as "PDF, PNG or JPEG". */
    byContent: (kinds: string) => `${kinds} (checked by content)`,
    or: "or",
    largest: "Largest file",
    useBefore: "Use before",
    file: "File",
    dropHint: "Choose a file, or drop it onto the field.",
    submit: "Upload",
    fine:
      "This page takes one file. After uploading, go back to your assistant and tell it the " +
      "file is there.",
    received: "File received",
    /** `name` is the cleaned file name and `time` a UTC time, both marked up. */
    receivedLead: (name: Html, kind: string, size: string, time: Html) =>
      markup`The server received ${name} (${kind}, ${size}). Go back to your assistant and tell it the upload is done. It can use the file until ${time}.`,
  },

  /** Result and error pages of the approval inbox (`/approvals`). */
  inbox: {
    approved: APPROVED,
    rejected: REJECTED,
    notFound: APPROVAL_NOT_FOUND,
    expired: message(
      "Approval expired",
      "This approval request is no longer valid. Ask your assistant to try again.",
    ),
    foreignPost: message(
      "Request refused",
      "The request did not come from this server's own page.",
    ),
    csrf: message(
      "Request refused",
      "The request could not be verified. Reload the page and try again.",
    ),
    signedOutPost: message(
      "Sign in again",
      "Your sign-in has ended. Open the inbox, sign in again, and repeat your decision.",
    ),
    noDecision: message("Bad request", "Choose Approve or Reject."),
    badForm: message("Bad request", "The form could not be read."),
    method: message("Method not allowed", "Use the buttons on the inbox pages."),
    tooLarge: message("Request too large", "The form is larger than this page sends."),
    signedOut: message("Signed out", "You are signed out of the approval inbox in this browser."),
    notReady: message("Inbox not ready", "The approval inbox is starting. Try again in a moment."),
    back: "Back to the inbox",
  },

  /** The session pages when the approval inbox is off (file transfer only). */
  session: {
    signedIn: message(
      "Signed in",
      "You are signed in to this server in this browser. Open the link your assistant gave you " +
        "again.",
    ),
    signedOut: message("Signed out", "You are signed out of this server in this browser."),
  },

  /** Notes above the sign-in form. */
  login: {
    empty: "Paste the API token of your sevDesk account exactly as sevDesk shows it.",
    refused: "The token was not accepted.",
    notAllowed: "This server is not set up for the sevDesk account of this token.",
    wrongToken: "This is not the sevDesk API token this server is configured with.",
    rejected: "sevDesk did not accept this API token.",
    unavailable: "The token could not be checked right now. Try again in a moment.",
    limited: "Too many sign-in attempts from this network. Wait a minute, then try again.",
  },

  /** The approval page on 127.0.0.1 (stdio). */
  local: {
    approved: APPROVED,
    rejected: REJECTED,
    notFound: APPROVAL_NOT_FOUND,
    expired: message("Approval expired", "This approval request is no longer valid."),
    wrongAddress: message("Wrong address", "Open the approval link exactly as it was given."),
    noPage: message("Not found", "There is no page at this address."),
    method: message("Method not allowed", "Use the buttons on the approval page."),
    foreignPost: message("Request refused", "The decision did not come from the approval page."),
    csrf: message(
      "Request refused",
      "The decision could not be verified. Reload the approval page and try again.",
    ),
    noDecision: message("Bad request", "Choose Approve or Reject."),
    badForm: message("Bad request", "The form could not be read."),
  },

  /** Upload pages and download links (`/uploads/<id>`, `/files/<id>`). */
  transfer: {
    uploadNotFound: message(
      "Upload page not found",
      "This upload page is unknown, has expired, or belongs to another sevDesk account. Ask " +
        "your assistant for a new upload link.",
    ),
    uploadExpired: message(
      "Upload page expired",
      "This upload page is no longer valid. Ask your assistant for a new upload link.",
    ),
    alreadyUploaded: message(
      "Already uploaded",
      "A file was already uploaded on this page. To send another file, ask your assistant for a " +
        "new upload link.",
    ),
    receiving: message(
      "Upload in progress",
      "A file is being received for this page. Reload the page in a moment.",
    ),
    wrongKind: message(
      "File type not accepted",
      "This page does not accept this type of file. The type is checked by the file's content, " +
        "not by its name. Go back and choose another file.",
    ),
    empty: message("Empty file", "The chosen file is empty. Go back and choose another."),
    badForm: message(
      "Bad request",
      "The upload could not be read. Use the form on the upload page to send one file.",
    ),
    lengthRequired: message(
      "Size missing",
      "The upload did not state its size. Use the form on the upload page in a current browser.",
    ),
    /** `limit` is the page's size limit, e.g. "20 MB". */
    tooLarge: (limit: string) =>
      message(
        "File too large",
        `The file is larger than this page accepts (${limit}). Go back and choose a smaller file.`,
      ),
    foreignPost: message(
      "Request refused",
      "The upload did not come from this server's own page. Open the upload link again.",
    ),
    csrf: message(
      "Request refused",
      "The upload could not be verified. Reload the upload page and try again.",
    ),
    signedOut: message(
      "Sign in again",
      "Your sign-in has ended. Open the upload link again, sign in, and choose the file again.",
    ),
    limited: message(
      "Too many uploads",
      "Too many uploads from this network. Wait a minute, then try again.",
    ),
    busy: message(
      "Server busy",
      "Other uploads are being received right now. Try again in a moment.",
    ),
    busyAccount: message(
      "Upload in progress",
      "Another upload of this sevDesk account is being received right now. Wait until it has " +
        "finished, then try again.",
    ),
    storageFull: message(
      "No space for the file",
      "The server has no room for this file right now: this sevDesk account, or all accounts " +
        "together, hold too many files. Try again once older uploads and download links have " +
        "expired.",
    ),
    failed: message("Upload failed", "The file could not be stored. Try again in a moment."),
    fileNotFound: message(
      "File not found",
      "This download link is unknown, has expired, or belongs to another sevDesk account. Ask " +
        "your assistant to create the file again.",
    ),
    fileExpired: message(
      "Download link expired",
      "This download link is no longer valid. Ask your assistant to create the file again.",
    ),
    fileExhausted: message(
      "Download link used up",
      "This download link was already used as often as it allows. Ask your assistant to create " +
        "the file again.",
    ),
  },

  /** The consent pages (`/authorize`). */
  consent: {
    /** Pages that end the flow. */
    errors: {
      incompleteLink: message(
        "This sign-in link is incomplete",
        "The request names no single client (client_id). Start connecting again from your app.",
      ),
      appNotAllowed: (host: string) =>
        message(
          "This app is not allowed",
          `This server does not accept the app at ${host}. Its operator can allow it in ` +
            "SEVDESK_OAUTH_CLIENTS.",
        ),
      unknownApp: message(
        "Unknown app",
        "The client_id is not the https address of a client metadata document.",
      ),
      /** `detail` is the server's own English finding about the app's metadata document. */
      unverified: (detail: string) => message("The app could not be verified", detail),
      unknownRedirect: (host: string) =>
        message(
          "Unknown redirect address",
          `The redirect address is missing or not registered by the app at ${host}, so ` +
            "this server does not send you there. Start connecting again from your app.",
        ),
      accountNotAllowed: (accountId: string) =>
        message(
          "This sevDesk account is not allowed",
          `This server does not accept sevDesk account ${accountId}. Its operator can ` +
            `allow it by adding ${accountId} to SEVDESK_OAUTH_ACCOUNTS.`,
        ),
      checkFirst: message("Check the token first", "Start connecting again from your app."),
      alreadyUsed: message(
        "This page was already used",
        "Each consent page connects once. Start connecting again from your app.",
      ),
      tooManyConnections: (limit: number) =>
        message(
          "Too many connections",
          `This server already holds ${String(limit)} connections. Its operator can revoke ` +
            "unused ones with `mcp-server-sevdesk grants revoke`; then try again.",
        ),
      foreignPost: message("Request refused", "This form can only be sent from its own page."),
      /** `reason` is a short code such as `too_large`. */
      formUnreadable: (reason: string) =>
        message("Request refused", `The form could not be read (${reason}).`),
      expired: message(
        "This page has expired",
        "Consent pages are valid for 10 minutes. Start connecting again from your app.",
      ),
      csrf: message(
        "Request refused",
        "This form was not sent from the page this browser opened. Start connecting again from " +
          "your app (cookies must be allowed for this site).",
      ),
      unknownStep: message("Request refused", "Unknown step."),
      unavailable: message(
        "Temporarily unavailable",
        "The server is restarting. Try again in a minute.",
      ),
    },
    /** Notes above the token field after a failed check. */
    check: {
      badToken:
        "That is not a sevDesk API token: copy the 32 characters (digits and the letters a to f) " +
        "from sevDesk, Settings → Users → API token.",
      limited: "Too many attempts. Wait a minute, then try again.",
      unauthorized:
        "sevDesk did not accept this token. Copy it again from sevDesk (Settings → Users → " +
        "API token); a regenerated token replaces the old one.",
      noAnswer:
        "The token could not be checked because sevDesk did not answer as expected. Try again " +
        "in a moment.",
      badAccount: "sevDesk returned an unexpected account id. Try again in a moment.",
    },
  },
};

/** The texts of the pages in one language. */
export type Texts = typeof en;
