/**
 * `sevdesk_{invoice,credit_note,order}_send_email`: sevDesk emails the document to a customer
 * (`POST /{Invoice|CreditNote|Order}/{id}/sendViaEmail`) and marks it as sent; a draft is
 * finalized by it (spec: "This will automatically mark the invoice as sent"). External tier: the
 * email reaches a third party and cannot be recalled, so the preview names every recipient and
 * shows the full subject and text. Body: see `src/domain/lifecycle/email.ts`.
 */
import { z } from "zod";

import {
  KINDS,
  readLifecycleDocument,
  type SalesKind,
  STATUS,
} from "../../domain/lifecycle/documents.js";
import {
  buildEmail,
  emailAddressInput,
  MAX_COPY_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  MAX_TEXT_LENGTH,
  type Recipients,
  type SendEmailPayload,
} from "../../domain/lifecycle/email.js";
import {
  documentFacts,
  documentTitle,
  type Fact,
  KIND_DE,
  kindNoun,
} from "../../domain/lifecycle/preview.js";
import { assertEmailable, refuse } from "../../domain/lifecycle/transitions.js";
import {
  bothPreviews,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import {
  capitalize,
  documentBinding,
  documentObject,
  documentOutput,
  documentOutputSchema,
  EXTERNAL_ANNOTATIONS,
  idInput,
  KIND_TOOLS,
  readBack,
} from "./shared.js";

const DESCRIPTIONS: Readonly<Record<SalesKind, string>> = {
  invoice:
    "Email an invoice (Rechnung per E-Mail versenden) through sevDesk: sevDesk sends the PDF " +
    "(or, with attachXml, the e-invoice XML) to the recipients and marks the invoice as sent. " +
    "A draft is finalized by this (only allowed when the commit tier is enabled too): it gets " +
    "its final number and becomes legally binding. " +
    "External tier: the email reaches the customer and cannot be recalled, so a human confirms " +
    "the preview with every recipient, the subject and the text first; dryRun only previews. " +
    "Addresses are checked locally; cc/bcc up to 10 each. To only record that you sent it " +
    "yourself, use sevdesk_invoice_finalize. Before: sevdesk_invoice_get, sevdesk_contact_get " +
    "(email addresses), sevdesk_invoice_pdf (check the PDF).",
  creditNote:
    "Email a credit note (Gutschrift per E-Mail versenden) through sevDesk: sevDesk sends the " +
    "PDF to the recipients and marks the credit note as sent; a draft is finalized by this and " +
    "gets its final number (only allowed when the commit tier is enabled too). External tier: " +
    "the email reaches the customer and cannot be " +
    "recalled, so a human confirms the preview with every recipient, the subject and the text " +
    "first; dryRun only previews. Addresses are checked locally; cc/bcc up to 10 each. To only " +
    "record that you sent it yourself, use sevdesk_credit_note_finalize. Before: " +
    "sevdesk_credit_note_get, sevdesk_contact_get, sevdesk_credit_note_pdf.",
  order:
    "Email an order (Angebot, Auftragsbestätigung or Lieferschein per E-Mail versenden) " +
    "through sevDesk: sevDesk sends the PDF to the recipients and marks the order as sent; a " +
    "draft is finalized by this and gets its final number (only allowed when the commit tier is " +
    "enabled too). External tier: the email reaches the " +
    "customer and cannot be recalled, so a human confirms the preview with every recipient, the " +
    "subject and the text first; dryRun only previews. Addresses are checked locally; cc/bcc up " +
    "to 10 each. To only record that you sent it yourself, use sevdesk_order_finalize. Before: " +
    "sevdesk_order_get, sevdesk_contact_get, sevdesk_order_pdf.",
};

const emailOutputSchema = z.object({
  to: z.string().describe("Recipient."),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  sendCopyToMe: z.boolean().describe("Whether sevDesk also sent a copy to the sevDesk user."),
  attachment: z
    .enum(["pdf", "xml"])
    .describe("pdf: the document PDF; xml: the e-invoice XML instead of the PDF."),
});

interface SendEmailState {
  readonly payload: SendEmailPayload;
  readonly recipients: Recipients;
}

/** The fact labels and fixed values of the email, per language. */
const EMAIL_TEXT = {
  en: {
    to: "To",
    copy: "Copy to you",
    copyYes: "yes, to the sevDesk user's own address",
    attachment: "Attachment",
    xml: "the e-invoice XML instead of the PDF",
    subject: "Subject",
    text: "Text",
  },
  de: {
    to: "An",
    copy: "Kopie an Sie",
    copyYes: "ja, an die eigene Adresse des sevDesk-Benutzers",
    attachment: "Anhang",
    xml: "die XML der E-Rechnung statt des PDF",
    subject: "Betreff",
    text: "Text",
  },
} as const;

/** Recipient and content facts, in the order a human checks them. */
function emailFacts(
  state: SendEmailState,
  attachment: "pdf" | "xml",
  kind: SalesKind,
  lang: PreviewLanguage,
): Fact[] {
  const { payload, recipients } = state;
  const t = EMAIL_TEXT[lang];
  const facts: Fact[] = [{ label: t.to, value: recipients.to }];
  if (recipients.cc.length > 0) facts.push({ label: "Cc", value: recipients.cc.join(", ") });
  if (recipients.bcc.length > 0) facts.push({ label: "Bcc", value: recipients.bcc.join(", ") });
  if (payload.copy === true) facts.push({ label: t.copy, value: t.copyYes });
  const pdf = lang === "de" ? `${kindNoun(kind, lang)} als PDF` : `the ${kindNoun(kind)} PDF`;
  facts.push(
    { label: t.attachment, value: attachment === "xml" ? t.xml : pdf },
    { label: t.subject, value: payload.subject },
    { label: t.text, value: payload.text },
  );
  return facts;
}

/** What sending does besides delivering the email: it finalizes a draft. */
function draftWarning(kind: SalesKind): Phrase {
  if (kind === "order") {
    return phrase(
      "The order is a draft: sending marks it as sent (status 200) and sevDesk assigns its " +
        "final number.",
      "Der Auftrag ist ein Entwurf: Mit dem Versand wird er als versendet markiert (Status " +
        "200), und sevDesk vergibt seine endgültige Nummer.",
    );
  }
  return phrase(
    `The ${KINDS[kind].noun} is a draft: sending finalizes it (draft → open), sevDesk ` +
      `assigns its final number and it becomes legally binding. If the account ` +
      `enshrines documents on completion, it is also enshrined (festgeschrieben).`,
    `${capitalize(KIND_DE[kind].nominative)} ist ein Entwurf: Der Versand stellt sie fertig ` +
      `(Entwurf → offen), sevDesk vergibt ihre endgültige Nummer, und sie wird rechtlich ` +
      `bindend. Schreibt das Konto Dokumente beim Abschließen automatisch fest, wird sie dabei ` +
      `auch festgeschrieben.`,
  );
}

/** Builds the send-by-email tool of one document kind. */
export function sendEmailTool(kind: SalesKind) {
  const info = KINDS[kind];
  const names = KIND_TOOLS[kind];
  const shape = {
    id: idInput(kind),
    to: emailAddressInput.describe("Recipient (Empfänger): one email address."),
    cc: z
      .array(emailAddressInput)
      .max(MAX_COPY_RECIPIENTS)
      .optional()
      .describe(`Cc recipients, up to ${String(MAX_COPY_RECIPIENTS)}.`),
    bcc: z
      .array(emailAddressInput)
      .max(MAX_COPY_RECIPIENTS)
      .optional()
      .describe(`Bcc recipients, up to ${String(MAX_COPY_RECIPIENTS)}.`),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SUBJECT_LENGTH)
      .describe("Subject (Betreff), one line."),
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TEXT_LENGTH)
      .describe("Email text; simple HTML allowed. sevDesk attaches the document itself."),
    sendCopyToMe: z
      .boolean()
      .optional()
      .describe("Also send a copy to the sevDesk user's own address. Defaults to false."),
    ...dryRunInputShape,
  };
  const input =
    kind === "invoice"
      ? z.strictObject({
          ...shape,
          attachXml: z
            .boolean()
            .optional()
            .describe(
              "E-invoices (XRechnung/ZUGFeRD) only: attach the XML instead of the PDF. " +
                "Defaults to false.",
            ),
        })
      : z.strictObject(shape);

  return defineWriteTool({
    name: `${info.toolPrefix}_send_email`,
    title: `Email a sevDesk ${names.title}`,
    description: DESCRIPTIONS[kind],
    toolset: names.toolset,
    tier: "external",
    annotations: EXTERNAL_ANNOTATIONS,
    input,
    output: documentOutputSchema(kind, { email: emailOutputSchema }),
    // Serialized with other calls on the same record (see WriteToolDefinition.locks).
    locks: (args) => [documentObject(kind, args.id)],
    prepare: async (args, ctx) => {
      // Only the invoice input has attachXml; the schema already checked it is a boolean.
      const attachXml = (args as { readonly attachXml?: boolean }).attachXml === true;
      const doc = await readLifecycleDocument(ctx.client, kind, args.id, ctx.signal);
      // Sending finalizes a draft (a commit-level step): only when commit is enabled too.
      assertEmailable(doc, ctx.config.allowedTiers.has("commit"));
      if (attachXml && doc.eInvoice === false) {
        refuse(
          `Invoice ${String(doc.id)} is not an e-invoice, so sevDesk has no XML to attach; send ` +
            `the PDF (leave attachXml out).`,
        );
      }
      const state: SendEmailState = buildEmail(kind, { ...args, attachXml });
      const attachment = attachXml ? "xml" : "pdf";
      const { recipients } = state;
      const copies = recipients.cc.length + recipients.bcc.length;
      const warnings = [
        phrase(
          "The email goes out from sevDesk immediately to every recipient listed and cannot be " +
            "recalled.",
          "Die E-Mail geht sofort aus sevDesk an alle aufgeführten Empfänger und lässt sich " +
            "nicht zurückholen.",
        ),
      ];
      if (doc.status === STATUS.draft) warnings.push(draftWarning(kind));
      if (attachment === "xml" && doc.eInvoice === undefined) {
        warnings.push(
          phrase(
            "sevDesk can only attach XML to e-invoices, and its reads do not say whether this " +
              "invoice is one; if it is not, sevDesk refuses or sends no XML.",
            "sevDesk kann XML nur an E-Rechnungen anhängen, und beim Lesen ist nicht erkennbar, " +
              "ob diese Rechnung eine ist; ist sie keine, lehnt sevDesk ab oder sendet keine XML.",
          ),
        );
      }
      const action = phrase(
        `Email ${documentTitle(doc)} through sevDesk to ${recipients.to}` +
          (copies === 0
            ? "."
            : ` and ${String(copies)} more recipient${copies === 1 ? "" : "s"} (cc/bcc).`),
        `${documentTitle(doc, "de")} über sevDesk per E-Mail senden an ${recipients.to}` +
          (copies === 0
            ? "."
            : ` und ${String(copies)} ${copies === 1 ? "weiteren" : "weitere"} Empfänger ` +
              "(Cc/Bcc)."),
      );
      return {
        ...bothPreviews((lang) => ({
          action: action[lang],
          facts: [...documentFacts(doc, lang), ...emailFacts(state, attachment, kind, lang)],
          warnings: warnings.map((warning) => warning[lang]),
          irreversible: true,
        })),
        binding: await documentBinding(ctx, doc),
        state,
      };
    },
    execute: async (args, plan, ctx) => {
      await ctx.client.request({
        method: "POST",
        path: sevdeskPath(info.objectName, args.id, "sendViaEmail"),
        body: plan.state.payload,
        signal: ctx.signal,
      });
      const changed = documentObject(kind, args.id);
      const after = await readBack(ctx, kind, args.id, [changed]);
      const { recipients, payload } = plan.state;
      const count = 1 + recipients.cc.length + recipients.bcc.length;
      return {
        data: documentOutput(kind, after.dto, {
          email: {
            to: recipients.to,
            ...(recipients.cc.length === 0 ? {} : { cc: [...recipients.cc] }),
            ...(recipients.bcc.length === 0 ? {} : { bcc: [...recipients.bcc] }),
            sendCopyToMe: payload.copy === true,
            attachment: payload.sendXml === true ? "xml" : "pdf",
          },
        }),
        summary:
          `${capitalize(info.noun)} ${String(args.id)} emailed to ${String(count)} ` +
          `recipient${count === 1 ? "" : "s"}: status ${after.statusLabel} ` +
          `(${String(after.status)}).`,
        affected: [changed],
      };
    },
  });
}
