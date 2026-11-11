/**
 * Every page of the server in every state worth looking at, with made-up but realistic content.
 * Two readers: the page preview (`scripts/preview-pages.ts`), where a human looks at them, and
 * the tests that hold for all pages at once (no script, no inline styles, nothing loaded from
 * outside `/assets/`).
 *
 * Add a state here when a page gains one.
 */
import { bothPreviews, phrase } from "../../src/domain/preview-text.js";
import { renderConfirmStep, renderTokenStep } from "../../src/http/oauth/consent-page.js";
import { renderUploadPage, renderUploadReceipt } from "../../src/http/transfer-pages.js";
import type { RenderContext } from "../../src/pages/context.js";
import { renderMessagePage } from "../../src/pages/message.js";
import {
  type ApprovalPageModel,
  previewFor,
  renderApprovalPage,
  renderDecisionPage,
  renderInboxPage,
  renderLoginPage,
} from "../../src/safety/approval-page.js";
import type { ConfirmationPreview } from "../../src/tools/types.js";

export interface GalleryPage {
  /** URL-safe name. */
  readonly name: string;
  /** What the state is, for the index of the preview. */
  readonly title: string;
  readonly render: (ctx: RenderContext) => string;
}

const CREATED = "2026-11-09T12:05:00.000Z";
const EXPIRES = "2026-11-09T12:15:00.000Z";
const ID = "x".repeat(43);

/** The fixed parts of an approval page; the preview depends on the reader's language. */
type ApprovalFixture = Omit<ApprovalPageModel, "preview">;

/** Both previews of a made-up request, worded like the real tools word theirs. */
interface Previews {
  readonly preview: ConfirmationPreview;
  readonly previewDe: ConfirmationPreview;
}

const FINALIZE: ApprovalFixture = {
  toolName: "sevdesk_invoice_finalize",
  toolTitle: "Finalize a sevDesk invoice",
  tier: "commit",
  recordChanged: false,
  reference: "K7Q2M4",
  createdAt: CREATED,
  expiresAt: EXPIRES,
  now: Date.parse(EXPIRES) - 8 * 60_000 - 57_000,
  formAction: `/approve/${ID}`,
  csrf: "csrf-tag",
};

const FINALIZE_PREVIEWS: Previews = bothPreviews((lang) =>
  lang === "de"
    ? {
        action:
          "Rechnung 1042 (noch ohne Nummer) fertigstellen: Entwurf → offen, als Versandart " +
          "wird „Post (VP)“ vermerkt.",
        facts: [
          { label: "Rechnung", value: "ID 1042, noch ohne Nummer" },
          { label: "Typ", value: "Rechnung (RE)" },
          { label: "Status", value: "Entwurf (100)" },
          { label: "Kunde", value: "Müller GmbH (Kontakt 1001)" },
          { label: "Datum", value: "03.11.2026" },
          { label: "Fällig am", value: "17.11.2026" },
          { label: "Netto", value: "1.000,00 EUR" },
          { label: "Umsatzsteuer", value: "190,00 EUR" },
          { label: "Brutto", value: "1.190,00 EUR" },
          { label: "Vermerkte Versandart", value: "Post (VP)" },
        ],
        warnings: [
          "Die Rechnung wird rechtlich bindend: sevDesk vergibt ihre endgültige Nummer und " +
            "bucht sie. Danach lässt sie sich nur noch durch Zurücksetzen auf Entwurf (solange " +
            "sie nicht festgeschrieben ist), ein Storno oder eine Gutschrift korrigieren.",
          "sevDesk sendet nichts an den Kunden: Es wird nur vermerkt, wie das Dokument " +
            "versendet wurde. Für den Versand per E-Mail über sevDesk gibt es stattdessen " +
            "sevdesk_invoice_send_email.",
        ],
        irreversible: false,
      }
    : {
        action: "Finalize invoice 1042 (no number yet): draft → open, marked as sent by post (VP).",
        facts: [
          { label: "Invoice (Rechnung)", value: "id 1042, no number yet" },
          { label: "Type", value: "Rechnung (RE)" },
          { label: "Status", value: "Draft (100)" },
          { label: "Customer", value: "Müller GmbH (contact 1001)" },
          { label: "Date", value: "2026-11-03" },
          { label: "Due date", value: "2026-11-17" },
          { label: "Net", value: "1000.00 EUR" },
          { label: "Tax", value: "190.00 EUR" },
          { label: "Gross", value: "1190.00 EUR" },
          { label: "Marked as sent", value: "by post (VP)" },
        ],
        warnings: [
          "The invoice becomes legally binding: sevDesk assigns its final number and books it. " +
            "Afterwards it can only be corrected by a reset to draft (while not enshrined), a " +
            "cancellation (Storno) or a credit note.",
          "sevDesk sends nothing to the customer: this only records how the document was " +
            "sent. To email it through sevDesk, use sevdesk_invoice_send_email instead.",
        ],
        irreversible: false,
      },
);

const EMAIL_TEXT = [
  "Sehr geehrte Frau Müller,",
  "",
  "anbei erhalten Sie unsere Rechnung RE-1042 über 1.190,00 EUR für die Leistungen im Oktober.",
  "Bitte überweisen Sie den Betrag bis zum 17.11.2026 auf das unten genannte Konto.",
  "",
  "Bei Rückfragen erreichen Sie uns jederzeit unter buchhaltung@beispiel-software.example.",
  "",
  "Mit freundlichen Grüßen",
  "Erika Mustermann",
].join("\n");

const SEND_EMAIL: ApprovalFixture = {
  toolName: "sevdesk_invoice_send_email",
  toolTitle: "Email a sevDesk invoice",
  tier: "external",
  recordChanged: true,
  reference: "9FTW3C",
  createdAt: CREATED,
  expiresAt: EXPIRES,
  now: Date.parse(EXPIRES) - 20_000,
  formAction: `/approvals/${ID}`,
  csrf: "csrf-tag",
  inboxHref: "/approvals",
};

const SEND_EMAIL_PREVIEWS: Previews = bothPreviews((lang) =>
  lang === "de"
    ? {
        action:
          "Rechnung RE-1042 über sevDesk per E-Mail senden an buchhaltung@mueller-gmbh.example.",
        facts: [
          { label: "Rechnung", value: "RE-1042 (ID 1042)" },
          { label: "Status", value: "Offen / fällig (200)" },
          { label: "Kunde", value: "Müller GmbH (Kontakt 1001)" },
          { label: "Brutto", value: "1.190,00 EUR" },
          { label: "An", value: "buchhaltung@mueller-gmbh.example" },
          { label: "Anhang", value: "Rechnung als PDF" },
          { label: "Betreff", value: "Rechnung RE-1042" },
          { label: "Text", value: EMAIL_TEXT },
        ],
        warnings: [
          "Die E-Mail geht sofort aus sevDesk an alle aufgeführten Empfänger und lässt sich " +
            "nicht zurückholen.",
        ],
        irreversible: true,
      }
    : {
        action: "Email invoice RE-1042 through sevDesk to buchhaltung@mueller-gmbh.example.",
        facts: [
          { label: "Invoice (Rechnung)", value: "RE-1042 (id 1042)" },
          { label: "Status", value: "Open / due (200)" },
          { label: "Customer", value: "Müller GmbH (contact 1001)" },
          { label: "Gross", value: "1190.00 EUR" },
          { label: "To", value: "buchhaltung@mueller-gmbh.example" },
          { label: "Attachment", value: "the invoice PDF" },
          { label: "Subject", value: "Rechnung RE-1042" },
          { label: "Text", value: EMAIL_TEXT },
        ],
        warnings: [
          "The email goes out from sevDesk immediately to every recipient listed and cannot be " +
            "recalled.",
        ],
        irreversible: true,
      },
);

/** The action of a third, rejected request in the inbox. */
const PAYMENT_ACTION = phrase(
  "Book a payout of 238.00 EUR on voucher 2001 (full payment (FULL_PAYMENT)) via check " +
    "account Girokonto.",
  "Auszahlung von 238,00 EUR auf Beleg 2001 buchen (vollständige Zahlung (FULL_PAYMENT)), " +
    "über das Zahlungskonto Girokonto.",
);

/** The approval page of a fixture, with the preview of the reader's language. */
function approvalPage(model: ApprovalFixture, previews: Previews, ctx: RenderContext): string {
  return renderApprovalPage({ ...model, preview: previewFor(previews, ctx.locale) }, ctx);
}

const CLAUDE_AI = {
  host: "claude.ai",
  name: "Claude",
  redirectHost: "claude.ai",
  loopbackOnly: false,
};

/** The pages, in the order a person meets them. */
export const GALLERY: readonly GalleryPage[] = [
  {
    name: "approval",
    title: "Approval: finalize an invoice (commit)",
    render: (ctx) => approvalPage(FINALIZE, FINALIZE_PREVIEWS, ctx),
  },
  {
    name: "approval-email",
    title: "Approval: email with a long text, warnings, irreversible, changed record (external)",
    render: (ctx) => approvalPage(SEND_EMAIL, SEND_EMAIL_PREVIEWS, ctx),
  },
  {
    name: "approved",
    title: "Result: approved",
    render: (ctx) =>
      renderDecisionPage(
        {
          decision: "approved",
          reference: "K7Q2M4",
          action: previewFor(FINALIZE_PREVIEWS, ctx.locale).action,
        },
        ctx,
      ),
  },
  {
    name: "rejected",
    title: "Result: rejected",
    render: (ctx) =>
      renderDecisionPage(
        {
          decision: "rejected",
          reference: "9FTW3C",
          action: previewFor(SEND_EMAIL_PREVIEWS, ctx.locale).action,
          inboxHref: "/approvals",
        },
        ctx,
      ),
  },
  {
    name: "expired",
    title: "Message: approval expired (with the link back to the inbox)",
    render: (ctx) =>
      renderMessagePage(ctx.t.inbox.expired, ctx, {
        tone: "wait",
        link: { href: "/approvals", label: ctx.t.inbox.back },
      }),
  },
  {
    name: "refused",
    title: "Message: request refused",
    render: (ctx) => renderMessagePage(ctx.t.inbox.csrf, ctx, { tone: "danger" }),
  },
  {
    name: "inbox",
    title: "Inbox: one waiting, one approved, one rejected",
    render: (ctx) =>
      renderInboxPage(
        {
          accountId: "1001",
          items: [
            {
              href: `/approvals/${ID}`,
              reference: "9FTW3C",
              toolName: "sevdesk_invoice_send_email",
              toolTitle: "Email a sevDesk invoice",
              action: previewFor(SEND_EMAIL_PREVIEWS, ctx.locale).action,
              status: "pending",
              expiresAt: EXPIRES,
            },
            {
              href: `/approvals/${"y".repeat(43)}`,
              reference: "K7Q2M4",
              toolName: "sevdesk_invoice_finalize",
              toolTitle: "Finalize a sevDesk invoice",
              action: previewFor(FINALIZE_PREVIEWS, ctx.locale).action,
              status: "approved",
              expiresAt: EXPIRES,
            },
            {
              href: `/approvals/${"z".repeat(43)}`,
              reference: "B2HXN8",
              toolName: "sevdesk_voucher_book_payment",
              toolTitle: "Book a payment on a sevDesk voucher",
              action: PAYMENT_ACTION[ctx.locale],
              status: "rejected",
              expiresAt: EXPIRES,
            },
          ],
          inboxHref: "/approvals",
          logoutAction: "/approvals/logout",
          csrf: "csrf-tag",
        },
        ctx,
      ),
  },
  {
    name: "inbox-empty",
    title: "Inbox: nothing waiting",
    render: (ctx) =>
      renderInboxPage(
        {
          accountId: "1001",
          items: [],
          inboxHref: "/approvals",
          logoutAction: "/approvals/logout",
          csrf: "csrf-tag",
        },
        ctx,
      ),
  },
  {
    name: "login",
    title: "Sign-in: approvals",
    render: (ctx) =>
      renderLoginPage(
        {
          formAction: "/approvals/login",
          host: "mcp.example.com",
          sessionHours: 12,
          message: undefined,
        },
        ctx,
      ),
  },
  {
    name: "login-refused",
    title: "Sign-in: files, after a refused token",
    render: (ctx) =>
      renderLoginPage(
        {
          formAction: "/approvals/login",
          host: "mcp.example.com",
          sessionHours: 12,
          message: ctx.t.login.refused,
          next: `/uploads/${ID}`,
          purpose: "files",
        },
        ctx,
      ),
  },
  {
    name: "consent",
    title: "Consent 1: permissions and token",
    render: (ctx) =>
      renderTokenStep(
        {
          client: CLAUDE_AI,
          offered: ["read", "write", "commit", "external"],
          chosen: ["read", "write"],
          consent: "sealed-consent",
          csrf: "csrf-tag",
          error: undefined,
          unconfirmed: false,
        },
        ctx,
      ),
  },
  {
    name: "consent-error",
    title: "Consent 1: local app (loopback), after a refused token",
    render: (ctx) =>
      renderTokenStep(
        {
          client: {
            host: "claude.ai",
            name: "Claude Code",
            redirectHost: "127.0.0.1:53111",
            loopbackOnly: true,
          },
          offered: ["read", "write"],
          chosen: ["read"],
          consent: "sealed-consent",
          csrf: "csrf-tag",
          error: ctx.t.consent.check.unauthorized,
          unconfirmed: false,
        },
        ctx,
      ),
  },
  {
    name: "consent-confirm",
    title: "Consent 2: confirm the account",
    render: (ctx) =>
      renderConfirmStep(
        {
          client: CLAUDE_AI,
          tiers: ["read", "write", "commit"],
          accountId: "4711",
          accountName: "Beispiel Software UG (haftungsbeschränkt)",
          consent: "sealed-consent",
          csrf: "csrf-tag",
          unconfirmed: false,
        },
        ctx,
      ),
  },
  {
    name: "consent-refused",
    title: "Consent: an app that is not allowed",
    render: (ctx) =>
      renderMessagePage(ctx.t.consent.errors.appNotAllowed("evil.example"), ctx, {
        tone: "danger",
      }),
  },
  {
    name: "upload",
    title: "Upload: a receipt",
    render: (ctx) =>
      renderUploadPage(
        {
          accountId: "1001",
          purpose: "receipt",
          kinds: ["pdf", "png", "jpeg"],
          maxBytes: 20 * 1024 * 1024,
          reference: "U4MKP7",
          expiresAt: EXPIRES,
          formAction: `/uploads/${ID}`,
          csrf: "csrf-tag",
        },
        ctx,
      ),
  },
  {
    name: "upload-received",
    title: "Upload: file received",
    render: (ctx) =>
      renderUploadReceipt(
        {
          name: "Beleg_Maerz.pdf",
          kind: "pdf",
          size: 482_113,
          reference: "U4MKP7",
          expiresAt: EXPIRES,
        },
        ctx,
      ),
  },
  {
    name: "upload-too-large",
    title: "Message: file too large",
    render: (ctx) => renderMessagePage(ctx.t.transfer.tooLarge("20 MB"), ctx, { tone: "danger" }),
  },
];
