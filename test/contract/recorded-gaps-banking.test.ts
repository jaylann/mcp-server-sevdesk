/**
 * Contract tests over the fixtures the gap probes' session (2026-11-16, issues #88, #92, #95, #96)
 * recorded on the trial account with `pnpm fixtures:record`: each file goes through the production
 * reader that handles it in the server.
 *
 * Kept: `banking/check-accounts.json`, a page of 5 of 7 active accounts (file-import accounts,
 * the offline account). Not kept: `banking/private-transaction-rules.json`, an empty list (the
 * probe deletes its rules), which shows no row shape; the rule's shape is in the probe report and
 * spec/deviations.md D-099.
 *
 * The session folder is shared with the other gap probes, so this file checks only its own files
 * ({@link RECORDED_GAPS_BANKING}); a session-level check covers the folder as a whole.
 */
import { describe, expect, it } from "vitest";

import { bankAccountDtoSchema, listBankAccounts } from "../../src/domain/banking.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";

const SESSION = "2026-11-16";
const DIR = `recorded/${SESSION}`;

/** The files of this slice (paths below the session folder) and the reader each is checked with. */
const RECORDED_GAPS_BANKING: Readonly<Record<string, string>> = {
  "banking/check-accounts.json": "listBankAccounts",
};

function fixture(file: string): string {
  return `${DIR}/${file}`;
}

interface AccountRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly importType: string | null;
}

function accountRows(): readonly AccountRow[] {
  return (loadFixture(fixture("banking/check-accounts.json")).body as { objects: AccountRow[] })
    .objects;
}

describe(`recorded fixtures ${SESSION} (gap probes, banking): provenance`, () => {
  it.each(Object.keys(RECORDED_GAPS_BANKING))(
    "%s says it was recorded on the trial account",
    (file) => {
      const { _provenance: provenance, status } = loadFixture(fixture(file));
      expect(provenance.source).toBe("recorded");
      expect(provenance.date).toBe(SESSION);
      expect(provenance.systemVersion).toBe("2.0");
      expect(provenance.ref).toMatch(/^GET \//);
      expect(provenance.ref).toContain(`recording session ${SESSION}`);
      expect(status).toBe(200);
    },
  );
});

describe(`recorded ${SESSION}: check accounts (D-097)`, () => {
  const routes = (): FakeRoute[] => [
    { path: "/CheckAccount", response: { fixture: fixture("banking/check-accounts.json") } },
    ...accountRows().map((row) => ({
      path: `/CheckAccount/${row.id}/getBalanceAtDate`,
      response: { body: { objects: "0" } },
    })),
  ];

  it("lists the recorded page: valid DTOs, file-import accounts as bank, offline as clearing", async () => {
    const result = await listBankAccounts(new FakeSevdeskClient(routes()), {
      asOf: SESSION,
      includeArchived: false,
    });
    expect(result.items.map((account) => String(account.id))).toEqual(
      accountRows().map((row) => row.id),
    );
    for (const account of result.items) {
      expect(bankAccountDtoSchema.safeParse(account).success, String(account.id)).toBe(true);
    }
    // File-import accounts are type online with an importType; nothing tells them from a real
    // bank connection except importType and bankServer (D-097).
    const imports = accountRows().filter((row) => row.type === "online");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((row) => row.importType === "CSV")).toBe(true);
    expect(result.items.filter((account) => account.type === "bank")).toHaveLength(imports.length);
    expect(result.items.filter((account) => account.type === "clearing")).toHaveLength(1);
    // A recorded page of 5 rows of a total of 7: the list says it is incomplete.
    expect(result.complete).toBe(false);
  });

  it("holds only active accounts: GET /CheckAccount leaves archived ones out (D-097)", async () => {
    expect(accountRows().every((row) => row.status === "100")).toBe(true);
    const result = await listBankAccounts(new FakeSevdeskClient(routes()), {
      asOf: SESSION,
      includeArchived: true,
    });
    expect(result.archivedHidden).toBe(0);
  });
});
