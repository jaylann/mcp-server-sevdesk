import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../../../src/config.js";
import { META_TOOLS } from "../../../../src/tools/meta/index.js";
import { uploadRequestTool as tool } from "../../../../src/tools/meta/upload-request.js";
import { allEnabledConfig, TEST_TOKEN, testConfig } from "../../../helpers/config.js";
import { connectInProcess } from "../../../helpers/connect.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  FILES_ORIGIN,
  filesConfig,
  filesDeployment,
  filesOffDeployment,
  OWNER,
  type TransferFixture,
  useTransfer,
} from "../../../helpers/transfer.js";
import {
  grantAuthInfo,
  resultData,
  resultSummary,
  resultText,
} from "../../../helpers/write-flow.js";

const openTransfer = useTransfer();
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(transfer: TransferFixture, config: Config = filesConfig()) {
  const fake = new FakeSevdeskClient([]);
  const client = await connectInProcess(
    { config, client: fake, tools: META_TOOLS, transfer: transfer.store },
    { authInfo: grantAuthInfo({ accountId: "4711", token: TEST_TOKEN, grantId: "grant-1" }) },
  );
  clients.push(client);
  return { client, fake };
}

describe("sevdesk_upload_request: metadata", () => {
  it("is a read tool of the meta toolset that is neither read-only nor idempotent", () => {
    expect(META_TOOLS).toContain(tool);
    expect(tool).toMatchObject({ tier: "read", toolset: "meta" });
    // Every call opens an upload ticket on this server (an account holds only a few), so the
    // tool does not claim to be read-only although it changes nothing in sevDesk.
    expect(tool.localEffects).toBe("opens-upload");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(Object.keys(tool.input.shape)).toEqual(["count", "purpose"]);
    expect(tool.description).toContain("uploadId");
    expect(tool.description.length).toBeLessThanOrEqual(1_000);
  });

  it("is offered only over HTTP with file transfer on", () => {
    expect(tool.available?.(testConfig())).toBe(false);
    expect(tool.available?.(allEnabledConfig({ fileDirs: ["/srv/belege"] }))).toBe(false);
    expect(tool.available?.(testConfig({ deployment: filesOffDeployment() }))).toBe(false);
    expect(tool.available?.(testConfig({ deployment: filesDeployment() }))).toBe(true);
    expect(tool.available?.(testConfig({ deployment: filesDeployment("bearer") }))).toBe(true);
  });
});

describe("sevdesk_upload_request: calls", () => {
  it("is listed with file transfer and returns the page, the uploadId and the limits", async () => {
    const transfer = await openTransfer();
    const { client, fake } = await connect(transfer);
    expect((await client.listTools()).tools.map((entry) => entry.name)).toContain(tool.name);

    const result = await client.callTool({ name: tool.name, arguments: { purpose: "receipt" } });

    expect(result.isError).toBeFalsy();
    const data = resultData(result);
    const id = String(data["uploadId"]).slice("upload:".length);
    expect(data).toEqual({
      uploadId: expect.stringMatching(/^upload:[A-Za-z0-9_-]{43}$/) as unknown,
      url: `${FILES_ORIGIN}/uploads/${id}`,
      reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
      expiresAt: "2026-11-09T12:15:00.000Z",
      accepts: ["pdf", "png", "jpeg"],
      maxBytes: 20 * 1024 * 1024,
    });
    expect(resultSummary(result)).toBe(
      `Upload request ${String(data["reference"])} (receipt): give the user the link in url; ` +
        "they open it in the browser they connected this server with (any other browser asks " +
        "for the account's sevDesk API token) and upload one PDF, " +
        "PNG, JPEG file of at most 20 MB before 2026-11-09T12:15:00.000Z. When they say it is " +
        "done, call the tool that needs the file with file set to uploadId. Nothing was sent to " +
        "sevDesk.",
    );
    expect(resultSummary(result)).not.toContain(id);
    expect(fake.calls).toEqual([]);
    // The ticket belongs to the calling grant: its page is shown to account 4711 only.
    expect(transfer.store.ticketFor(id, "4711")).toMatchObject({
      purpose: "receipt",
      status: "pending",
    });
    expect(transfer.store.ticketFor(id, "4712")).toBeUndefined();
  });

  it("accepts e-invoices as XML or PDF", async () => {
    const transfer = await openTransfer();
    const { client } = await connect(transfer);

    const result = await client.callTool({ name: tool.name, arguments: { purpose: "einvoice" } });

    expect(resultData(result)["accepts"]).toEqual(["xml", "pdf"]);
  });

  it("rejects an unknown purpose and says when the account has too many open requests", async () => {
    const transfer = await openTransfer();
    const { client } = await connect(transfer);

    const invalid = await client.callTool({ name: tool.name, arguments: { purpose: "contract" } });
    expect(invalid.isError).toBe(true);

    for (let index = 0; index < 5; index += 1) {
      await client.callTool({ name: tool.name, arguments: { purpose: "receipt" } });
    }
    const full = await client.callTool({ name: tool.name, arguments: { purpose: "receipt" } });
    expect(full.isError).toBe(true);
    expect(resultText(full)).toContain("are still waiting for a file");
  });

  it("is not listed over stdio", async () => {
    const client = await connectInProcess({ config: allEnabledConfig(), tools: META_TOOLS });
    clients.push(client);
    expect((await client.listTools()).tools.map((entry) => entry.name)).not.toContain(tool.name);
  });
});

describe("upload batches through MCP", () => {
  it("reserves ten slots on one page and lists names without reading or consuming bytes", async () => {
    const transfer = await openTransfer();
    const { client, fake } = await connect(transfer);
    const result = await client.callTool({
      name: tool.name,
      arguments: { purpose: "receipt", count: 10 },
    });
    expect(result.isError).toBeFalsy();
    const data = resultData(result);
    expect(data["uploadId"]).toBeUndefined();
    expect(data["count"]).toBe(10);
    expect(data["url"]).toBe(`${FILES_ORIGIN}/uploads/${String(data["batchId"])}`);
    const batch = transfer.store.readBatch(OWNER, String(data["batchId"]));
    const slot = batch?.slots[0];
    expect(slot).toBeDefined();
    if (slot === undefined) throw new Error("missing slot");
    await transfer.store.receive(slot.id, OWNER.accountScope, {
      name: "Beleg_Maerz.pdf",
      kind: "pdf",
      bytes: Buffer.from("%PDF-1.7"),
    });
    const before = transfer.store.usage();
    const lookup = await client.callTool({
      name: "sevdesk_uploads_list",
      arguments: { batchId: data["batchId"] },
    });
    expect(lookup.isError).toBeFalsy();
    expect(resultData(lookup)["files"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uploadId: `upload:${slot.id}`,
          name: "Beleg_Maerz.pdf",
          status: "uploaded",
        }),
        expect.objectContaining({ status: "pending" }),
      ]),
    );
    expect(resultSummary(lookup)).not.toContain("Beleg_Maerz.pdf");
    expect(transfer.store.usage()).toEqual(before);
    expect(fake.calls).toEqual([]);
  });

  it.each([0, 11, 1.5, -1, "2", null])(
    "rejects count %s without reserving slots",
    async (count) => {
      const transfer = await openTransfer();
      const { client } = await connect(transfer);
      const result = await client.callTool({
        name: tool.name,
        arguments: { purpose: "receipt", count },
      });
      expect(result.isError).toBe(true);
      expect(transfer.store.usage().records).toBe(0);
    },
  );

  it("keeps count 1 on the single-file shape and refuses an over-capacity batch atomically", async () => {
    const transfer = await openTransfer();
    const { client } = await connect(transfer);
    const single = resultData(
      await client.callTool({ name: tool.name, arguments: { purpose: "receipt", count: 1 } }),
    );
    expect(single["uploadId"]).toBeDefined();
    expect(single["batchId"]).toBeUndefined();
    const result = await client.callTool({
      name: tool.name,
      arguments: { purpose: "receipt", count: 10 },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("only 9 of 10 remaining");
    expect(resultText(result)).toContain("2026-11-09T12:15:00.000Z");
    expect(transfer.store.usage().records).toBe(1);
  });

  it("refuses unknown and foreign batch lookups with the same trusted message", async () => {
    const transfer = await openTransfer();
    const { client } = await connect(transfer);
    const foreign = transfer.store.createBatch({ ...OWNER, grantKey: "other" }, "receipt", 2);
    const unknown = await client.callTool({
      name: "sevdesk_uploads_list",
      arguments: { batchId: "x".repeat(43) },
    });
    const denied = await client.callTool({
      name: "sevdesk_uploads_list",
      arguments: { batchId: foreign.id },
    });
    expect(denied.isError).toBe(true);
    expect(resultText(denied)).toBe(resultText(unknown));
    expect(resultText(denied)).not.toContain(foreign.id);
  });
});
