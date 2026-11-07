/**
 * `tools/list` snapshots of the shipped catalog per tier configuration. A diff here is a change to
 * the public tool surface: review it like an API change.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../src/config.js";
import { allEnabledConfig, testConfig, tiers } from "../helpers/config.js";
import { connectInProcess } from "../helpers/connect.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function surface(config: Config) {
  const client = await connectInProcess({ config });
  clients.push(client);
  const { tools } = await client.listTools();
  return tools.map(({ name, title, annotations, inputSchema }) => ({
    name,
    title,
    annotations,
    inputSchema,
  }));
}

describe("tools/list", () => {
  it("default configuration (read tier, default toolsets)", async () => {
    expect(await surface(testConfig())).toMatchSnapshot();
  });

  it("SEVDESK_ALLOW=write", async () => {
    expect(await surface(testConfig({ allowedTiers: tiers("read", "write") }))).toMatchSnapshot();
  });

  it("SEVDESK_ALLOW=all with all toolsets", async () => {
    expect(await surface(allEnabledConfig())).toMatchSnapshot();
  });

  it("is sorted by name", async () => {
    const names = (await surface(allEnabledConfig())).map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
  });
});
