/**
 * Fake-client routes and rows for the voucher write tools (shared by their unit tests, the
 * regression tests and the write cases). Fixture provenance is in each file under
 * `test/fixtures/`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import type { HttpMethod } from "../../../../src/sevdesk/types.js";
import { type FakeRoute, loadFixture } from "../../../helpers/fake-client.js";

export type Row = Record<string, unknown>;

function firstRow(path: string): Row {
  const objects = (loadFixture(path).body as { objects: unknown }).objects;
  const [row] = (Array.isArray(objects) ? objects : [objects]) as Row[];
  if (row === undefined) throw new Error(`no row in ${path}`);
  return structuredClone(row);
}

/**
 * Draft expense voucher 2101 (status 50): supplier contact 1001, Belegnummer ER-2026-0815, tax
 * rule 9, 119.00 gross at 19 % on account 4266 (6815 Bürobedarf), `document: null`.
 */
export function draftRow(overrides: Row = {}): Row {
  return { ...firstRow("vouchers/voucher-2101-draft.json"), ...overrides };
}

/** The position 3101 of draft voucher 2101 (gross 119 at 19 % on account 4266). */
export function positionRow(overrides: Row = {}): Row {
  return { ...firstRow("vouchers/voucher-positions-2101.json"), ...overrides };
}

/**
 * Voucher 2001 (community recording key set): open (100), expense (C), EUR, gross 298.10, nothing
 * paid, enshrined; with `overrides`.
 */
export function openVoucherRow(overrides: Row = {}): Row {
  return { ...firstRow("vouchers/voucher-2001.json"), ...overrides };
}

export const version2Route: FakeRoute = {
  path: "/Tools/bookkeepingSystemVersion",
  response: { fixture: "meta/bookkeeping-system-version.json" },
};

export const version1Route: FakeRoute = {
  path: "/Tools/bookkeepingSystemVersion",
  response: { fixture: "meta/bookkeeping-system-version-1.json" },
};

/** `GET /SevClient`: regular VAT. */
export const regularRoute: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client.json" },
};

/** `GET /SevClient`: Kleinunternehmer (§19 UStG). */
export const smallBusinessRoute: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client-small-business.json" },
};

/** The recorded ReceiptGuidance (652 accounts, SKR04). */
export const guidanceRoute: FakeRoute = {
  path: "/ReceiptGuidance/forAllAccounts",
  response: { fixture: "recorded/2026-11-07/meta/receipt-guidance-all.json" },
};

/** The recorded AccountDatev page (100 accounts; answered the same for every offset). */
export const accountsRoute: FakeRoute = {
  path: "/AccountDatev",
  response: { fixture: "recorded/2026-11-07/meta/account-datev.json" },
};

/** Contact 1001, Musterfirma GmbH. */
export const contactRoute: FakeRoute = {
  path: "/Contact/1001",
  response: { fixture: "contacts/contact-1001.json" },
};

/** `GET /Voucher` (duplicate scan) answering `rows`. */
export function voucherListRoute(rows: readonly Row[] = []): FakeRoute {
  return { path: "/Voucher", response: { body: { objects: rows } } };
}

/** `GET /Voucher/{id}` answering `row`. */
export function voucherRoute(row: Row): FakeRoute {
  return { path: `/Voucher/${String(row["id"])}`, response: { body: { objects: [row] } } };
}

/** `GET /Voucher/{id}` answering 404. */
export function missingVoucherRoute(id: number): FakeRoute {
  return {
    path: `/Voucher/${String(id)}`,
    response: {
      error: new SevdeskError({ kind: "not_found", message: "Not found.", status: 404 }),
    },
  };
}

/** `GET /VoucherPos?voucher[id]=…` answering `rows`. */
export function positionsRoute(voucherId: number, rows: readonly Row[]): FakeRoute {
  return {
    path: "/VoucherPos",
    query: { "voucher[id]": voucherId },
    response: { body: { objects: rows, total: rows.length } },
  };
}

/** `POST /Voucher/Factory/saveVoucher` answering voucher 2101 (or `id`). */
export function saveRoute(id = 2101): FakeRoute {
  const body = structuredClone(loadFixture("vouchers/save-voucher-response.json").body) as {
    objects: { voucher: Row };
  };
  body.objects.voucher["id"] = String(id);
  return { method: "POST", path: "/Voucher/Factory/saveVoucher", response: { body } };
}

export const uploadRoute: FakeRoute = {
  method: "POST",
  path: "/Voucher/Factory/uploadTempFile",
  response: { fixture: "vouchers/upload-temp-file.json" },
};

/** A data-changing route answering a fixture of `test/fixtures/vouchers/`. */
export function writeRoute(method: HttpMethod, path: string, fixture: string): FakeRoute {
  return { method, path, response: { fixture: `vouchers/${fixture}` } };
}

/** Everything a create of the expense draft needs before the save (regular VAT, no duplicates). */
export const CREATE_READ_ROUTES: readonly FakeRoute[] = [
  version2Route,
  regularRoute,
  guidanceRoute,
  accountsRoute,
  contactRoute,
  voucherListRoute(),
];

/** The read-back of voucher 2101 after a save. */
export function readBackRoutes(row: Row = draftRow(), positions = [positionRow()]): FakeRoute[] {
  return [voucherRoute(row), positionsRoute(Number(row["id"]), positions)];
}

/** A tiny valid-looking PDF. */
export const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);

/** A temp folder with `Rechnung-0815.pdf`, for `SEVDESK_FILE_DIRS`; `undo` removes it. */
export async function receiptFolder(): Promise<{
  readonly dir: string;
  readonly file: string;
  readonly undo: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "sevdesk-vouchers-"));
  const file = join(dir, "Rechnung-0815.pdf");
  await writeFile(file, PDF_BYTES);
  return { dir, file, undo: () => rm(dir, { recursive: true, force: true }) };
}
