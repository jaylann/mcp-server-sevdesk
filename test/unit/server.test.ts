import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import { createAccountResolver } from "../../src/accounts/resolver.js";
import type { AccountResolver } from "../../src/accounts/types.js";
import type { Settings } from "../../src/config.js";
import { buildInstructions } from "../../src/instructions.js";
import { createSafetyRuntime } from "../../src/safety/runtime.js";
import { createServer, createServerFactory, SERVER_INFO } from "../../src/server.js";
import { ToolDefinitionError } from "../../src/tools/define-tool.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { selectTools } from "../../src/tools/registry.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { allEnabledConfig, testConfig } from "../helpers/config.js";
import { connectFactory, connectInProcess, type ConnectOptions } from "../helpers/connect.js";
import { createDummyTools, READ_ANNOTATIONS, stubClient } from "../helpers/dummy-tools.js";
import { grantAuthInfo, type GrantOptions, httpDeployment } from "../helpers/write-flow.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(
  tools: readonly AnyToolDefinition[] = [],
  options: ConnectOptions = {},
): Promise<Client> {
  const client = await connectInProcess({ tools }, options);
  clients.push(client);
  return client;
}

describe("createServer", () => {
  it.each(["modern", "legacy"] as const)(
    "identifies itself with the package name and version (%s era)",
    async (era) => {
      const client = await connect([], { era });

      expect(client.getServerVersion()).toMatchObject({ name: pkg.name, version: pkg.version });
      expect(SERVER_INFO.name).toBe("mcp-server-sevdesk");
    },
  );

  it("sends instructions generated from the registered tools", async () => {
    const { tools } = createDummyTools();
    const client = await connect(tools);

    const config = testConfig();
    const expected = buildInstructions(selectTools(tools, config), config);
    expect(client.getInstructions()).toBe(expected);
    expect(expected).toMatch(/untrusted/i);
  });

  it("registers only the tools selected for the configuration, sorted by name", async () => {
    const { tools } = createDummyTools();
    const client = await connect(tools);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "sevdesk_dummy_bad_output",
      "sevdesk_dummy_echo",
      "sevdesk_dummy_fail",
      "sevdesk_dummy_progress",
      "sevdesk_dummy_wait",
    ]);
  });

  it("serves a valid, empty tool list when no tool is selected", async () => {
    const client = await connect([]);

    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
  });

  it("declares a static tool list (listChanged: false)", async () => {
    const client = await connect([]);

    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
  });

  it("serves the shipped catalog by default", async () => {
    const client = await connectInProcess();
    clients.push(client);

    const { tools } = await client.listTools();
    const expected = selectTools(ALL_TOOLS, testConfig()).map((tool) => tool.name);
    expect(tools.map((tool) => tool.name)).toEqual(expected);
  });

  it("refuses an invalid tool definition at startup", () => {
    const broken = {
      ...createDummyTools().tools[0]!,
      name: "Bad Name",
      annotations: { ...READ_ANNOTATIONS, readOnlyHint: false },
    };

    expect(() =>
      createServerFactory({ config: testConfig(), client: stubClient(), tools: [broken] }),
    ).toThrow(ToolDefinitionError);
  });

  it("refuses a loose input schema even when defineTool was bypassed", () => {
    const loose = { ...createDummyTools().tools[0]!, input: z.object({ text: z.string() }) };

    expect(() =>
      createServer({ config: testConfig(), client: stubClient(), tools: [loose] }),
    ).toThrow(/strictObject/);
  });

  it("exposes close(), which closes the shared safety runtime", async () => {
    const config = testConfig();
    const lines: string[] = [];
    const safety = createSafetyRuntime(config, { log: (line) => lines.push(line) });
    const owner = { grantKey: "stdio", accountScope: "local" };
    await safety.approvals.create(owner, {
      toolName: "sevdesk_dummy_finalize",
      toolTitle: "Finalize",
      tier: "commit",
      argsHash: "a",
      previewHash: "p",
      preview: { action: "A.", facts: [], warnings: [], irreversible: false },
      callId: "c",
    });
    const factory = createServerFactory({ config, client: stubClient(), tools: [], safety });

    await factory.close();

    expect(safety.approvals.current(owner, "sevdesk_dummy_finalize", "a")).toBeUndefined();
    const page = /http:\/\/127\.0\.0\.1:\d+\/open\/[A-Za-z0-9_-]{43}/.exec(lines[0] ?? "");
    expect(page).not.toBeNull();
    await expect(fetch(page?.[0] ?? "")).rejects.toThrow();
    await expect(
      createServerFactory({ config, client: stubClient(), tools: [] }).close(),
    ).resolves.toBeUndefined();
  });

  it("refuses duplicate tool names", () => {
    const echo = createDummyTools().tools[0]!;

    expect(() =>
      createServer({ config: testConfig(), client: stubClient(), tools: [echo, echo] }),
    ).toThrow(/Duplicate tool names: sevdesk_dummy_echo/);
  });
});

describe("createServerFactory with an account resolver (OAuth)", () => {
  const DEPLOYMENT = httpDeployment("oauth");

  function settings(): Settings {
    const config = allEnabledConfig();
    const { token: _token, account: _account, deployment: _deployment, ...rest } = config;
    return rest;
  }

  function oauthResolver(): AccountResolver {
    return createAccountResolver({
      mode: "oauth",
      settings: settings(),
      deployment: DEPLOYMENT,
      createClient: () => stubClient(),
    });
  }

  async function connectAs(
    factory: ReturnType<typeof createServerFactory>,
    tiers: NonNullable<GrantOptions["tiers"]>,
    accountId = "1001",
  ): Promise<Client> {
    const client = await connectFactory(factory, {
      authInfo: grantAuthInfo({ accountId, token: "a".repeat(32), tiers }),
    });
    clients.push(client);
    return client;
  }

  it("serves each grant the tools and instructions of its own tier set", async () => {
    const { tools } = createDummyTools();
    const factory = createServerFactory({
      settings: settings(),
      accounts: oauthResolver(),
      tools,
    });

    const reader = await connectAs(factory, ["read"]);
    const committer = await connectAs(factory, ["read", "commit"], "2002");

    const readNames = (await reader.listTools()).tools.map((tool) => tool.name);
    const commitNames = (await committer.listTools()).tools.map((tool) => tool.name);
    expect(readNames).not.toContain("sevdesk_dummy_finalize");
    expect(commitNames).toContain("sevdesk_dummy_finalize");
    expect(commitNames).not.toContain("sevdesk_dummy_create");
    expect(reader.getInstructions()).toContain("Enabled permission tiers: read.");
    expect(reader.getInstructions()).toContain("consent page");
    expect(committer.getInstructions()).toContain("Enabled permission tiers: read, commit.");
    await factory.close();
  });

  it("selects tools and builds instructions once per tier set", async () => {
    const available = vi.fn(() => true);
    const echo = { ...createDummyTools().tools[0]!, available };
    const factory = createServerFactory({
      settings: settings(),
      accounts: oauthResolver(),
      tools: [echo],
    });

    const a = await connectAs(factory, ["read"]);
    await a.listTools();
    const b = await connectAs(factory, ["read"], "2002");
    await b.listTools();
    expect(available).toHaveBeenCalledTimes(1);

    const c = await connectAs(factory, ["read", "write"]);
    await c.listTools();
    expect(available).toHaveBeenCalledTimes(2);
    await factory.close();
  });

  it("refuses a request the resolver cannot place", async () => {
    const factory = createServerFactory({
      settings: settings(),
      accounts: oauthResolver(),
      tools: [],
    });

    await expect(connectFactory(factory)).rejects.toThrow();
    await factory.close();
  });

  it("closes the resolver and the safety runtime with the factory", async () => {
    const accounts = oauthResolver();
    const closeAccounts = vi.spyOn(accounts, "close");
    const safety = createSafetyRuntime(settings(), { log: () => undefined });
    const closeSafety = vi.spyOn(safety, "close");
    const factory = createServerFactory({ settings: settings(), accounts, tools: [], safety });

    await factory.close();

    expect(closeAccounts).toHaveBeenCalledOnce();
    expect(closeSafety).toHaveBeenCalledOnce();
  });

  it("validates the catalog when the factory is built", () => {
    const loose = { ...createDummyTools().tools[0]!, input: z.object({ text: z.string() }) };

    expect(() =>
      createServerFactory({ settings: settings(), accounts: oauthResolver(), tools: [loose] }),
    ).toThrow(/strictObject/);
  });

  it("serves a fixed resolver like the single-account form", async () => {
    const config = testConfig();
    const { tools } = createDummyTools();
    const factory = createServerFactory({
      settings: config,
      accounts: createAccountResolver({ mode: "fixed", config, client: stubClient() }),
      tools,
    });
    const client = await connectFactory(factory);
    clients.push(client);

    expect(client.getInstructions()).toBe(buildInstructions(selectTools(tools, config), config));
    await factory.close();
  });
});
