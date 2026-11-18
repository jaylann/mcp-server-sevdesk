/**
 * Payment account changes that sevDesk answers with 200 whatever happened (spec/deviations.md
 * D-141, D-142).
 *
 * - D-141: `PUT /CheckAccount/{id}` answers 200 also for keys it ignores (the spec's plural
 *   `autoMapTransactions`, `type`, `status`). Guard: `sevdesk_bank_account_update` sends only the
 *   keys sevDesk stores (`autoMapTransaction` singular), never `type`, `status` or
 *   `defaultAccount`, and reads every field back.
 * - D-142: `DELETE /CheckAccount/{id}` of an account with a booked transaction is refused, but with
 *   HTTP 200 and `{objects: null, error: {code: 159, message: "Cannot delete because of existing
 *   necessary references"}}`; nothing changes. Read as a success, the tool would report an account
 *   as archived that is still active; shown raw, sevDesk's text would reach the model unfenced.
 *   Guard: the client raises it as `unexpected_response` (status 200), and
 *   `sevdesk_bank_account_archive` turns it into a refusal in its own words. The DELETE is sent
 *   exactly once. This part runs through the real HTTP client with a scripted `fetch`.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { bankAccountArchiveTool } from "../../src/tools/banking/account-archive.js";
import { bankAccountUpdateTool } from "../../src/tools/banking/account-update.js";
import { describeSevdeskError } from "../../src/tools/tool-errors.js";
import { testConfig } from "../helpers/config.js";
import { loadFixture } from "../helpers/fake-client.js";
import { createFakeClock, createFakeFetch, envelope, jsonResponse } from "../helpers/fake-fetch.js";
import { executeWrite } from "../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  listRoute,
  StagedClient,
} from "../unit/domain/reconciliation/helpers.js";

const ACCOUNTS = (loadFixture("banking/check-accounts.json").body as { objects: unknown[] })
  .objects;
const ACTIVE_IMPORT = { ...accountRow(4004), status: "100", name: "Import-Konto" };

describe("D-141: PUT /CheckAccount answers 200 for keys it ignores", () => {
  it("sends only the keys sevDesk stores, the singular autoMapTransaction included", async () => {
    const after = {
      ...ACTIVE_IMPORT,
      name: "Neu",
      accountingNumber: "1809",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      autoMapTransaction: "0",
    };
    const client = new StagedClient(
      [accountRoute(ACTIVE_IMPORT), accountsListRoute(), listRoute("/CheckAccountTransaction", [])],
      [
        { method: "PUT", path: "/CheckAccount/4004", response: { body: { objects: after } } },
        accountRoute(after),
      ],
    );
    await executeWrite(
      bankAccountUpdateTool,
      {
        id: 4004,
        name: "Neu",
        accountingNumber: 1809,
        iban: "DE89370400440532013000",
        bic: "COBADEFFXXX",
        autoMapTransactions: false,
      },
      client,
    );
    const [put] = client.writes();
    expect(Object.keys(put?.body as object).sort()).toEqual([
      "accountingNumber",
      "autoMapTransaction",
      "bic",
      "iban",
      "name",
    ]);
  });
});

describe("D-142: a refused account archive arrives as HTTP 200", () => {
  it("is a refusal in our words, not an archive, and the DELETE is sent once", async () => {
    const refusal = {
      objects: null,
      error: {
        exceptionUUID: "4f1c2d3e-0000-4000-8000-000000000142",
        message: "Cannot delete because of existing necessary references",
        errorCode: 0,
        code: 159,
        data: { total: 1, objects: [], objectToDelete: null },
        responseCode: 200,
      },
    };
    const answer = (request: { readonly url: URL; readonly method: string }): Response => {
      const path = request.url.pathname.replace(/^\/api\/v1/, "");
      if (request.method === "DELETE" && path === "/CheckAccount/4004") {
        return jsonResponse(refusal, 200);
      }
      if (request.method === "GET" && path === "/CheckAccount/4004")
        return envelope([ACTIVE_IMPORT]);
      if (request.method === "GET" && path === "/CheckAccount") return envelope(ACCOUNTS, "5");
      // The booking happened after the check: the list read before showed none.
      if (request.method === "GET" && path === "/CheckAccountTransaction") return envelope([], "0");
      throw new Error(`unexpected request: ${request.method} ${path}`);
    };
    const fake = createFakeFetch(...Array.from({ length: 10 }, () => answer));
    const clock = createFakeClock();
    const client = createSevdeskClient(
      {
        token: "0123456789abcdef0123456789abcdef",
        baseUrl: "https://my.sevdesk.de/api/v1",
        allowedTiers: new Set<Tier>(["read", "write", "commit"]),
        readOnly: false,
        dryRun: false,
        requestsPerSecond: 1000,
        timeoutMs: 1000,
        userAgent: "test",
      },
      {
        fetch: fake.fetch,
        sleep: clock.sleep,
        now: clock.now,
        monotonicNow: clock.now,
        random: () => 0.5,
      },
    );

    const error = await executeWrite(bankAccountArchiveTool, { id: 4004 }, client).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({ kind: "validation", status: 200, completedWrites: [] });
    const text = describeSevdeskError(error as SevdeskError, {
      toolName: bankAccountArchiveTool.name,
      tier: bankAccountArchiveTool.tier,
      config: testConfig(),
    });
    expect(text).toMatch(/sevDesk refused to archive payment account 4004/);
    expect(text).not.toMatch(/necessary references/i);

    const deletes = fake.requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => request.url.pathname)).toEqual(["/api/v1/CheckAccount/4004"]);
  });
});
