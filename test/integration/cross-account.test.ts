/**
 * Two sevDesk accounts served by one server factory, as in OAuth mode (one process, one safety
 * runtime, an account resolver): they never share the domain caches (account settings, receipt
 * guidance, booking accounts, system version, country codes), browser approvals or elicitation
 * state, and one account's token never shows up in the other's results or in the audit log.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAccountResolver } from "../../src/accounts/resolver.js";
import type { Settings } from "../../src/config.js";
import { loadAccountSettings } from "../../src/domain/account-settings.js";
import { loadAccountsDatev } from "../../src/domain/accounts-datev.js";
import { loadCountryCodes } from "../../src/domain/country-codes.js";
import { loadReceiptGuidance } from "../../src/domain/receipt-guidance.js";
import type {
  ApprovalChannel,
  ApprovalStore,
  ApprovalView,
} from "../../src/safety/approval-types.js";
import { createSafetyRuntime, type SafetyRuntime } from "../../src/safety/runtime.js";
import { createServerFactory, type ServerFactory } from "../../src/server.js";
import { readOnlyClient } from "../../src/sevdesk/scoped-client.js";
import { getBookkeepingSystemVersion } from "../../src/sevdesk/system-version.js";
import { defineTool } from "../../src/tools/define-tool.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { allEnabledConfig } from "../helpers/config.js";
import { connectConfirming } from "../helpers/confirm-client.js";
import { connectFactory } from "../helpers/connect.js";
import { createDummyTools, dummyInvoiceBody, READ_ANNOTATIONS } from "../helpers/dummy-tools.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import {
  grantAuthInfo,
  httpDeployment,
  resultData,
  resultText,
  writesOf,
} from "../helpers/write-flow.js";

const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Account A, its first connection. */
const A1 = grantAuthInfo({ accountId: "1001", token: TOKEN_A, grantId: "grant-a1" });
/** Account A, a second connection (another grant, same token). */
const A2 = grantAuthInfo({ accountId: "1001", token: TOKEN_A, grantId: "grant-a2" });
/** Account B: another user of the same OAuth client (claude.ai). */
const B = grantAuthInfo({ accountId: "2002", token: TOKEN_B, grantId: "grant-b" });

interface AccountData {
  readonly smallSettlement: "0" | "1";
  readonly chart: string;
  readonly guideAccount: string;
  readonly datevNumber: string;
  readonly version: string;
  readonly countryCode: string;
}

const DATA: Readonly<Record<string, AccountData>> = {
  "1001": {
    smallSettlement: "0",
    chart: "skr03",
    guideAccount: "8400",
    datevNumber: "4400",
    version: "2.0",
    countryCode: "DE",
  },
  "2002": {
    smallSettlement: "1",
    chart: "skr04",
    guideAccount: "4300",
    datevNumber: "6815",
    version: "1.0",
    countryCode: "AT",
  },
};

function routesOf(data: AccountData): FakeRoute[] {
  return [
    {
      path: "/SevClient",
      response: {
        body: {
          objects: [
            { id: "1", smallSettlement: data.smallSettlement, chartOfAccounts: data.chart },
          ],
        },
      },
    },
    {
      path: "/ReceiptGuidance/forAllAccounts",
      response: {
        body: {
          objects: [
            {
              accountDatevId: "10",
              accountNumber: data.guideAccount,
              accountName: "Erlöse",
              allowedTaxRules: [],
              allowedReceiptTypes: ["REVENUE"],
            },
          ],
        },
      },
    },
    {
      path: "/AccountDatev",
      response: { body: { objects: [{ id: "20", number: data.datevNumber }] } },
    },
    {
      path: "/Tools/bookkeepingSystemVersion",
      response: { body: { objects: { version: data.version } } },
    },
    {
      path: "/StaticCountry",
      response: { body: { objects: [{ id: "1", code: data.countryCode }] } },
    },
    { path: "/Invoice/7", response: { body: dummyInvoiceBody() } },
    { method: "PUT", path: "/Invoice/7/sendBy", response: { body: { objects: { id: "7" } } } },
    { method: "POST", path: "/Contact", response: { body: { objects: { id: "1" } } } },
  ];
}

/** A read tool that reports what each per-account cache holds for the calling account. */
const probeTool = defineTool({
  name: "sevdesk_probe_caches",
  title: "Probe caches (test)",
  description: "Reads the cached account data. Test fixture for per-account caches.",
  toolset: "meta",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({}),
  output: z.object({
    smallBusiness: z.boolean().optional(),
    chart: z.string().optional(),
    guideAccount: z.string().optional(),
    datevNumber: z.string().optional(),
    version: z.string(),
    countryCode: z.string().optional(),
  }),
  handler: async (_args, ctx) => {
    const owner = { cacheOwner: ctx.config, signal: ctx.signal };
    const settings = await loadAccountSettings(ctx.client, owner);
    const guidance = await loadReceiptGuidance(ctx.client, { kind: "all" }, owner);
    const datev = await loadAccountsDatev(ctx.client, owner);
    const version = await getBookkeepingSystemVersion(ctx.client, ctx.signal);
    // Fresh wrappers per call catch accidental client-keyed caching as well as cross-account leaks.
    const countries = await loadCountryCodes(
      readOnlyClient(ctx.client, "probing country cache"),
      owner,
    );
    return {
      data: {
        smallBusiness: settings?.smallBusiness,
        chart: settings?.chartOfAccounts,
        guideAccount: guidance.guides[0]?.accountNumber,
        datevNumber: datev.accounts[0]?.number,
        version,
        countryCode: countries.get(1),
      },
      summary: "Probed.",
    };
  },
});

function dummy(name: string): AnyToolDefinition {
  const tool = createDummyTools().tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(name);
  return tool;
}

/** A stand-in for the approvals inbox: records presented approvals, decides like a signed-in user. */
function inbox() {
  let store: Pick<ApprovalStore, "get" | "decide"> | undefined;
  const views: ApprovalView[] = [];
  const channel: ApprovalChannel = {
    kind: "remote",
    inboxUrl: "https://mcp.example.com/approvals",
    attach: (attached) => {
      store = attached;
    },
    present: (view) => {
      views.push(view);
      return Promise.resolve({ opened: false });
    },
    close: () => Promise.resolve(),
  };
  const decide = (reference: string, decision: "approved" | "rejected") => {
    const view = views.find((candidate) => candidate.reference === reference);
    if (view === undefined) throw new Error(`no approval ${reference}`);
    return store?.decide(view.id, decision);
  };
  return { channel, views, decide };
}

interface Stack {
  readonly factory: ServerFactory;
  readonly safety: SafetyRuntime;
  readonly fakes: Readonly<Record<string, FakeSevdeskClient>>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function stack(
  tools: readonly AnyToolDefinition[],
  overrides: Partial<Settings> = {},
  channel?: ApprovalChannel,
): Stack {
  const {
    token: _token,
    account: _account,
    deployment: _deployment,
    ...settings
  } = allEnabledConfig(overrides);
  const fakes: Record<string, FakeSevdeskClient> = {
    "1001": new FakeSevdeskClient(routesOf(DATA["1001"]!)),
    "2002": new FakeSevdeskClient(routesOf(DATA["2002"]!)),
  };
  const accounts = createAccountResolver({
    mode: "oauth",
    settings,
    deployment: httpDeployment("oauth"),
    createClient: (config) => {
      const fake = fakes[config.account?.id ?? ""];
      if (fake === undefined) throw new Error("unknown account");
      return fake;
    },
  });
  const safety = createSafetyRuntime(settings, {
    ...(channel === undefined ? {} : { approvalChannel: channel }),
  });
  const factory = createServerFactory({ settings, accounts, tools, safety });
  cleanups.push(() => factory.close());
  return { factory, safety, fakes };
}

async function connect(
  factory: ServerFactory,
  authInfo: AuthInfo,
  era: "modern" | "legacy" = "modern",
): Promise<Client> {
  const client = await connectFactory(factory, { authInfo, era });
  cleanups.push(() => client.close());
  return client;
}

function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

describe("two accounts through one factory", () => {
  it("never share the account caches", async () => {
    const { factory, fakes } = stack([probeTool]);
    const a = await connect(factory, A1);
    const b = await connect(factory, B);

    const firstA = resultData(await call(a, "sevdesk_probe_caches"));
    const firstB = resultData(await call(b, "sevdesk_probe_caches"));
    const againA = resultData(await call(a, "sevdesk_probe_caches"));
    const againB = resultData(await call(b, "sevdesk_probe_caches"));

    expect(firstA).toEqual({
      smallBusiness: false,
      chart: "skr03",
      guideAccount: "8400",
      datevNumber: "4400",
      version: "2.0",
      countryCode: "DE",
    });
    expect(firstB).toEqual({
      smallBusiness: true,
      chart: "skr04",
      guideAccount: "4300",
      datevNumber: "6815",
      version: "1.0",
      countryCode: "AT",
    });
    expect(againA).toEqual(firstA);
    expect(againB).toEqual(firstB);
    // Each account read every value once (then from its own cache), never the other's answer.
    for (const fake of [fakes["1001"]!, fakes["2002"]!]) {
      expect(fake.callsTo("/SevClient")).toHaveLength(1);
      expect(fake.callsTo("/ReceiptGuidance/forAllAccounts")).toHaveLength(1);
      expect(fake.callsTo("/Tools/bookkeepingSystemVersion")).toHaveLength(1);
      expect(fake.callsTo("/StaticCountry")).toHaveLength(1);
    }
  });

  // Legacy: what claude.ai speaks today (one stateless instance per HTTP request).
  it.each(["modern", "legacy"] as const)(
    "never let one account's (or connection's) retry take another's browser approval (%s era)",
    async (era) => {
      const approvals = inbox();
      const { factory, fakes, safety } = stack(
        [dummy("sevdesk_dummy_finalize")],
        { confirm: "browser" },
        approvals.channel,
      );
      const a1 = await connect(factory, A1, era);
      const a2 = await connect(factory, A2, era);
      const b = await connect(factory, B, era);
      const finalize = (client: Client) => call(client, "sevdesk_dummy_finalize", { id: 7 });

      const pendingA = await finalize(a1);
      const { reference } = resultData(pendingA)["approval"] as { reference: string };
      expect(approvals.decide(reference, "approved")).toBe("decided");

      // Same tool, same arguments, same preview: B and A's other grant each get their own request.
      const fromB = await finalize(b);
      const fromA2 = await finalize(a2);
      for (const result of [fromB, fromA2]) {
        expect(resultData(result)).toMatchObject({ status: "approval_pending" });
        expect((resultData(result)["approval"] as { reference: string }).reference).not.toBe(
          reference,
        );
      }
      expect(writesOf(fakes["1001"]!)).toEqual([]);
      expect(writesOf(fakes["2002"]!)).toEqual([]);

      // The inbox lists per account; the approval is still there for the grant that asked.
      expect(safety.approvals.list("1001").map((view) => view.owner.grantKey)).toEqual([
        "grant-a2",
        "grant-a1",
      ]);
      expect(safety.approvals.list("2002").map((view) => view.owner.grantKey)).toEqual(["grant-b"]);
      expect(resultData(await finalize(a1))).toMatchObject({ status: "done" });
      expect(writesOf(fakes["1001"]!)).toEqual([{ method: "PUT", path: "/Invoice/7/sendBy" }]);
      expect(writesOf(fakes["2002"]!)).toEqual([]);
    },
  );

  it("refuse one account's elicitation state under another account or grant", async () => {
    const { factory, fakes } = stack([dummy("sevdesk_dummy_finalize")]);
    const connectAs = async (authInfo: AuthInfo) => {
      const harness = await connectConfirming(factory, { manual: true, authInfo });
      cleanups.push(() => harness.close());
      return harness.client;
    };
    const a1 = await connectAs(A1);
    const first = (await a1.callTool(
      { name: "sevdesk_dummy_finalize", arguments: { id: 7 } },
      { allowInputRequired: true },
    )) as unknown as { requestState: string };
    const approved = {
      name: "sevdesk_dummy_finalize",
      arguments: { id: 7 },
      inputResponses: { confirm: { action: "accept", content: { approve: true } } },
      requestState: first.requestState,
    };

    for (const other of [B, A2]) {
      const client = await connectAs(other);
      await expect(client.callTool(approved as never)).rejects.toThrow(
        /Invalid or expired requestState/,
      );
    }
    expect(writesOf(fakes["1001"]!)).toEqual([]);
    expect(writesOf(fakes["2002"]!)).toEqual([]);

    const done = await a1.callTool(approved);
    expect(resultData(done)).toMatchObject({ status: "done" });
    expect(writesOf(fakes["1001"]!)).toEqual([{ method: "PUT", path: "/Invoice/7/sendBy" }]);
  });

  it("name the account and grant in audit lines and keep every token out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-cross-account-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "audit.jsonl");
    const { factory } = stack([dummy("sevdesk_dummy_create")], { auditLogPath: path });
    const a = await connect(factory, A1);
    const b = await connect(factory, B);

    const resultA = await call(a, "sevdesk_dummy_create", { name: `Muster ${TOKEN_A}` });
    const resultB = await call(b, "sevdesk_dummy_create", { name: `Muster ${TOKEN_B}` });

    const text = await readFile(path, "utf8");
    const lines = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line["event"], line["account"], line["grant"]])).toEqual([
      ["executing", "1001", "grant-a1"],
      ["executed", "1001", "grant-a1"],
      ["executing", "2002", "grant-b"],
      ["executed", "2002", "grant-b"],
    ]);
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_B);
    expect(lines[0]?.["args"]).toEqual({ name: "Muster [REDACTED]" });
    expect(JSON.stringify(resultA)).not.toContain(TOKEN_B);
    expect(JSON.stringify(resultB)).not.toContain(TOKEN_A);
    expect(resultText(resultA)).toContain("Created contact 1.");
  });
});
