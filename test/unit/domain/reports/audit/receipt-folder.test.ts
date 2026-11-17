/**
 * The receipt folder check's matching (`runReceiptFolderCheck`): a scanned folder (built here, the
 * scan itself is tested in `test/unit/safety/local-folder.test.ts`) against the vouchers of
 * 2026-Q1 as `GET /Voucher?embed=document` lists them (the recorded `GET /Document` row as the
 * embedded document, D-100 PR #104), with a known case per finding and the matches.
 */
import { describe, expect, it } from "vitest";

import { AUDIT_CAVEAT, AUDIT_CAVEAT_DE } from "../../../../../src/domain/reports/audit/findings.js";
import {
  MATCHING,
  MATCHING_DE,
  RECEIPT_FOLDER_FINDING_CODES,
  RECEIPT_MARGIN_DAYS,
  type ReceiptFolderResult,
  receiptFolderResultSchema,
  receiptFolderSentence,
  runReceiptFolderCheck,
} from "../../../../../src/domain/reports/audit/receipt-folder.js";
import { shiftDays } from "../../../../../src/domain/reports/shared.js";
import { resolvePeriod } from "../../../../../src/domain/reports/vat.js";
import type { FolderFile, FolderScan } from "../../../../../src/safety/local-folder.js";
import { FakeSevdeskClient, loadFixture } from "../../../../helpers/fake-client.js";
import { type ScenarioDocument, scenarioRoutes, voucherDoc } from "../builders.js";

type Raw = Record<string, unknown>;

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-04-20";
const FOLDER = "/home/user/Belege/2026-Q1";

const hash = (letter: string): string => letter.repeat(64);
const H = {
  booked: hash("1"),
  draft: hash("2"),
  twice: hash("3"),
  repeats: hash("4"),
  missing: hash("5"),
  old: hash("6"),
  outside: hash("7"),
};

const DOCUMENT_TEMPLATE = (() => {
  const body = loadFixture("recorded/2026-11-10/advanced/documents.json").body as {
    objects: Raw[];
  };
  const row = body.objects[0];
  if (row === undefined) throw new Error("document fixture is empty");
  return row;
})();

/**
 * A voucher row as the list sends it with `embed=document`: `null` hash for a receipt sevDesk
 * stores without a checksum (one its recognition created, as recorded 2026-11-17). `file` sets
 * the document's `filesize` and `extension`; otherwise they are the recorded row's (whose scrubbed
 * extension is no extension).
 */
function voucher(spec: {
  readonly id: number;
  readonly date: string;
  readonly hash?: string | null;
  readonly draft?: boolean;
  readonly number?: string;
  readonly contactId?: number;
  readonly file?: { readonly size: string; readonly extension: string };
}): ScenarioDocument {
  const document =
    spec.hash === undefined
      ? null
      : {
          ...structuredClone(DOCUMENT_TEMPLATE),
          id: String(8000 + spec.id),
          object: null,
          baseObject: null,
          status: "50",
          contentHash: spec.hash,
          ...(spec.file === undefined
            ? {}
            : { filesize: spec.file.size, extension: spec.file.extension, mimeType: null }),
        };
  return {
    row: voucherDoc(
      {
        id: spec.id,
        date: spec.date,
        net: "100",
        tax: "19",
        status: spec.draft === true ? "50" : "100",
        contactId: spec.contactId ?? 3001,
      },
      { document, description: spec.number ?? `B-${String(spec.id)}` },
    ),
    positions: [],
  };
}

const VOUCHERS: readonly ScenarioDocument[] = [
  voucher({ id: 901, date: "2026-02-10", hash: H.booked }),
  voucher({ id: 902, date: "2026-03-01", hash: H.draft, draft: true }),
  voucher({ id: 903, date: "2026-01-05", hash: H.twice, contactId: 3003 }),
  voucher({ id: 904, date: "2026-01-20", hash: H.twice.toUpperCase(), contactId: 3003 }),
  voucher({ id: 905, date: "2026-02-02", hash: H.repeats }),
  voucher({ id: 906, date: "2026-02-03", hash: H.repeats, draft: true }),
  // A file sevDesk rendered itself: no checksum.
  voucher({ id: 907, date: "2026-02-20", hash: null }),
  // No receipt, but its number appears in a file name.
  voucher({ id: 909, date: "2026-03-15", number: "INV-777777" }),
  // A short number that also appears in that file name: too short for a hint.
  voucher({ id: 910, date: "2026-03-16", number: "77" }),
  // Outside the range read (more than 62 days before the period): never compared.
  voucher({ id: 911, date: "2025-09-01", hash: H.outside }),
];

/** Milliseconds of noon UTC on a day. */
const at = (date: string): number => Date.parse(`${date}T12:00:00Z`);

function file(
  name: string,
  sha256: string,
  modified = "2026-04-01",
  extra: Partial<FolderFile> = {},
): FolderFile {
  return {
    path: `${FOLDER}/${name}`,
    kind: "pdf",
    size: 1234,
    modifiedMs: at(modified),
    sha256,
    ...extra,
  };
}

const FILES: readonly FolderFile[] = [
  file("a-booked.pdf", H.booked),
  file("b-draft.pdf", H.draft),
  file("c-twice.pdf", H.twice),
  file("d-repeats.pdf", H.repeats),
  file("e-Rechnung INV-777777.pdf", H.missing, "2026-02-15"),
  file("f-old.pdf", H.old, "2025-06-01"),
  file("g-outside.pdf", H.outside, "2025-09-02"),
  // The same bytes as a-booked.pdf, saved twice.
  file("h-copy-of-booked.pdf", H.booked),
];

function scanOf(files: readonly FolderFile[], extra: Partial<FolderScan> = {}): FolderScan {
  return {
    folders: [FOLDER],
    files,
    skipped: {
      hidden: 1,
      link: 0,
      special: 0,
      unusable_name: 0,
      other_type: 2,
      wrong_content: 0,
      too_large: 0,
      unreadable: 0,
      changed: 0,
    },
    notChecked: [],
    foldersRead: 1,
    subfoldersNotRead: 0,
    cut: [],
    ...extra,
  };
}

async function check(
  client: FakeSevdeskClient,
  folder: FolderScan = scanOf(FILES),
  extra: { readonly maxRows?: number; readonly subfolders?: boolean } = {},
): Promise<ReceiptFolderResult> {
  return runReceiptFolderCheck(client, {
    period: Q1,
    folder,
    subfolders: extra.subfolders ?? false,
    maxRows: extra.maxRows,
    today: TODAY,
  });
}

function routes(): ReturnType<typeof scenarioRoutes> {
  return scenarioRoutes({ vouchers: VOUCHERS });
}

/** File names of a finding by code. */
function filesOf(result: ReceiptFolderResult, code: string): string[][] {
  return result.findings
    .filter((finding) => finding.code === code)
    .map((finding) => finding.files.map((entry) => entry.path.slice(FOLDER.length + 1)));
}

describe("receipt folder check", () => {
  it("sorts every file into a finding or a match", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await check(client);

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "receipt_file_booked_twice",
      "receipt_file_not_booked",
      "receipt_file_before_period",
      "receipt_file_only_on_draft",
      "receipt_file_draft_repeats",
    ]);
    expect(filesOf(result, "receipt_file_booked_twice")).toEqual([["c-twice.pdf"]]);
    expect(filesOf(result, "receipt_file_not_booked")).toEqual([["e-Rechnung INV-777777.pdf"]]);
    // g-outside.pdf: its voucher lies outside the range read, and the file is older than it.
    expect(filesOf(result, "receipt_file_before_period")).toEqual([["f-old.pdf", "g-outside.pdf"]]);
    expect(filesOf(result, "receipt_file_only_on_draft")).toEqual([["b-draft.pdf"]]);
    expect(filesOf(result, "receipt_file_draft_repeats")).toEqual([["d-repeats.pdf"]]);
    expect(receiptFolderResultSchema.parse(result)).toEqual(result);
    expect(client.writes()).toEqual([]);
  });

  it("names the vouchers of each finding with their links, warnings first", async () => {
    const result = await check(new FakeSevdeskClient(routes()));
    const [twice] = result.findings;

    expect(twice).toMatchObject({
      check: "receipt_folder",
      severity: "warning",
      documents: 2,
      records: [
        { objectName: "Voucher", id: 903, link: "https://my.sevdesk.de/ex/detail/id/903" },
        { objectName: "Voucher", id: 904 },
      ],
      contact: { id: 3003, link: "https://my.sevdesk.de/crm/detail/id/3003" },
      files: [{ path: `${FOLDER}/c-twice.pdf`, kind: "pdf", bytes: 1234, sha256: H.twice }],
    });
    const notBooked = result.findings.find((entry) => entry.code === "receipt_file_not_booked");
    expect(notBooked).toMatchObject({ severity: "check", documents: 0, records: [] });
    // Voucher 907's receipt has no checksum, so the file is not presented as unbooked.
    expect(notBooked?.titleDe).toBe("Kein Beleg in sevDesk mit dieser Prüfsumme");
  });

  it("lists every matched file with its vouchers and their status", async () => {
    const result = await check(new FakeSevdeskClient(routes()));
    const byPath = new Map(
      result.matched.map((entry) => [entry.path.slice(FOLDER.length + 1), entry.vouchers]),
    );

    const statuses = (path: string): [number, number][] | undefined =>
      byPath.get(path)?.map((entry) => [entry.id, entry.status.code]);
    expect(statuses("a-booked.pdf")).toEqual([[901, 100]]);
    expect(byPath.get("h-copy-of-booked.pdf")?.map((entry) => entry.id)).toEqual([901]);
    // A draft (status 50) is visible as such.
    expect(statuses("b-draft.pdf")).toEqual([[902, 50]]);
    expect(byPath.get("d-repeats.pdf")?.map((entry) => entry.id)).toEqual([905, 906]);
    expect([...byPath.keys()].sort()).toEqual([
      "a-booked.pdf",
      "b-draft.pdf",
      "c-twice.pdf",
      "d-repeats.pdf",
      "h-copy-of-booked.pdf",
    ]);
    expect(result.coverage).toMatchObject({
      filesChecked: 8,
      filesMatched: 5,
      filesNotMatched: 3,
    });
  });

  it("gives a voucher number in the file name as a weak hint, not a match", async () => {
    const result = await check(new FakeSevdeskClient(routes()));
    const notBooked = result.findings.find((entry) => entry.code === "receipt_file_not_booked");

    expect(notBooked?.files[0]).toMatchObject({
      modified: "2026-02-15",
      possibleVouchers: [{ id: 909, number: "INV-777777", date: "2026-03-15" }],
    });
    expect(notBooked?.files[0]?.possibleVouchers).toHaveLength(1);
  });

  it("reads the vouchers of the period and its margin once, with the documents embedded", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await check(client);
    const lists = client.calls.filter((call) => call.path === "/Voucher");

    expect(lists).toHaveLength(1);
    expect(lists[0]?.query).toMatchObject({ embed: "document", voucherType: "VOU", limit: 1000 });
    expect(client.calls.every((call) => call.path === "/Voucher" && call.method === "GET")).toBe(
      true,
    );
    expect(result.coverage.vouchers).toEqual({
      from: shiftDays(Q1.from, -RECEIPT_MARGIN_DAYS),
      to: shiftDays(Q1.to, RECEIPT_MARGIN_DAYS),
      read: VOUCHERS.length,
      withReceipt: 7,
      withoutChecksum: 1,
      truncated: false,
    });
    const notes = result.notes.join(" ");
    expect(notes).toContain(
      `Vouchers dated ${result.coverage.vouchers.from} to ${result.coverage.vouchers.to} were ` +
        "compared",
    );
    expect(notes).toContain(
      "1 receipt attached to vouchers in the range read has no checksum in sevDesk",
    );
  });

  it("counts the receipts without a checksum and words the unmatched file accordingly", async () => {
    const result = await check(new FakeSevdeskClient(routes()));
    const notBooked = result.findings.find((entry) => entry.code === "receipt_file_not_booked");

    expect(result.withoutChecksum).toMatchObject({ receipts: 1 });
    expect(result.withoutChecksum?.note).toContain("could not be compared");
    expect(result.withoutChecksum?.noteDe).toContain(
      "1 Belegdatei an einem Beleg im gelesenen Zeitraum hat in sevDesk keine Prüfsumme",
    );
    expect(result.withoutChecksum?.noteDe).toContain("konnte nicht verglichen werden");
    expect(notBooked?.title).toBe("No receipt in sevDesk with this checksum");
    expect(notBooked?.reason).toContain(
      "1 receipt attached to vouchers in that range carries no checksum on sevDesk's side",
    );
    expect(notBooked?.reason).not.toContain("probably not booked");
  });

  it("keeps the plain wording when every receipt in the range has a checksum", async () => {
    const hashed = VOUCHERS.filter((doc) => doc.row["id"] !== "907");
    const result = await check(new FakeSevdeskClient(scenarioRoutes({ vouchers: hashed })));
    const notBooked = result.findings.find((entry) => entry.code === "receipt_file_not_booked");

    expect(result.withoutChecksum).toBeUndefined();
    expect(result.coverage.vouchers.withoutChecksum).toBe(0);
    expect(notBooked?.titleDe).toBe("Belegdatei nicht in sevDesk gefunden");
    expect(notBooked?.reason).toContain("so this file was probably not booked");
    expect(receiptFolderSentence(result)).not.toContain("checksum");
  });

  it("names a receipt without a checksum of the same size and extension as a hint, never a match", async () => {
    const recognized = (id: number, size: string, extension: string): ScenarioDocument =>
      voucher({ id, date: "2026-03-02", hash: null, file: { size, extension } });
    const vouchers = [
      recognized(931, "1435", "pdf"),
      recognized(932, "1435", "png"),
      recognized(933, "999", "pdf"),
      recognized(934, "70", "jpg"),
      // A plain reference (no embedded document) knows no size: no hint.
      {
        row: voucherDoc(
          { id: 935, date: "2026-03-03", net: "100", tax: "19", contactId: 3001 },
          { document: { id: "8935", objectName: "Document" } },
        ),
        positions: [],
      },
    ];
    const files = [
      file("scan.pdf", H.missing, "2026-03-05", { size: 1435 }),
      file("photo.jpeg", H.old, "2026-03-05", { size: 70, kind: "jpeg" }),
      file("other.pdf", H.outside, "2026-03-05", { size: 5 }),
    ];
    const result = await check(new FakeSevdeskClient(scenarioRoutes({ vouchers })), scanOf(files));
    const notBooked = result.findings.find((entry) => entry.code === "receipt_file_not_booked");
    const hints = new Map(
      notBooked?.files.map((entry) => [
        entry.path.slice(FOLDER.length + 1),
        entry.sameSizeVouchers?.map((hint) => hint.id),
      ]),
    );

    expect(hints.get("scan.pdf")).toEqual([931]);
    expect(hints.get("photo.jpeg")).toEqual([934]);
    expect(hints.get("other.pdf")).toBeUndefined();
    // Never upgraded to a match.
    expect(result.matched).toEqual([]);
    expect(result.coverage).toMatchObject({ filesMatched: 0, filesNotMatched: 3 });
    expect(result.coverage.vouchers.withoutChecksum).toBe(5);
    expect(result.withoutChecksum?.receipts).toBe(5);
    expect(receiptFolderResultSchema.parse(result)).toEqual(result);
  });

  it("says plainly what a match and a missing match prove, in English and German", async () => {
    const result = await check(new FakeSevdeskClient(routes()));

    expect(result.matching).toBe(MATCHING);
    expect(result.matchingDe).toBe(MATCHING_DE);
    expect(MATCHING).toContain("No match does not prove that the receipt is missing");
    expect(MATCHING).toContain("a scan or photo of the paper");
    expect(MATCHING).toContain("Amounts, dates and suppliers are not compared");
    expect(MATCHING_DE).toContain("Kein Treffer beweist nicht, dass der Beleg fehlt");
    expect(MATCHING_DE).toContain("Beträge, Daten und Lieferanten werden nicht verglichen");
  });

  it("marks its findings as hints, not tax advice, in English and German", async () => {
    const result = await check(new FakeSevdeskClient(routes()));

    expect(result.caveat).toBe(AUDIT_CAVEAT);
    expect(result.caveatDe).toBe(AUDIT_CAVEAT_DE);
    expect(result.caveat).toContain("not tax advice");
    expect(result.caveatDe).toContain("keine Steuerberatung");
    // Also when the folder holds nothing to compare.
    const empty = await check(new FakeSevdeskClient(routes()), scanOf([]));
    expect(empty.caveat).toBe(AUDIT_CAVEAT);
    expect(empty.caveatDe).toBe(AUDIT_CAVEAT_DE);
  });

  it("keeps file paths out of the trusted text", async () => {
    const result = await check(new FakeSevdeskClient(routes()));
    const trusted = [
      receiptFolderSentence(result),
      ...result.notes,
      ...result.findings.flatMap((entry) => [entry.title, entry.reason, entry.action]),
    ].join("\n");

    expect(trusted).not.toContain(FOLDER);
    expect(trusted).not.toContain("INV-777777");
    expect(receiptFolderSentence(result)).toBe(
      "Receipt folder 2026-Q1: 8 files checked, 5 found on a voucher, 1 not found by checksum " +
        "(and 2 older than the vouchers read), 1 only on a draft, 1 booked more than once. " +
        "1 receipt in sevDesk has no checksum and could not be compared.",
    );
  });

  it("reads nothing from sevDesk when the folder holds no receipt file", async () => {
    const client = new FakeSevdeskClient(routes());
    const result = await check(client, scanOf([], { subfoldersNotRead: 2 }));

    expect(client.calls).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.notes.join(" ")).toContain(
      "The folder holds no receipt file this check can read",
    );
    expect(result.notes.join(" ")).toContain("pass subfolders: true");
  });

  it("says when the folder or the voucher listing was cut", async () => {
    const result = await check(
      new FakeSevdeskClient(routes()),
      scanOf(FILES.slice(0, 2), { cut: ["files", "time"] }),
      { maxRows: 3 },
    );
    const notes = result.notes.join(" ");

    expect(result.coverage.folderCut).toEqual(["files", "time"]);
    expect(notes).toContain("The folder was cut: the cap on files per call was reached");
    expect(notes).toContain("this server's time budget for one request ran out");
    expect(result.coverage.vouchers.truncated).toBe(true);
    expect(notes).toContain("The voucher listing stopped at its cap");
    expect(receiptFolderSentence(result)).toContain("The folder was cut");
  });

  it("counts the files of findings beyond the cap in the summary", async () => {
    // 120 files each booked twice (one warning per checksum) push the one unbooked file's
    // finding past the 100 listed.
    const twiceHashes = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(64, "a"));
    const vouchers = twiceHashes.flatMap((hashOf, i) => [
      voucher({ id: 2000 + 2 * i, date: "2026-02-01", hash: hashOf, number: `X${String(i)}` }),
      voucher({ id: 2001 + 2 * i, date: "2026-02-02", hash: hashOf, number: `Y${String(i)}` }),
    ]);
    const files = [
      ...twiceHashes.map((hashOf, i) => file(`twice-${String(i)}.pdf`, hashOf)),
      file("unbooked.pdf", H.missing),
    ];
    const result = await check(new FakeSevdeskClient(scenarioRoutes({ vouchers })), scanOf(files));

    expect(result.findings).toHaveLength(100);
    expect(result.findingsOmitted).toBe(21);
    expect(result.findings.some((entry) => entry.code === "receipt_file_not_booked")).toBe(false);
    expect(result.coverage.filesByFinding).toEqual({
      receipt_file_booked_twice: 120,
      receipt_file_not_booked: 1,
      receipt_file_before_period: 0,
      receipt_file_only_on_draft: 0,
      receipt_file_draft_repeats: 0,
    });
    expect(receiptFolderSentence(result)).toBe(
      "Receipt folder 2026-Q1: 121 files checked, 120 found on a voucher, 1 not found, 120 " +
        "booked more than once.",
    );
  });

  it("names each voucher's supplier when the vouchers of a file have different ones", async () => {
    const vouchers = [
      voucher({ id: 921, date: "2026-02-01", hash: H.twice, contactId: 3005 }),
      voucher({ id: 922, date: "2026-02-02", hash: H.twice, contactId: 3006 }),
    ];
    const result = await check(
      new FakeSevdeskClient(scenarioRoutes({ vouchers })),
      scanOf([file("twice.pdf", H.twice)]),
    );
    const [twice] = result.findings;

    expect(twice?.code).toBe("receipt_file_booked_twice");
    expect(twice?.contact).toBeUndefined();
    expect(twice?.records.map((record) => [record.id, record.contact?.id])).toEqual([
      [921, 3005],
      [922, 3006],
    ]);
  });

  it("documents its codes", () => {
    expect([...RECEIPT_FOLDER_FINDING_CODES].sort()).toEqual([
      "receipt_file_before_period",
      "receipt_file_booked_twice",
      "receipt_file_draft_repeats",
      "receipt_file_not_booked",
      "receipt_file_only_on_draft",
    ]);
  });
});
