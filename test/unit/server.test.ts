import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import { buildInstructions } from "../../src/instructions.js";
import { createSafetyRuntime } from "../../src/safety/runtime.js";
import { createServer, createServerFactory, SERVER_INFO } from "../../src/server.js";
import { ToolDefinitionError } from "../../src/tools/define-tool.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { selectTools } from "../../src/tools/registry.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { testConfig } from "../helpers/config.js";
import { connectInProcess, type ConnectOptions } from "../helpers/connect.js";
import { createDummyTools, READ_ANNOTATIONS, stubClient } from "../helpers/dummy-tools.js";

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
    const safety = createSafetyRuntime(config, { log: () => undefined });
    const ticket = await safety.approvals.create({
      toolName: "sevdesk_dummy_finalize",
      toolTitle: "Finalize",
      tier: "commit",
      tierText: "legally binding bookkeeping",
      argsHash: "a",
      previewHash: "p",
      preview: { action: "A.", facts: [], warnings: [], irreversible: false },
      callId: "c",
    });
    const factory = createServerFactory({ config, client: stubClient(), tools: [], safety });

    await factory.close();

    expect(safety.approvals.current("sevdesk_dummy_finalize", "a")).toBeUndefined();
    await expect(fetch(ticket.url)).rejects.toThrow();
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
