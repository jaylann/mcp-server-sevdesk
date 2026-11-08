import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AnyWriteToolDefinition, isWriteTool } from "../../src/tools/types.js";
import { VOUCHER_WRITE_TOOLS } from "../../src/tools/vouchers/write-tools.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import { accountRoute, accountRow } from "../unit/tools/lifecycle/helpers.js";
import {
  CREATE_READ_ROUTES,
  draftRow,
  openVoucherRow,
  positionRow,
  positionsRoute,
  readBackRoutes,
  receiptFolder,
  saveRoute,
  uploadRoute,
  voucherRoute,
  writeRoute,
} from "../unit/tools/vouchers/routes.js";

/** A KoSIT XRechnung sample (Apache-2.0): 314.86 EUR net at 7 %, gross 336.90 EUR. */
const KOSIT_SAMPLE = fileURLToPath(
  new URL("../fixtures/einvoice/kosit/01.01a-INVOICE_uncefact.xml", import.meta.url),
);

/** A shipped voucher write tool by name (fails loudly when it is missing). */
function tool(name: string): AnyWriteToolDefinition {
  const found = VOUCHER_WRITE_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined || !isWriteTool(found)) throw new Error(`no write tool ${name}`);
  return found;
}

const createArgs = {
  supplierId: 1001,
  number: "ER-2026-0815",
  date: "2026-11-02",
  positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
};

/** The stored draft 2101 and what an update or finalize reads besides it. */
const draftRoutes = [
  voucherRoute(draftRow()),
  positionsRoute(2101, [positionRow()]),
  ...CREATE_READ_ROUTES,
  saveRoute(),
];

/** Open expense voucher 2001 (gross 298.10, nothing paid, not enshrined). */
const openVoucher = openVoucherRow({ enshrined: null });

/** Known-good cases of the M4 vouchers write tools (owned by the agent that ships the tools). */
export const VOUCHERS_CASES: readonly WriteToolCase[] = [
  {
    label: "create a draft voucher",
    tool: tool("sevdesk_voucher_create_draft"),
    args: createArgs,
    routes: [...CREATE_READ_ROUTES, saveRoute(), ...readBackRoutes()],
    writes: [{ method: "POST", path: "/Voucher/Factory/saveVoucher" }],
  },
  {
    label: "create a draft voucher with its receipt file",
    tool: tool("sevdesk_voucher_create_draft"),
    args: { ...createArgs, file: "Rechnung-0815.pdf" },
    routes: [...CREATE_READ_ROUTES, uploadRoute, saveRoute(), ...readBackRoutes()],
    writes: [
      { method: "POST", path: "/Voucher/Factory/uploadTempFile" },
      { method: "POST", path: "/Voucher/Factory/saveVoucher" },
    ],
    setup: async () => {
      const folder = await receiptFolder();
      return { config: { fileDirs: [folder.dir] }, undo: folder.undo };
    },
  },
  {
    label: "import an XRechnung as a draft voucher",
    tool: tool("sevdesk_voucher_import_einvoice"),
    args: { file: "xrechnung.xml", accountDatevId: 4266 },
    routes: [
      ...CREATE_READ_ROUTES,
      { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
      uploadRoute,
      saveRoute(),
      ...readBackRoutes(),
    ],
    writes: [
      { method: "POST", path: "/Voucher/Factory/uploadTempFile" },
      { method: "POST", path: "/Voucher/Factory/saveVoucher" },
    ],
    setup: async () => {
      const dir = await mkdtemp(join(tmpdir(), "sevdesk-einvoice-"));
      await copyFile(KOSIT_SAMPLE, join(dir, "xrechnung.xml"));
      return {
        config: { fileDirs: [dir] },
        undo: () => rm(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    label: "update a draft voucher",
    tool: tool("sevdesk_voucher_update_draft"),
    args: { id: 2101, number: "ER-2026-0816" },
    routes: draftRoutes,
    writes: [{ method: "POST", path: "/Voucher/Factory/saveVoucher" }],
  },
  {
    label: "delete a draft voucher",
    tool: tool("sevdesk_voucher_delete_draft"),
    args: { id: 2101 },
    routes: [
      voucherRoute(draftRow()),
      writeRoute("DELETE", "/Voucher/2101", "voucher-delete.json"),
    ],
    writes: [{ method: "DELETE", path: "/Voucher/2101" }],
  },
  {
    label: "finalize a draft voucher",
    tool: tool("sevdesk_voucher_finalize"),
    args: { id: 2101 },
    routes: draftRoutes,
    writes: [{ method: "POST", path: "/Voucher/Factory/saveVoucher" }],
  },
  {
    label: "book the payment of an expense voucher",
    tool: tool("sevdesk_voucher_book_payment"),
    args: { id: 2001, amount: "298.10", date: "2026-11-02", checkAccountId: 4001 },
    routes: [
      voucherRoute(openVoucher),
      accountRoute(accountRow(4001)),
      writeRoute("PUT", "/Voucher/2001/bookAmount", "voucher-book-amount.json"),
    ],
    writes: [{ method: "PUT", path: "/Voucher/2001/bookAmount" }],
  },
  {
    label: "reset an open voucher to draft",
    tool: tool("sevdesk_voucher_reset"),
    args: { id: 2001, to: "draft" },
    routes: [
      voucherRoute(openVoucher),
      writeRoute("PUT", "/Voucher/2001/resetToDraft", "voucher-reset.json"),
    ],
    writes: [{ method: "PUT", path: "/Voucher/2001/resetToDraft" }],
  },
  {
    label: "enshrine an open voucher",
    tool: tool("sevdesk_voucher_enshrine"),
    args: { id: 2001 },
    routes: [
      voucherRoute(openVoucher),
      writeRoute("PUT", "/Voucher/2001/enshrine", "voucher-delete.json"),
    ],
    writes: [{ method: "PUT", path: "/Voucher/2001/enshrine" }],
  },
];
