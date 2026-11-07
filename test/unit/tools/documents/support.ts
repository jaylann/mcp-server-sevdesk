/**
 * Shared harness for the document file tool tests: fake sevDesk routes, an in-process client per
 * configuration, temporary directories, and result helpers. Call {@link useHarness} at the top
 * level of a test file; it registers the cleanup.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult, Client } from "@modelcontextprotocol/client";
import { afterEach } from "vitest";

import type { Config } from "../../../../src/config.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { DOCUMENT_FILE_TOOLS } from "../../../../src/tools/documents/index.js";
import { testConfig } from "../../../helpers/config.js";
import { connectInProcess, type ConnectOptions } from "../../../helpers/connect.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";

export const PDF_BASE64 = (
  loadFixture("documents/invoice-pdf.json").body as { objects: { content: string } }
).objects.content;
export const PDF_BYTES = Buffer.from(PDF_BASE64, "base64");
export const POSIX = process.platform !== "win32";

const ROUTES: FakeRoute[] = [
  {
    path: "/Invoice/12/getPdf",
    query: { preventSendBy: true },
    response: { fixture: "documents/invoice-pdf.json" },
  },
  {
    path: "/CreditNote/12/getPdf",
    query: { preventSendBy: true },
    response: { fixture: "documents/credit-note-pdf.json" },
  },
  {
    path: "/Order/12/getPdf",
    query: { preventSendBy: true },
    response: { fixture: "documents/order-pdf.json" },
  },
  { path: "/Invoice/12/getXml", response: { fixture: "documents/invoice-xml.json" } },
  { path: "/Invoice/13/getXml", response: { body: { objects: null } } },
  {
    path: "/Invoice/14/getPdf",
    response: {
      body: {
        objects: { filename: "../../escape.pdf", base64encoded: true, content: PDF_BASE64 },
      },
    },
  },
  {
    path: "/Invoice/404/getPdf",
    response: {
      error: new SevdeskError({
        kind: "not_found",
        message: "sevDesk found no invoice.",
        status: 404,
      }),
    },
  },
];

export interface Harness {
  /** A server with only the document file tools for `overrides`, plus its fake sevDesk. */
  setup(
    overrides?: Partial<Config>,
    options?: ConnectOptions,
  ): Promise<{ client: Client; fake: FakeSevdeskClient }>;
  /** A fresh temporary directory, removed after the test. */
  tempDir(): Promise<string>;
}

export function useHarness(): Harness {
  const clients: Client[] = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  return {
    async setup(overrides = {}, options = {}) {
      const fake = new FakeSevdeskClient(ROUTES);
      const client = await connectInProcess(
        { config: testConfig(overrides), client: fake, tools: DOCUMENT_FILE_TOOLS },
        options,
      );
      clients.push(client);
      return { client, fake };
    },
    async tempDir() {
      const dir = await mkdtemp(join(tmpdir(), "sevdesk-files-"));
      temporary.push(dir);
      return dir;
    },
  };
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

export function dataOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
}
