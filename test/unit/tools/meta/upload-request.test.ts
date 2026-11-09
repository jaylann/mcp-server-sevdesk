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
  it("is a read tool of the meta toolset that is not idempotent", () => {
    expect(META_TOOLS).toContain(tool);
    expect(tool).toMatchObject({ tier: "read", toolset: "meta" });
    expect(tool.localEffects).toBeUndefined();
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(Object.keys(tool.input.shape)).toEqual(["purpose"]);
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
        "they open it in the browser, signed in to this sevDesk account, and upload one PDF, " +
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
