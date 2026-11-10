/**
 * Arguments of the live tests (`pnpm test:live`) in one place: the read cases of
 * `read-only.test.ts` and the M4 write scenario of `lifecycle.test.ts`. A unit test
 * (`test/unit/scripts/m4-probes.test.ts`, "live cases") checks every argument set against the
 * shipped tool's input schema, so a renamed argument fails offline, not only in a live run.
 *
 * Also the local files the file tools need: a temporary `SEVDESK_FILE_DIRS` folder with a generated
 * receipt PDF and a Factur-X PDF, and a temporary `SEVDESK_OUTPUT_DIR`.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACTUR_X_XMP, facturXml } from "../../scripts/lib/probes/m4-einvoice-probes.js";
import { tinyPdf } from "../../scripts/lib/probes/m4-shared-probes.js";

/** Ids the by-id tools need, learned from the list tools. */
export interface Ids {
  contact?: number;
  invoice?: number;
  invoiceFinal?: number;
  creditNote?: number;
  creditNoteFinal?: number;
  order?: number;
  orderFinal?: number;
  voucher?: number;
  part?: number;
  transaction?: number;
}

type Args = Readonly<Record<string, unknown>>;

export interface LiveCase {
  readonly tool: string;
  /** Arguments; `undefined` when the account lacks the record the call needs. */
  readonly args: (ids: Ids, files: LocalFiles) => Args | undefined;
  /** A refusal that is a valid answer (e.g. getXml for an invoice that is not an e-invoice). */
  readonly acceptError?: RegExp;
  readonly label?: string;
}

/** The temporary folders of a live run and the generated files in them. */
export interface LocalFiles {
  /** `SEVDESK_FILE_DIRS` (realpath, absolute). */
  readonly fileDir: string;
  /** `SEVDESK_OUTPUT_DIR` (realpath, absolute). */
  readonly outputDir: string;
  /** A one-page receipt PDF in `fileDir` (absolute path). */
  readonly receipt: string;
  /** A one-page Factur-X PDF (EN 16931 CII) in `fileDir` (absolute path). */
  readonly facturX: string;
}

/** Creates the temporary folders and files; `cleanup` removes both folders. */
export async function prepareLocalFiles(
  tag: string,
  today: string,
): Promise<LocalFiles & { cleanup(): Promise<void> }> {
  const fileDir = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-live-files-")));
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-live-output-")));
  const receipt = join(fileDir, "receipt.pdf");
  const facturX = join(fileDir, "factur-x-invoice.pdf");
  await writeFile(
    receipt,
    await tinyPdf([`${tag} Beleg`, "Bürobedarf 100,00 EUR + 19 % USt = 119,00 EUR"]),
  );
  const content = {
    seller: `${tag} Lieferant GmbH`,
    number: "ZF-1",
    issueDate: today,
    dueDate: today,
  };
  await writeFile(
    facturX,
    await tinyPdf([`${tag} Rechnung ZF-1`, "238,00 EUR"], {
      name: "factur-x.xml",
      xml: facturXml(content),
      xmp: FACTUR_X_XMP,
    }),
  );
  return {
    fileDir,
    outputDir,
    receipt,
    facturX,
    cleanup: async () => {
      await rm(fileDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    },
  };
}

const SINCE = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date();
const byId = (key: keyof Ids) => (ids: Ids) =>
  ids[key] === undefined ? undefined : { id: ids[key] };

/** Every read tool with minimal arguments (`sevdesk_reference_lookup` runs once per kind). */
export const READ_CASES: readonly LiveCase[] = [
  { tool: "sevdesk_account_info", args: () => ({}) },
  { tool: "sevdesk_contacts_search", args: () => ({}) },
  { tool: "sevdesk_contact_get", args: byId("contact") },
  { tool: "sevdesk_contacts_next_customer_number", args: () => ({}) },
  { tool: "sevdesk_invoices_list", args: () => ({}) },
  { tool: "sevdesk_invoice_get", args: byId("invoice") },
  { tool: "sevdesk_invoice_pdf", args: byId("invoiceFinal") },
  {
    tool: "sevdesk_invoice_xml",
    args: byId("invoiceFinal"),
    acceptError: /e-invoice|E-Rechnung|XML/i,
  },
  { tool: "sevdesk_credit_notes_list", args: () => ({}) },
  { tool: "sevdesk_credit_note_get", args: byId("creditNote") },
  { tool: "sevdesk_credit_note_pdf", args: byId("creditNoteFinal") },
  { tool: "sevdesk_orders_list", args: () => ({}) },
  { tool: "sevdesk_order_get", args: byId("order") },
  { tool: "sevdesk_order_pdf", args: byId("orderFinal") },
  { tool: "sevdesk_vouchers_list", args: () => ({}) },
  { tool: "sevdesk_voucher_get", args: byId("voucher") },
  { tool: "sevdesk_bank_accounts_list", args: () => ({}) },
  { tool: "sevdesk_transactions_list", args: () => ({}) },
  { tool: "sevdesk_parts_list", args: () => ({}) },
  { tool: "sevdesk_part_get", args: byId("part") },
  { tool: "sevdesk_cash_position", args: () => ({}) },
  { tool: "sevdesk_changed_since", args: () => ({ since: SINCE }) },
  { tool: "sevdesk_payables_aging", args: () => ({}) },
  { tool: "sevdesk_receivables_aging", args: () => ({}) },
  ...(["invoices", "credit_notes", "vouchers", "transactions"] as const).map((subject) => ({
    tool: "sevdesk_records_summarize",
    label: `sevdesk_records_summarize (${subject})`,
    args: () => ({ subject }),
  })),
  // Local files: registered only with SEVDESK_OUTPUT_DIR / SEVDESK_FILE_DIRS (the read-only run
  // sets both to temporary folders); a tool that is not listed is skipped.
  {
    tool: "sevdesk_document_save",
    args: (ids) =>
      ids.invoiceFinal === undefined
        ? undefined
        : { document: "invoice_pdf", id: ids.invoiceFinal },
  },
  {
    tool: "sevdesk_voucher_receipt_save",
    args: byId("voucher"),
    // The first listed voucher may have no receipt; that refusal is a valid answer too.
    acceptError: /has no receipt file attached/,
  },
  // M4
  {
    tool: "sevdesk_einvoice_parse",
    args: (_ids, files) => ({ file: files.facturX }),
  },
  {
    tool: "sevdesk_invoice_einvoice_preflight",
    args: byId("invoice"),
  },
  { tool: "sevdesk_transaction_get", args: byId("transaction") },
  { tool: "sevdesk_reconcile_suggest", args: () => ({}) },
  {
    tool: "sevdesk_vat_summary",
    args: () => ({ year: NOW.getFullYear(), month: NOW.getMonth() + 1 }),
  },
  { tool: "sevdesk_profit_and_loss", args: () => ({ year: NOW.getFullYear() }) },
  { tool: "sevdesk_csv_export", args: () => ({ subject: "invoices" }) },
  // M6: the generic read (advanced toolset), on an undocumented endpoint no other tool reads.
  { tool: "sevdesk_api_get", args: () => ({ path: "/TextTemplate", limit: 5 }) },
  // M6: listed only over HTTP with file transfer, so the stdio run skips it.
  { tool: "sevdesk_upload_request", args: () => ({ purpose: "receipt" }) },
];

/** Placeholder ids and files for the offline schema check of {@link READ_CASES}. */
export const SAMPLE_IDS: Required<Ids> = {
  contact: 1,
  invoice: 2,
  invoiceFinal: 3,
  creditNote: 4,
  creditNoteFinal: 5,
  order: 6,
  orderFinal: 7,
  voucher: 8,
  part: 9,
  transaction: 10,
};

export const SAMPLE_FILES: LocalFiles = {
  fileDir: "/tmp/files",
  outputDir: "/tmp/output",
  receipt: "/tmp/files/receipt.pdf",
  facturX: "/tmp/files/factur-x-invoice.pdf",
};

/**
 * Arguments of the M4 write scenario (receipt → voucher → finalize → transaction → suggest → book
 * → reset → delete; DATEV export), aligned with the tool inputs of 2026-11-08.
 */
export const M4_ARGS = {
  voucherDraft: (tag: string, accountDatevId: number, file: string) => ({
    kind: "expense",
    supplierName: `${tag} Lieferant`,
    number: `${tag} B1`,
    positions: [{ accountDatevId, amount: "119.00", taxRate: 19, comment: `${tag} Bürobedarf` }],
    file,
  }),
  voucherFinalize: (id: number) => ({ id }),
  reconcileSuggest: (transactionId: number) => ({ transactionId }),
  transactionBook: (transactionId: number, voucherId: number) => ({
    id: transactionId,
    allocations: [{ kind: "voucher", id: voucherId, amount: "119.00" }],
  }),
  transactionGet: (id: number) => ({ id }),
  transactionReset: (id: number) => ({ id }),
  voucherReset: (id: number) => ({ id, to: "draft" }),
  voucherDelete: (id: number) => ({ id }),
  datevExport: (from: string, to: string) => ({ from, to }),
} as const;

/** Which tool each {@link M4_ARGS} entry belongs to (for the offline schema check). */
export const M4_ARG_TOOLS: Readonly<Record<keyof typeof M4_ARGS, string>> = {
  voucherDraft: "sevdesk_voucher_create_draft",
  voucherFinalize: "sevdesk_voucher_finalize",
  reconcileSuggest: "sevdesk_reconcile_suggest",
  transactionBook: "sevdesk_transaction_book",
  transactionGet: "sevdesk_transaction_get",
  transactionReset: "sevdesk_transaction_reset",
  voucherReset: "sevdesk_voucher_reset",
  voucherDelete: "sevdesk_voucher_delete_draft",
  datevExport: "sevdesk_datev_export",
};

/** {@link M4_ARGS} filled with sample values, for the offline schema check. */
export function sampleM4Args(): Readonly<Record<keyof typeof M4_ARGS, Args>> {
  const tag = "MCP-E2E 20261120-1000-abcd";
  return {
    voucherDraft: M4_ARGS.voucherDraft(tag, 4266, SAMPLE_FILES.receipt),
    voucherFinalize: M4_ARGS.voucherFinalize(8),
    reconcileSuggest: M4_ARGS.reconcileSuggest(10),
    transactionBook: M4_ARGS.transactionBook(10, 8),
    transactionGet: M4_ARGS.transactionGet(10),
    transactionReset: M4_ARGS.transactionReset(10),
    voucherReset: M4_ARGS.voucherReset(8),
    voucherDelete: M4_ARGS.voucherDelete(8),
    datevExport: M4_ARGS.datevExport("2026-10-01", "2026-10-31"),
  };
}
