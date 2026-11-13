/**
 * `tools/list` snapshots of the shipped catalog per tier configuration. A diff here is a change to
 * the public tool surface: review it like an API change.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../src/config.js";
import { allEnabledConfig, testConfig, tiers } from "../helpers/config.js";
import { connectInProcess } from "../helpers/connect.js";
import { filesConfig } from "../helpers/transfer.js";

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

  it("SEVDESK_FILE_DIRS set: adds only the read-only e-invoice parser to the read tier", async () => {
    const without = (await surface(testConfig())).map((tool) => tool.name);
    const tools = await surface(testConfig({ fileDirs: ["/srv/belege"] }));

    expect(without).not.toContain("sevdesk_einvoice_parse");
    expect(
      tools.map((tool) => tool.name).filter((name) => name !== "sevdesk_einvoice_parse"),
    ).toEqual(without);
    expect(tools.find((tool) => tool.name === "sevdesk_einvoice_parse")?.annotations).toMatchObject(
      { readOnlyHint: true, destructiveHint: false },
    );
  });

  it("SEVDESK_OUTPUT_DIR set (adds the file-writing save tool)", async () => {
    const tools = await surface(testConfig({ outputDir: "/srv/sevdesk-exports" }));
    expect(tools.filter((tool) => tool.name === "sevdesk_document_save")).toMatchSnapshot();
  });

  it("SEVDESK_OUTPUT_DIR set: adds the read-tier file writers, declared as not read-only", async () => {
    const writers = ["sevdesk_document_save", "sevdesk_csv_export", "sevdesk_voucher_receipt_save"];
    const without = (await surface(testConfig())).map((tool) => tool.name);
    const tools = await surface(testConfig({ outputDir: "/srv/sevdesk-out" }));

    for (const name of writers) expect(without).not.toContain(name);
    expect(tools.map((tool) => tool.name).filter((name) => !writers.includes(name))).toEqual(
      without,
    );
    expect(tools.find((tool) => tool.name === "sevdesk_csv_export")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(tools.find((tool) => tool.name === "sevdesk_document_save")).toEqual({
      name: "sevdesk_document_save",
      title: "Save a document file",
      annotations: {
        title: "Save a document file",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: expect.objectContaining({
        type: "object",
        additionalProperties: false,
        required: ["document", "id"],
        properties: expect.objectContaining({
          document: expect.objectContaining({
            enum: ["invoice_pdf", "credit_note_pdf", "order_pdf", "invoice_xml"],
          }) as unknown,
        }) as unknown,
      }) as unknown,
    });
  });

  it("over HTTP with file transfer (SEVDESK_HTTP_FILES on): adds the file tools", async () => {
    const fileTools = [
      "sevdesk_csv_export",
      "sevdesk_datev_export",
      "sevdesk_document_save",
      "sevdesk_einvoice_parse",
      "sevdesk_upload_request",
      "sevdesk_uploads_list",
      "sevdesk_voucher_import_einvoice",
      "sevdesk_voucher_receipt_save",
    ];
    const stdio = (await surface(allEnabledConfig())).map((tool) => tool.name);
    const tools = await surface(filesConfig());

    expect(tools.map((tool) => tool.name).filter((name) => !stdio.includes(name))).toEqual(
      fileTools,
    );
    expect(tools.filter((tool) => fileTools.includes(tool.name))).toMatchSnapshot();
  });

  it("is sorted by name", async () => {
    const names = (await surface(allEnabledConfig())).map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
  });
});

/** The additive output fields across read and write tools, including nested report rows. */
function outputFields(value: unknown, path = ""): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  const fields: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) {
    const current = `${path}/${name}`;
    if (
      /\/properties\/(?:status|type|bookingCategory)\/properties\/key$/.test(current) ||
      (name === "country" && path.endsWith("/properties")) ||
      /^\/properties\/(?:hasMore|limit)$/.test(current)
    ) {
      fields[current] = child;
    } else {
      Object.assign(fields, outputFields(child, current));
    }
  }
  return fields;
}

it("advertises additive output keys, countries and lookup paging", async () => {
  const client = await connectInProcess({ config: allEnabledConfig() });
  clients.push(client);
  const { tools } = await client.listTools();
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const tool of tools) {
    const fields = outputFields(tool.outputSchema);
    if (Object.keys(fields).length > 0) outputs[tool.name] = fields;
  }
  expect(outputs).toMatchSnapshot();
});
