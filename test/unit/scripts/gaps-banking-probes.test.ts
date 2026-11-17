import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordPlan } from "../../../scripts/lib/fixture-plan.js";
import { ALL_PROBES, NOT_PROBED } from "../../../scripts/lib/probes/catalog.js";
import {
  berlinMidnight,
  createProbeHttp,
  type Exchange,
} from "../../../scripts/lib/probes/core.js";
import {
  accountField,
  centsText,
  entryPattern,
  GAPS_BANKING_PROBES,
  hashesOf,
  hashMatch,
  RECOGNITION_POLL,
  sevQuery,
  snapshotChanges,
} from "../../../scripts/lib/probes/gaps-banking-probes.js";
import { EXPORT_POLL } from "../../../scripts/lib/probes/m4-reports-probes.js";
import { renderReport } from "../../../scripts/lib/probes/report.js";
import { type RunOptions, runProbes } from "../../../scripts/lib/probes/runner.js";
import { assertNoSecrets, createScrubber } from "../../../scripts/lib/scrub.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { swapPresignedFetch } from "../../../src/sevdesk/export-download.js";
import type { SevdeskRequest } from "../../../src/sevdesk/types.js";
import { RawAnswer, type ScriptedCall, ScriptedClient } from "./scripted-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TAG = "MCP-E2E 20261120-1000-abcd";
const TODAY = "2026-11-20";
const EXPORT_LINK =
  "https://sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com/542277/job/zip/BITTE-ENTPACKEN_5621913_99998.zip?X-Amz-Signature=deadbeefsecret";
const OPT_IN = [
  "write-cash-register-transaction",
  "write-export-datev-xml",
  "write-transaction-enshrine",
  "write-voucher-from-file",
];
const PERSONAL = /Huber|5621913|deadbeefsecret|X-Amz|1042/;

type Rec = Record<string, unknown>;

function refused(status: number, upstreamMessage: string): never {
  throw new SevdeskError({
    kind: "validation",
    message: "Invalid request",
    status,
    upstreamMessage,
  });
}

/** The bytes of each file part of a multipart request, read before the scripted handler runs. */
const formFiles = new WeakMap<FormData, Map<string, Uint8Array>>();

/** A {@link ScriptedClient} whose handler can read uploaded file bytes (Blobs read async). */
class FormReadingClient extends ScriptedClient {
  override async request(request: SevdeskRequest): Promise<unknown> {
    if (request.form !== undefined) {
      const files = new Map<string, Uint8Array>();
      for (const [field, value] of request.form.entries()) {
        if (typeof value !== "string") files.set(field, new Uint8Array(await value.arrayBuffer()));
      }
      formFiles.set(request.form, files);
    }
    return super.request(request);
  }
}

/** A minimal ZIP (stored entries, no data) with these file names. */
function makeZip(names: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const central: number[] = [];
  for (const name of names) {
    const bytes = encoder.encode(name);
    const header = new Uint8Array(46 + bytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(24, 42, true);
    view.setUint16(28, bytes.length, true);
    header.set(bytes, 46);
    central.push(...header);
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(10, names.length, true);
  view.setUint32(12, central.length, true);
  view.setUint32(16, 4, true);
  return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...central, ...end]);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * A simulated trial account with what the gap probes touch. Its answers follow the recording of
 * 2026-11-16 (D-095–D-103): refusal texts, soft deletes (`deletedAt`), archived accounts, the
 * counter-entry a reset books on a cash register, the ZIP exports' `content: null` JSON form,
 * recognition that fills a draft voucher after a moment. Where nothing was recorded (whether
 * lists show soft-deleted rows) the simulation picks one answer and no test depends on it.
 */
function gapsAccount(
  settings: {
    /** No cash register on the account. */
    noRegister?: boolean;
    /** Synthetic (safety test, not recorded): the ZIP exports ignore every filter. */
    zipIgnoresFilter?: boolean;
    /** Synthetic (safety test, not recorded): the invoice ZIP marks drafts as sent. */
    zipMarksSent?: boolean;
  } = {},
) {
  // Far from the digits PERSONAL looks for, so a generated id never matches it.
  let nextId = 30_000;
  const ref = (objectName: string, id: number | string) => ({ id: String(id), objectName });
  const accounts = new Map<number, Rec>([
    [6333721, { id: "6333721", objectName: "CheckAccount", type: "offline", status: "100" }],
  ]);
  if (settings.noRegister !== true) {
    accounts.set(6333723, {
      id: "6333723",
      objectName: "CheckAccount",
      name: "Kasse Huber",
      type: "register",
      importType: null,
      bankServer: null,
      status: "100",
    });
  }
  const transactions = new Map<number, Rec>();
  const vouchers = new Map<number, Rec>([
    [
      8001,
      {
        id: "8001",
        objectName: "Voucher",
        status: "100",
        description: "Beleg Huber",
        supplierName: "Huber Bau GmbH",
        sumGross: "50.00",
      },
    ],
  ]);
  const invoices = new Map<number, Rec>([
    [
      9001,
      {
        id: "9001",
        objectName: "Invoice",
        status: "200",
        header: "Rechnung an Huber Bau GmbH",
        contact: ref("Contact", 99),
      },
    ],
  ]);
  // A document sevDesk rendered when an invoice was finalized: listed, contentHash null (D-100).
  const rendered = new TextEncoder().encode("%PDF-1.7 rendered invoice");
  const documents = new Map<number, { row: Rec; bytes: Uint8Array; listed: boolean }>([
    [
      7001,
      {
        row: {
          id: "7001",
          objectName: "Document",
          filename: "Rechnung Huber.pdf",
          extension: "pdf",
          mimeType: "application/pdf",
          filesize: String(rendered.length),
          status: "100",
          contentHash: null,
        },
        bytes: rendered,
        listed: true,
      },
    ],
  ]);
  const uploads = new Map<string, Uint8Array>();
  const rules = new Map<number, Rec>();
  /** transaction id → voucher id it pays. */
  const links = new Map<number, number>();
  /** transaction id → voucher whose booking created it. */
  const createdBy = new Map<number, number>();
  const recognition = new Map<number, number>();

  const onAccount = (accountId: number) =>
    [...transactions.values()].filter(
      (row) => (row["checkAccount"] as Rec)["id"] === String(accountId),
    );
  const softDelete = (row: Rec) => {
    row["deletedAt"] = "2026-11-20T10:00:00+01:00";
  };
  const zipAnswer = (query: Readonly<Record<string, unknown>>, names: string[], kind: string) => {
    // The JSON form never carries the file (D-101); only download=true does.
    if (query["download"] !== "true") {
      return {
        objects: {
          filename: `${kind}_20.11.26.zip`,
          mimetype: "application/zip",
          base64Encoded: true,
          content: null,
        },
      };
    }
    return new RawAnswer(makeZip(names), "application/zip; charset=UTF-8'");
  };

  const handler = (call: ScriptedCall): unknown => {
    const { method, path, query } = call;
    const body = (call.body ?? {}) as Rec;
    const id = Number(/\/(\d+)(?:\/|$)/.exec(path)?.[1]);
    if (path === "/Tools/bookkeepingSystemVersion") return { objects: { version: "2.0" } };
    if (path === "/SevUser") return { total: "1", objects: [{ id: "7", objectName: "SevUser" }] };
    if (path === "/ReceiptGuidance/forAllAccounts") {
      return {
        objects: [
          {
            accountDatevId: 4266,
            accountNumber: "6815",
            allowedTaxRules: [{ id: 9, taxRates: ["NINETEEN"] }],
            allowedReceiptTypes: ["EXPENSE"],
          },
          {
            accountDatevId: 5192,
            accountNumber: "4400",
            allowedTaxRules: [{ id: 1, taxRates: ["NINETEEN"] }],
            allowedReceiptTypes: ["REVENUE"],
          },
        ],
      };
    }
    if (method === "POST" && path === "/Contact") {
      return { objects: { id: String(nextId++), objectName: "Contact" } };
    }
    // --- accounts ---------------------------------------------------------------------------
    if (path === "/CheckAccount") {
      if (method === "POST") {
        refused(
          400,
          "Use the factory endpoint fileImportAccount or clearingAccount to create new CheckAccounts",
        );
      }
      // Archived accounts (status 0) are not listed (D-097).
      const active = [...accounts.values()].filter((row) => row["status"] !== "0");
      return { total: String(active.length), objects: active };
    }
    if (path === "/CheckAccount/Factory/fileImportAccount") {
      const accountId = nextId++;
      accounts.set(accountId, {
        id: String(accountId),
        objectName: "CheckAccount",
        name: body["name"],
        type: "online",
        importType: body["importType"],
        bankServer: null,
        status: "100",
      });
      return { objects: accounts.get(accountId) };
    }
    if (path === "/CheckAccount/Factory/clearingAccount") {
      const accountId = nextId++;
      accounts.set(accountId, {
        id: String(accountId),
        objectName: "CheckAccount",
        name: body["name"],
        type: "offline",
        importType: null,
        accountingNumber:
          typeof body["accountingNumber"] === "number" ? String(body["accountingNumber"]) : "1803",
        status: "100",
      });
      return { objects: accounts.get(accountId) };
    }
    if (/^\/CheckAccount\/\d+\/getBalanceAtDate$/.test(path)) {
      const cents = onAccount(id).reduce(
        (sum, row) => sum + Math.round(Number(row["amount"]) * 100),
        50_000,
      );
      return { objects: (cents / 100).toFixed(2) };
    }
    if (/^\/CheckAccount\/\d+$/.test(path)) {
      const row = accounts.get(id);
      if (method === "PUT") {
        Object.assign(row ?? {}, { name: body["name"], update: "2026-11-20T10:00:01+01:00" });
        return { objects: row };
      }
      if (method === "DELETE") {
        // Archives the account and soft-deletes its transactions (D-097).
        if (row !== undefined) row["status"] = "0";
        for (const transaction of onAccount(id)) softDelete(transaction);
        return { objects: [null] };
      }
      return { objects: row === undefined ? [] : [row] };
    }
    // --- transactions -----------------------------------------------------------------------
    if (method === "POST" && path === "/CheckAccountTransaction") {
      const account = accounts.get(Number((body["checkAccount"] as Rec)["id"]));
      if (account?.["type"] !== "online") {
        refused(
          422,
          "You can only create transactions on online checkaccounts. Use document bookAmount to create transactions on other types.",
        );
      }
      const transactionId = nextId++;
      const row: Rec = {
        ...body,
        id: String(transactionId),
        objectName: "CheckAccountTransaction",
        amount: String(body["amount"]),
        status: "100",
        enshrined: null,
        deletedAt: null,
        checkAccount: ref("CheckAccount", Number((body["checkAccount"] as Rec)["id"])),
      };
      transactions.set(transactionId, row);
      return { objects: row };
    }
    if (/^\/CheckAccountTransaction\/\d+\/enshrine$/.test(path)) {
      const row = transactions.get(id);
      if (row === undefined) refused(404, "not found");
      if (row["status"] === "100") {
        refused(
          422,
          "Cannot enshrine transaction with status created (100). At least status linked (200) is required.",
        );
      }
      row["enshrined"] ??= "2026-11-20T10:00:00+01:00";
      return { objects: null };
    }
    if (/^\/CheckAccountTransaction\/\d+$/.test(path)) {
      const row = transactions.get(id);
      if (row === undefined) return { objects: [] };
      if (method === "PUT") {
        if (row["enshrined"] !== null) {
          refused(
            422,
            "Cannot set or change property 'enshrined'. Please use the dedicated endpoint instead.",
          );
        }
        row["status"] = String(body["status"]);
        return { objects: row };
      }
      if (method === "DELETE") {
        if (row["status"] !== "100") {
          refused(
            409,
            `CheckAccountTransaction can only be deleted in status 100 but is status ${String(row["status"])}`,
          );
        }
        softDelete(row);
        return { objects: [null] };
      }
      return { objects: [row] };
    }
    if (path === "/CheckAccountTransaction") {
      const filter = query["checkAccount[id]"];
      const rows = filter === undefined ? [...transactions.values()] : onAccount(Number(filter));
      return { total: String(rows.length), objects: rows };
    }
    // --- private transaction rules (hand-made rows never turned private, D-099) -------------
    if (path === "/PrivateTransactionRule") {
      if (method === "POST") {
        const ruleId = nextId++;
        const row: Rec = {
          id: String(ruleId),
          objectName: "PrivateTransactionRule",
          paymentPurpose: body["paymentPurpose"] ?? null,
          counterpartName: body["counterpartName"] ?? null,
        };
        rules.set(ruleId, row);
        return { objects: row };
      }
      return { objects: [...rules.values()] };
    }
    if (/^\/PrivateTransactionRule\/\d+$/.test(path) && method === "DELETE") {
      rules.delete(id);
      return { objects: [null] };
    }
    // --- vouchers and documents -------------------------------------------------------------
    if (path === "/Voucher/Factory/uploadTempFile") {
      const bytes = formFiles.get(call.form ?? new FormData())?.get("file");
      if (bytes === undefined) refused(400, "no file");
      // A new token per upload, even for the same bytes; the hash follows the bytes (D-100).
      const token = `${createHash("md5").update(String(nextId++)).digest("hex")}.pdf`;
      uploads.set(token, bytes);
      return {
        objects: {
          pages: 1,
          mimeType: "image/jpg",
          originMimeType: "application/pdf",
          filename: token,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          content: [`/9j/${"A".repeat(500)}`],
          isEInvoice: false,
        },
      };
    }
    if (path === "/Voucher/Factory/createVoucherFromFile") {
      const files = formFiles.get(call.form ?? new FormData());
      if (files?.get("voucher") === undefined) refused(400, "No file given");
      const voucherId = nextId++;
      // A draft at once, with placeholders until the recognition fills it (D-103).
      vouchers.set(voucherId, {
        id: String(voucherId),
        objectName: "Voucher",
        status: "50",
        creditDebit: call.form?.get("creditDebit"),
        voucherDate: "2026-11-20T09:59:02+01:00",
        supplierName: null,
        sumGross: "0",
        showNet: "1",
        description: null,
        taxRule: null,
        document: ref("Document", nextId++),
      });
      recognition.set(voucherId, 0);
      return { objects: vouchers.get(voucherId) };
    }
    if (path === "/Voucher/Factory/saveVoucher") {
      const voucher = body["voucher"] as Rec;
      const voucherId = voucher["id"] === undefined ? nextId++ : Number(voucher["id"]);
      const gross = ((body["voucherPosSave"] ?? []) as Rec[]).reduce(
        (sum, pos) => sum + Number(pos["sumGross"] ?? Number(pos["sumNet"]) * 1.19),
        0,
      );
      const record: Rec = {
        ...vouchers.get(voucherId),
        ...voucher,
        id: String(voucherId),
        status: String(voucher["status"]),
        sumGross: gross.toFixed(2),
        paidAmount: 0,
        voucherDate: `${TODAY}T00:00:00+01:00`,
        update: "2026-11-20T09:00:00+01:00",
      };
      const token = body["filename"];
      if (typeof token === "string") {
        // The receipt's Document: status 50, no mimeType, SHA-256 hash, not listed (D-100).
        const documentId = nextId++;
        const bytes = uploads.get(token) ?? new Uint8Array();
        documents.set(documentId, {
          row: {
            id: String(documentId),
            objectName: "Document",
            filename: "Huber Beleg.pdf",
            extension: "pdf",
            mimeType: null,
            status: "50",
            filesize: String(bytes.length),
            contentHash: createHash("sha256").update(bytes).digest("hex"),
          },
          bytes,
          listed: false,
        });
        record["document"] = ref("Document", documentId);
      }
      vouchers.set(voucherId, record);
      return { objects: { voucher: ref("Voucher", voucherId), voucherPos: [] } };
    }
    if (/^\/Voucher\/\d+\/bookAmount$/.test(path)) {
      const voucher = vouchers.get(id)!;
      const linked = (body["checkAccountTransaction"] as Rec | undefined)?.["id"];
      const account = Number((body["checkAccount"] as Rec)["id"]);
      if (linked !== undefined) {
        const transaction = transactions.get(Number(linked))!;
        if (transaction["enshrined"] !== null || transaction["status"] === "400") {
          refused(422, "Voucher is not bookable with given payment information");
        }
        transaction["status"] = "400";
        links.set(Number(linked), id);
      } else {
        const transactionId = nextId++;
        transactions.set(transactionId, {
          id: String(transactionId),
          objectName: "CheckAccountTransaction",
          amount: String(body["amount"]),
          status: "400",
          enshrined: null,
          deletedAt: null,
          payeePayerName: "Huber Bau GmbH",
          paymtPurpose: "Beleg",
          valueDate: `${TODAY}T12:00:00+01:00`,
          entryDate: `${TODAY}T12:00:00+01:00`,
          checkAccount: ref("CheckAccount", account),
        });
        createdBy.set(transactionId, id);
      }
      Object.assign(voucher, { status: "1000", paidAmount: body["amount"] });
      return { objects: { id: String(nextId++), objectName: "VoucherLog" } };
    }
    if (/^\/Voucher\/\d+\/resetToOpen$/.test(path)) {
      for (const [transactionId, voucherId] of links) {
        if (voucherId !== id) continue;
        if (transactions.get(transactionId)?.["enshrined"] !== null) {
          refused(400, "Already enshrined by transaction");
        }
      }
      for (const [transactionId, voucherId] of [...links]) {
        if (voucherId !== id) continue;
        transactions.get(transactionId)!["status"] = "100";
        links.delete(transactionId);
      }
      for (const [transactionId, voucherId] of [...createdBy]) {
        if (voucherId !== id) continue;
        const created = transactions.get(transactionId)!;
        const account = accounts.get(Number((created["checkAccount"] as Rec)["id"]));
        createdBy.delete(transactionId);
        if (account?.["type"] !== "register") {
          transactions.delete(transactionId);
          continue;
        }
        // On a cash register the reset books a counter-entry at the reset's time (D-095).
        const counterId = nextId++;
        transactions.set(counterId, {
          ...created,
          id: String(counterId),
          amount: String(-Number(created["amount"])),
          payeePayerName: null,
          valueDate: "2026-11-20T10:30:00+01:00",
          entryDate: "2026-11-20T10:30:00+01:00",
        });
      }
      Object.assign(vouchers.get(id)!, { status: "100", paidAmount: 0 });
      return { objects: vouchers.get(id) };
    }
    if (/^\/Voucher\/\d+$/.test(path)) {
      const record = vouchers.get(id);
      if (method === "DELETE") {
        if (record?.["status"] !== "50") refused(409, "Only drafts can be deleted");
        vouchers.delete(id);
        // The receipt's Document goes with the draft (D-100).
        const documentId = Number((record["document"] as Rec | undefined)?.["id"]);
        documents.delete(documentId);
        return { objects: [null] };
      }
      const reads = recognition.get(id);
      if (record !== undefined && reads !== undefined) {
        recognition.set(id, reads + 1);
        if (reads + 1 >= 2) {
          // Recorded: the supplier text is not the PDF's first line, and no tax rule is set.
          Object.assign(record, {
            supplierName: "Lieferant GmbH",
            sumGross: "119",
            sumNet: "100",
            sumTax: "19",
            showNet: "0",
            voucherDate: `${TODAY}T00:00:00+01:00`,
            description: `${TAG.replace(/[^A-Za-z0-9-]+/g, "-")}-R1`,
            resultDisdar: "recognised",
          });
        }
      }
      return record === undefined ? refused(404, "not found") : { objects: [record] };
    }
    if (path === "/Voucher")
      return { total: String(vouchers.size), objects: [...vouchers.values()] };
    if (path === "/VoucherPos") {
      const voucherId = Number(query["voucher[id]"]);
      return recognition.has(voucherId) && (recognition.get(voucherId) ?? 0) >= 2
        ? {
            objects: [
              {
                id: "77",
                objectName: "VoucherPos",
                voucher: ref("Voucher", voucherId),
                sumGross: "119",
                taxRate: "19",
                accountDatev: null,
              },
            ],
          }
        : { objects: [] };
    }
    if (/^\/Document\/\d+\/download$/.test(path)) {
      const document = documents.get(id);
      if (document === undefined) refused(404, "not found");
      return {
        objects: {
          filename: "a9e6.pdf",
          mimetype: null,
          base64Encoded: true,
          content: base64(document.bytes),
        },
      };
    }
    if (/^\/Document\/\d+$/.test(path)) {
      const document = documents.get(id);
      return { objects: document === undefined ? [] : [document.row] };
    }
    if (path === "/Document") {
      const rows = [...documents.values()].filter((item) => item.listed).map((item) => item.row);
      return { total: String(rows.length), objects: rows };
    }
    // --- invoices ---------------------------------------------------------------------------
    if (path === "/Invoice/Factory/saveInvoice") {
      const invoiceId = nextId++;
      invoices.set(invoiceId, {
        ...(body["invoice"] as Rec),
        id: String(invoiceId),
        status: "100",
        sendDate: null,
        sendType: null,
      });
      return { objects: { invoice: ref("Invoice", invoiceId) } };
    }
    if (/^\/Invoice\/\d+\/sendBy$/.test(path)) {
      Object.assign(invoices.get(id)!, {
        status: "200",
        sendDate: "2026-11-20T10:00:00+01:00",
        sendType: "VPR",
      });
      return { objects: invoices.get(id) };
    }
    if (/^\/Invoice\/\d+$/.test(path)) {
      return { objects: invoices.has(id) ? [invoices.get(id)] : [] };
    }
    if (path === "/Invoice")
      return { total: String(invoices.size), objects: [...invoices.values()] };
    // --- exports ----------------------------------------------------------------------------
    if (path === "/Export/invoiceZip") {
      const contact = String(query["sevQuery[filter][contact][id]"]);
      const matching = [...invoices.values()].filter(
        (row) =>
          settings.zipIgnoresFilter === true || String((row["contact"] as Rec)["id"]) === contact,
      );
      if (settings.zipMarksSent === true) {
        for (const row of matching.filter((item) => item["status"] === "100")) {
          Object.assign(row, { sendDate: "2026-11-20T10:05:00+01:00", sendType: "VPDF" });
        }
      }
      // Drafts are exported too, labelled "(Entwurf)" instead of a number (D-101).
      const names = matching
        .slice(0, Number(query["sevQuery[limit]"]))
        .map((row) =>
          row["status"] === "100"
            ? `2026-11-20_Rechnung(Entwurf)__${createHash("md5").update(String(row["id"])).digest("hex")}.pdf`
            : `2026-11-20_Rechnung_RE-1042_Huber Bau GmbH.pdf`,
        );
      return zipAnswer(query, names, "Rechnungen");
    }
    if (path === "/Export/voucherZip") {
      const old = Number(query["sevQuery[filter][startDate]"]) < berlinMidnight("2001-01-01");
      const from = Number(query["sevQuery[filter][startAmount]"] ?? 0);
      const to = Number(query["sevQuery[filter][endAmount]"] ?? Infinity);
      const names = [...vouchers.values()]
        .filter(
          (row) =>
            settings.zipIgnoresFilter === true ||
            (!old && Number(row["sumGross"]) >= from && Number(row["sumGross"]) <= to),
        )
        .slice(0, Number(query["sevQuery[limit]"]))
        .map((row) => `Beleg_${String(row["id"])}_Huber Bau GmbH.pdf`);
      return zipAnswer(query, names, "Belege");
    }
    if (path === "/Export/createDatevXmlZipExportJob") {
      if (method === "GET") refused(500, "Function was called with wrong HTTP Type");
      // Recorded: no document changed, and includeExportedDocuments=false changed nothing.
      return { objects: "0a0e1eff-9590-1bea-1195-a3cfc04364cc" };
    }
    if (path === "/Progress/generateDownloadHash") {
      return { objects: { progressHash: "22ae177d286f17aac5daac591c70164159b64c7f_0a0e1eff" } };
    }
    if (path === "/Progress/getProgress") {
      return { objects: { percent: 100, current: 100, errors: [], total: 100, failure: false } };
    }
    if (path === "/ExportJob/jobDownloadInfo") {
      return {
        objects: {
          jobId: "0a0e1eff-9590-1bea-1195-a3cfc04364cc",
          linkExpireDate: "2026-11-27T10:00:00+01:00",
          link: EXPORT_LINK,
          filename: "BITTE-ENTPACKEN_DATEV-XML_5621913_99998_20261020_bis_20261120.zip",
        },
      };
    }
    if (method !== "GET") refused(422, "not simulated");
    return { total: "0", objects: [] };
  };

  // Recorded: a ZIP of two inner ZIPs named DATEV_…, the same for both jobs (D-102).
  const download = vi.fn(() =>
    Promise.resolve(
      new Response(
        makeZip([
          "DATEV_Belegbilder_Huber_5621913_20261020_bis_20261120.zip",
          "DATEV_Buchungsdaten_5621913_20261020_bis_20261120.zip",
        ]),
        { headers: { "content-type": "binary/octet-stream" } },
      ),
    ),
  );
  return {
    client: new FormReadingClient(handler),
    accounts,
    transactions,
    vouchers,
    invoices,
    rules,
    download,
  };
}

function options(client: ScriptedClient, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    client,
    scrubber: createScrubber({ secrets: [TOKEN] }),
    probes: GAPS_BANKING_PROBES,
    allowWrites: true,
    tag: TAG,
    today: TODAY,
    nowSeconds: Date.parse("2026-11-20T09:00:00Z") / 1000,
    baseUrl: "https://my.sevdesk.de/api/v1",
    ...overrides,
  };
}

async function run(
  account: ReturnType<typeof gapsAccount>,
  only?: readonly string[],
): Promise<Awaited<ReturnType<typeof runProbes>>> {
  const restore = swapPresignedFetch(account.download);
  try {
    return await runProbes(options(account.client, only === undefined ? {} : { only }));
  } finally {
    restore();
  }
}

function finding(report: Awaited<ReturnType<typeof runProbes>>, id: string): string {
  const result = report.results.find((item) => item.id === id);
  expect(result, id).toBeDefined();
  expect(result?.status, `${id}: ${result?.finding ?? ""}`).not.toBe("error");
  return result?.finding ?? "";
}

const ALL_IDS = GAPS_BANKING_PROBES.map((probe) => probe.id);
const saved = { export: EXPORT_POLL.delayMs, recognition: RECOGNITION_POLL.delayMs };

beforeEach(() => {
  EXPORT_POLL.delayMs = 0;
  RECOGNITION_POLL.delayMs = 0;
});

afterEach(() => {
  EXPORT_POLL.delayMs = saved.export;
  RECOGNITION_POLL.delayMs = saved.recognition;
});

describe("gap probe catalog", () => {
  it("registers every probe once, keeps exactly the four irreversible ones opt-in", () => {
    const ids = ALL_PROBES.map((probe) => probe.id);
    for (const probe of GAPS_BANKING_PROBES) {
      expect(
        ids.filter((id) => id === probe.id),
        probe.id,
      ).toHaveLength(1);
      expect(probe.id.startsWith(`${probe.mode}-`), probe.id).toBe(true);
      expect(probe.deviations.length, probe.id).toBeGreaterThan(0);
      expect(probe.sendsEmail, probe.id).toBeUndefined();
    }
    const optIn = GAPS_BANKING_PROBES.filter((probe) => probe.optIn === true);
    expect(optIn.map((probe) => probe.id).sort()).toEqual(OPT_IN);
    for (const probe of optIn) expect(probe.question, probe.id).toMatch(/irreversible/i);
    // The irreversible ones run last among the writes.
    const writes = GAPS_BANKING_PROBES.filter((probe) => probe.mode === "write").map(
      (probe) => probe.id,
    );
    expect(writes.slice(-OPT_IN.length).sort()).toEqual(OPT_IN);
    expect(writes.at(-1)).toBe("write-transaction-enshrine");
  });

  it("lists as never probed only what stays unprobed", () => {
    const manual = NOT_PROBED.map((check) => check.what).join("\n");
    expect(manual).not.toMatch(/createDatevXmlZipExportJob|createVoucherFromFile/);
    expect(manual).not.toMatch(/CheckAccountTransaction\/\{id\}\/enshrine/);
    // write-transaction-enshrine asks it (resetToOpen on the voucher its transaction paid).
    expect(manual).not.toMatch(/payment transaction is enshrined/);
    expect(manual).toMatch(/Invoice\|CreditNote\|Voucher\/\{id\}\/enshrine/);
    expect(manual).toMatch(/enshrineDocuments/);
  });

  it("records the private-transaction rules as a plain list read", () => {
    const entry = recordPlan(TODAY).find((item) => item.path === "/PrivateTransactionRule");
    expect(entry).toMatchObject({ file: "banking/private-transaction-rules.json", list: true });
  });
});

describe("gap probes on a simulated trial account", () => {
  it("runs the default set without errors, opt-ins skipped, nothing enshrined or exported as XML", async () => {
    const account = gapsAccount();
    const report = await run(account);
    expect(report.results.filter((result) => result.status === "error")).toEqual([]);
    for (const id of OPT_IN) {
      expect(report.results.find((result) => result.id === id)?.status).toBe("skipped");
    }
    const calls = account.client.calls;
    expect(
      calls.some((call) => /enshrine|createDatevXml|createVoucherFromFile/.test(call.path)),
    ).toBe(false);
    // Nothing is booked on the cash register (6333723): its rows would stay in the cash book.
    expect(
      account.client.writes().filter((call) => JSON.stringify(call.body ?? {}).includes("6333723")),
    ).toEqual([]);
    for (const call of account.client.writes()) {
      expect(call.tier, `${call.method} ${call.path}`).toMatch(/^(write|commit)$/);
      if (/bookAmount|resetTo|^\/CheckAccountTransaction(\/\d+)?$/.test(call.path)) {
        expect(call.tier, call.path).toBe("commit");
      }
    }
    // The ZIP exports go out as side-effect GETs with the write tier, always with a limit.
    const zips = calls.filter((call) => call.path.endsWith("Zip"));
    expect(zips.length).toBeGreaterThanOrEqual(6);
    for (const call of zips) {
      expect(call).toMatchObject({ method: "GET", sideEffect: true, tier: "write" });
      expect(call.query["sevQuery[limit]"]).toBeGreaterThan(0);
    }
    // Cleanup: rules deleted, nothing left private, the probe's accounts gone except the import one.
    expect(account.rules.size).toBe(0);
    expect([...account.transactions.values()].filter((row) => row["status"] === "300")).toEqual([]);
    const markdown = renderReport(report);
    expect(() => {
      assertNoSecrets(markdown, [TOKEN]);
    }).not.toThrow();
    expect(markdown).not.toMatch(PERSONAL);
    for (const voucher of account.vouchers.values()) {
      if (voucher["id"] !== "8001") expect(String(voucher["description"])).toMatch(/^MCP-E2E /);
    }
    for (const transaction of account.transactions.values()) {
      if (transaction["paymtPurpose"] !== "Beleg") {
        expect(transaction["paymtPurpose"]).toMatch(/^MCP-E2E /);
        expect(transaction["payeePayerName"]).toMatch(/^MCP-E2E /);
      }
    }
  });

  it("answers the banking questions as recorded: register, factories, deletes, rules", async () => {
    const account = gapsAccount();
    const report = await run(account, [
      ...ALL_IDS.filter((id) => !OPT_IN.includes(id)),
      "write-cash-register-transaction",
    ]);
    const cash = finding(report, "write-cash-register-transaction");
    expect(cash).toMatch(
      /POST \/CheckAccountTransaction on register 6333723: refused \(422: You can only create/,
    );
    expect(cash).toMatch(
      /cash sale .*: ok; .*new register transactions \d+ \(amount 23\.8, status 400/,
    );
    expect(cash).toMatch(
      /cash expense .*new register transactions \d+ \(amount -11\.9, status 400/,
    );
    // D-095: the reset keeps the booking and books a counter-entry at the reset's time.
    expect(cash).toMatch(
      /cash sale voucher \d+: ok; register transactions kept 2 of 2, new \d+ \(amount -23\.8, status 400/,
    );
    expect(cash).toMatch(/cash expense voucher \d+: ok; .*new \d+ \(amount 11\.9, status 400/);
    expect(cash).toMatch(
      /before the bookings 500\.00, after them 511\.90, after the resets 500\.00/,
    );
    // The two bookings and the two counter-entries stay in the cash book, and the list says so.
    const cashRows = report.created.filter(
      (record) =>
        record.probe === "write-cash-register-transaction" &&
        record.objectName === "CheckAccountTransaction",
    );
    expect(cashRows.map((record) => record.state)).toEqual([
      expect.stringMatching(/^permanent cash-book entry \(cash sale of voucher \d+\)$/),
      expect.stringMatching(/^permanent cash-book entry \(cash expense of voucher \d+\)$/),
      expect.stringMatching(/^permanent cash-book entry \(counter-entry of the reset of voucher/),
      expect.stringMatching(/^permanent cash-book entry \(counter-entry of the reset of voucher/),
    ]);
    const registerRows = [...account.transactions.values()].filter(
      (row) => (row["checkAccount"] as Rec | undefined)?.["id"] === "6333723",
    );
    expect(cashRows.map((record) => String(record.id)).sort()).toEqual(
      registerRows.map((row) => String(row["id"])).sort(),
    );

    const factories = finding(report, "write-check-account-factories");
    expect(factories).toMatch(
      /clearingAccount without accountingNumber: \d+, .*type="offline".*accountingNumber "1803"/,
    );
    expect(factories).toMatch(/POST \/CheckAccountTransaction on it: refused \(422/);
    expect(factories).toMatch(/changed: name, update/);
    // D-097: DELETE archives the account (status 0) and soft-deletes its transactions.
    expect(factories).toMatch(/DELETE of the empty clearing account: ok.*still there \(status 0\)/);
    expect(factories).toMatch(
      /holding transaction \d+: ok; account still there, transaction status 100, soft-deleted/,
    );
    expect(factories).toMatch(
      /POST \/CheckAccount with type register: refused \(400: Use the factory endpoint/,
    );

    // D-096: a soft delete, and only at status 100.
    const deletes = finding(report, "write-transaction-delete");
    expect(deletes).toMatch(
      /unbooked \d+: DELETE ok, answer a list of 1; afterwards status 100, soft-deleted/,
    );
    expect(deletes).toMatch(
      /private \d+ \(status 300 ok, now status 300\): DELETE refused \(409: CheckAccountTransaction can only be deleted in status 100 but is status 300\).*cleanup: status 100 ok, DELETE ok/,
    );
    expect(deletes).toMatch(
      /then status 400\): DELETE refused \(409.*cleanup: resetToOpen ok, transaction status 100, DELETE ok/,
    );

    // D-099: rules never turned a hand-made row private.
    const rules = finding(report, "write-private-transaction-rule");
    expect(rules).toMatch(
      /after creating the rules: exact counterpart status 100, counterpart containing it status 100, exact purpose status 100, purpose containing it status 100, neither status 100/,
    );
    expect(rules).toMatch(/created after the rules \(exact counterpart\): status 100/);
    expect(rules).toMatch(/cleanup back to 100: nothing private/);

    // The follow-up for D-096/D-097: counts only, the simulation lists soft-deleted rows.
    const soft = finding(report, "read-transaction-soft-delete");
    expect(soft).toMatch(
      /without a filter: \d+ rows \(total \d+\), 4 with deletedAt \(\d+ status 100(, \d+ status 100){3}\), 1 of accounts not in GET \/CheckAccount/,
    );
    // Bookings and counter-entries cancel out on the register.
    expect(soft).toMatch(/account 6333723: 4 rows, 0 with deletedAt; sum of all 0\.00/);

    const kinds = finding(report, "read-check-account-kinds");
    expect(kinds).toMatch(/type="register"/);
    expect(kinds).toMatch(/importType="CSV"/);
    expect(kinds).toMatch(/No account looks bank-connected/);
  });

  it("compares receipt hashes without showing them", async () => {
    const account = gapsAccount();
    const report = await run(account);
    const hash = finding(report, "write-receipt-hash");
    expect(hash).toMatch(/upload \(\d+ bytes\): contentHash is the SHA-256 of the uploaded bytes/);
    expect(hash).toMatch(/same bytes again: token a new one, contentHash the same/);
    expect(hash).toMatch(
      /GET \/Document\/\d+: contentHash is the SHA-256 of the uploaded bytes; .*mimeType none/,
    );
    expect(hash).toMatch(/in GET \/Document: not among the first 1000 rows/);
    expect(hash).toMatch(/download: \d+ bytes, the uploaded bytes/);
    expect(hash).toMatch(/DELETE of the draft voucher ok; its Document afterwards gone/);
    // Documents sevDesk rendered carry no hash.
    expect(finding(report, "read-document-hash")).toMatch(/contentHash is null/);
    expect(renderReport(report)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("exports the ZIPs, describes entries as patterns and sees no change to documents", async () => {
    const account = gapsAccount();
    const report = await run(account);
    const invoices = finding(report, "write-export-invoice-zip");
    // D-101: the check runs on the raw form, the JSON form has no content, drafts are exported.
    expect(invoices).toMatch(/Filter check .*: raw body, .*with 0 entries/);
    expect(invoices).toMatch(
      /Without download: JSON .*filename "Rechnungen_##\.##\.##\.zip", mimetype application\/zip, base64Encoded true, content null/,
    );
    expect(invoices).toMatch(
      /With download=true: raw body, Content-Type application\/zip; charset=UTF-8': a ZIP of \d+ bytes with 2 entries \(2 pdf\): ####-##-##_Rechnung\(<7>\)__<32 hex>\.pdf .*####-##-##_Rechnung_RE-####_<5> <3> <4>\.pdf/,
    );
    expect(invoices).toMatch(/Draft \d+ afterwards: unchanged/);
    expect(invoices).toMatch(/all invoices: none of \d+ changed/);
    const vouchers = finding(report, "write-export-voucher-zip");
    expect(vouchers).toMatch(/Filter check \(January 2000, limit 1\): raw body, .*with 0 entries/);
    expect(vouchers).toMatch(/With download=true: .*with 2 entries/);
    expect(vouchers).toMatch(/All vouchers afterwards: none of \d+ changed/);
    // The raw ZIP never reaches the evidence beyond its signature.
    const evidence = JSON.stringify(report.results.flatMap((result) => result.evidence));
    expect(evidence).toContain('binary, starts with \\"PK\\"');
    expect(evidence).not.toMatch(/Rechnung_RE|Beleg_/);
  });

  it("stops the ZIP probes when sevDesk ignores the filters, and reports drafts marked as sent", async () => {
    const ignoring = await run(gapsAccount({ zipIgnoresFilter: true }), [
      "write-export-invoice-zip",
      "write-export-voucher-zip",
    ]);
    expect(finding(ignoring, "write-export-invoice-zip")).toMatch(/filters are ignored: stopped/);
    expect(finding(ignoring, "write-export-voucher-zip")).toMatch(/filters are ignored: stopped/);
    const marking = await run(gapsAccount({ zipMarksSent: true }), ["write-export-invoice-zip"]);
    expect(finding(marking, "write-export-invoice-zip")).toMatch(
      /Draft \d+ afterwards: sendDate: \(empty\) → 2026-11-20T10:05:00\+01:00; sendType: \(empty\) → VPDF/,
    );
  });

  it("runs the opt-in probes only when named: one own transaction enshrined, XML job, recognition", async () => {
    const account = gapsAccount();
    const report = await run(account, ALL_IDS);
    expect(report.results.filter((result) => result.status === "error")).toEqual([]);

    // Enshrine: only the probe's own transaction, never anything else.
    const enshrines = account.client.calls.filter((call) => call.path.endsWith("/enshrine"));
    const ids = new Set(enshrines.map((call) => /\/(\d+)\/enshrine$/.exec(call.path)?.[1]));
    expect(ids.size).toBe(1);
    expect(enshrines.every((call) => call.path.startsWith("/CheckAccountTransaction/"))).toBe(true);
    const [enshrinedId] = [...ids];
    expect(
      report.created.find(
        (record) =>
          record.objectName === "CheckAccountTransaction" && String(record.id) === enshrinedId,
      ),
    ).toMatchObject({
      probe: "write-transaction-enshrine",
      state: expect.stringMatching(/ENSHRINED/) as unknown,
    });
    expect(
      [...account.transactions.values()].filter((row) => row["enshrined"] !== null),
    ).toHaveLength(1);
    const enshrine = finding(report, "write-transaction-enshrine");
    // D-098, as recorded.
    expect(enshrine).toMatch(
      /enshrine at status 100: refused \(422: Cannot enshrine transaction with status created \(100\)/,
    );
    expect(enshrine).toMatch(/enshrine at status 400: ok, answer null/);
    expect(enshrine).toMatch(/transaction changed: enshrined null → 9999-99-99T99:99:99\+99:99/);
    expect(enshrine).toMatch(/voucher \d+ changed: nothing/);
    expect(enshrine).toMatch(/second enshrine: ok/);
    expect(enshrine).toMatch(/PUT status 100: refused \(422: Cannot set or change property/);
    expect(enshrine).toMatch(
      /booking a second voucher \d+ on it: refused \(422: Voucher is not bookable/,
    );
    expect(enshrine).toMatch(
      /resetToOpen on voucher \d+: refused \(400: Already enshrined by transaction/,
    );
    expect(enshrine).toMatch(/DELETE: DELETE refused \(409: .*but is status 400/);

    // XML job: a POST without enshrine flags; the download only through the export transport.
    const xml = account.client.calls.filter((call) => call.path.includes("DatevXml"));
    expect(xml).toHaveLength(2);
    for (const call of xml) {
      expect(call).toMatchObject({ method: "POST", tier: "write" });
      expect(JSON.stringify([call.query, call.body ?? {}])).not.toMatch(/enshrine/i);
    }
    expect(account.download).toHaveBeenCalledTimes(2);
    const datev = finding(report, "write-export-datev-xml");
    expect(datev).toMatch(
      /link host sevexport-filestorage-workload-prod\.s3\.eu-central-1\.amazonaws\.com/,
    );
    // D-102: two inner ZIPs, nothing changed, the second job exports the same.
    expect(datev).toMatch(/a ZIP of \d+ bytes with 2 entries \(2 zip\): DATEV_/);
    expect(datev).toMatch(
      /Invoices afterwards: none of \d+ changed; vouchers: none of \d+ changed/,
    );
    expect(datev).toMatch(/Entries: 2 → 2 \(the same: nothing visibly marked\)/);

    // Recognition: multipart with creditDebit C and the file part `voucher`.
    const upload = account.client.calls.find((call) => call.path.endsWith("createVoucherFromFile"));
    expect(upload?.form?.get("creditDebit")).toBe("C");
    expect(upload?.form?.get("voucher")).toBeInstanceOf(Blob);
    const recognised = finding(report, "write-voucher-from-file");
    // D-103, as recorded.
    expect(recognised).toMatch(/answer an object with keys .*\(objectName Voucher\)/);
    expect(recognised).toMatch(/recognised after 2 reads/);
    expect(recognised).toMatch(/status 50, .*creditDebit C/);
    expect(recognised).toMatch(/supplierName set, not the PDF's supplier, supplier none/);
    expect(recognised).toMatch(/voucherDate the PDF's date/);
    expect(recognised).toMatch(/description the PDF's Rechnung Nr\./);
    expect(recognised).toMatch(/sumNet 100, sumTax 19, sumGross 119, taxRule null, document set/);
    expect(recognised).toMatch(
      /positions 1 \(first: sumGross 119, taxRate 19, accountDatev null\)/,
    );
    expect(
      report.created.some(
        (record) => record.objectName === "Voucher" && record.probe === "write-voucher-from-file",
      ),
    ).toBe(true);

    const markdown = renderReport(report);
    expect(() => {
      assertNoSecrets(markdown, [TOKEN]);
    }).not.toThrow();
    expect(markdown).not.toMatch(PERSONAL);
  });

  it("is inconclusive without a cash register, never an error", async () => {
    const report = await run(gapsAccount({ noRegister: true }), [
      "write-cash-register-transaction",
    ]);
    expect(report.results[0]).toMatchObject({
      status: "inconclusive",
      finding: expect.stringMatching(/No active cash register/) as unknown,
    });
  });
});

describe("gap probe helpers", () => {
  it("reduces export entry names to patterns without names, numbers or the tag's digits", () => {
    expect(entryPattern("Rechnung_RE-1042_Huber Bau GmbH.pdf", TAG)).toBe(
      "Rechnung_RE-####_<5> <3> <4>.pdf",
    );
    expect(entryPattern("Belege_1.2.26.zip", TAG)).toBe("Belege_#.#.##.zip");
    expect(entryPattern(`Belege/${TAG} upload.pdf`, TAG)).toBe("Belege/<tag> <6>.pdf");
    expect(entryPattern("f019bec36c65f5a0e7d2c63cc33f0681.pdf", TAG)).toBe("<32 hex>.pdf");
    expect(entryPattern("Übersicht Müller.xml", TAG)).toBe("<9> <6>.xml");
  });

  it("names the matching hash, never its value", () => {
    const bytes = new TextEncoder().encode("receipt");
    const hashes = hashesOf(bytes);
    expect(hashMatch(hashes.MD5.toUpperCase(), hashes, "the bytes")).toBe("the MD5 of the bytes");
    expect(hashMatch("abc123", hashes, "the bytes")).toBe(
      "none of SHA-256/MD5/SHA-1 of the bytes (6 hex characters)",
    );
    expect(hashMatch(null, hashes, "x")).toBe("null");
    expect(hashMatch(undefined, hashes, "x")).toBe("absent");
  });

  it("shows account codes and flags, never names or IBANs", () => {
    expect(accountField("type", "online")).toBe('"online"');
    expect(accountField("iban", "DE02120300000000202051")).toBe("set");
    expect(accountField("lastSync", "2026-11-20T10:00:00+01:00")).toBe("date-time");
    expect(accountField("bankServer", null)).toBe("null");
    expect(accountField("name", "Kasse Huber")).toBe("set");
  });

  it("sums decimal amounts exactly, or says it cannot", () => {
    expect(centsText(["500", "23.8", "-11.9", "-23.8", "11.9"])).toBe("500.00");
    expect(centsText(["0.1", "0.2"])).toBe("0.30");
    expect(centsText(["-0.05"])).toBe("-0.05");
    expect(centsText([])).toBe("0.00");
    expect(centsText(["1.005"])).toBe("not summable");
    expect(centsText(["abc"])).toBe("not summable");
  });

  it("builds nested sevQuery filters", () => {
    expect(sevQuery("Invoice", 1, { "contact/id": 5, startDate: 10 })).toEqual({
      "sevQuery[limit]": 1,
      "sevQuery[modelName]": "Invoice",
      "sevQuery[objectName]": "SevQuery",
      "sevQuery[filter][contact][id]": 5,
      "sevQuery[filter][startDate]": 10,
    });
  });

  it("reports changed documents with safe values only", () => {
    const before = new Map([
      ["1", { id: "1", status: "100", header: "Huber" }],
      ["2", { id: "2", status: "200" }],
    ]);
    const after = new Map([
      ["1", { id: "1", status: "200", header: "Huber GmbH" }],
      ["3", { id: "3", status: "100" }],
    ]);
    expect(snapshotChanges(before, after)).toBe(
      "1 of 2 changed: 1: header, status 100 → 200, 1 new, 1 gone",
    );
  });

  it("keeps only the signature of a binary body in the evidence", async () => {
    const zip = makeZip(["Rechnung_RE-1042_Huber.pdf"]);
    const client = new ScriptedClient(() => new RawAnswer(zip, "application/zip"));
    const evidence: Exchange[] = [];
    const http = createProbeHttp(client, createScrubber({ secrets: [TOKEN] }), evidence);
    const result = await http.get("/Export/invoiceZip", { download: "true" });
    expect(evidence[0]?.body).toBe(`binary, starts with "PK"… (${zip.length} bytes, not JSON)`);
    expect(JSON.stringify(evidence)).not.toMatch(/Huber|1042/);
    expect(result.bytes).toEqual(zip);
  });
});
