import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Tier } from "../../../../src/safety/tiers.js";
import { DOCUMENT_FILE_TOOLS } from "../../../../src/tools/documents/index.js";
import { documentSaveTool } from "../../../../src/tools/documents/save-tool.js";
import { selectTools } from "../../../../src/tools/registry.js";
import type { ToolsetName } from "../../../../src/tools/toolsets.js";
import { testConfig } from "../../../helpers/config.js";
import { FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { dataOf, PDF_BASE64, PDF_BYTES, POSIX, textOf, useHarness } from "./support.js";

const harness = useHarness();
const NAME = "sevdesk_document_save";

function selected(overrides: Parameters<typeof testConfig>[0]): string[] {
  return selectTools(DOCUMENT_FILE_TOOLS, testConfig(overrides)).map((tool) => tool.name);
}

describe("sevdesk_document_save: metadata", () => {
  it("declares honest annotations: writes local files, not idempotent, nothing in sevDesk", () => {
    expect(documentSaveTool).toMatchObject({
      name: NAME,
      toolset: "meta",
      tier: "read",
      localEffects: "writes-files",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
  });

  it("says where it writes, that it never overwrites and never changes sevDesk", () => {
    const { description } = documentSaveTool;
    expect(description).toContain("writes only inside that folder");
    expect(description).toContain("never overwrites");
    expect(description).toContain("never changes anything in sevDesk");
    expect(description).toContain("SEVDESK_OUTPUT_DIR");
    expect(description.length).toBeLessThanOrEqual(700);
  });

  it("takes the document kind and id", () => {
    expect(Object.keys(documentSaveTool.input.shape)).toEqual(["document", "id"]);
  });
});

describe("sevdesk_document_save: registration", () => {
  it("is registered only when SEVDESK_OUTPUT_DIR is set", () => {
    expect(selected({})).not.toContain(NAME);
    expect(selected({ outputDir: "/srv/out" })).toContain(NAME);
  });

  it("needs at least one document toolset", () => {
    const toolsets = (...names: ToolsetName[]) => new Set<ToolsetName>(names);
    expect(selected({ outputDir: "/srv/out", toolsets: toolsets("meta", "contacts") })).toEqual([]);
    expect(selected({ outputDir: "/srv/out", toolsets: toolsets("meta", "orders") })).toEqual([
      NAME,
      "sevdesk_order_pdf",
    ]);
  });

  it("stays available in read-only mode: it never writes to sevDesk", () => {
    expect(
      selected({ outputDir: "/srv/out", readOnly: true, allowedTiers: new Set<Tier>(["read"]) }),
    ).toContain(NAME);
  });

  it("shows up in tools/list with readOnlyHint false only when configured", async () => {
    const without = await harness.setup();
    expect((await without.client.listTools()).tools.map((tool) => tool.name)).not.toContain(NAME);

    const configured = await harness.setup({ outputDir: await harness.tempDir() });
    const tool = (await configured.client.listTools()).tools.find((entry) => entry.name === NAME);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("is refused by the handler without SEVDESK_OUTPUT_DIR (defense in depth)", async () => {
    const fake = new FakeSevdeskClient([]);
    const call = documentSaveTool.handler({ document: "invoice_pdf", id: 12 }, testContext(fake));
    await expect(call).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("SEVDESK_OUTPUT_DIR is not set") as unknown,
    });
    expect(fake.calls).toEqual([]);
  });
});

describe("sevdesk_document_save: saving", () => {
  async function save(outputDir: string, document: string, id: number, extra = {}) {
    const { client, fake } = await harness.setup({ outputDir, ...extra });
    const result = await client.callTool({ name: NAME, arguments: { document, id } });
    return { result, fake };
  }

  it("writes the PDF with mode 0600, links the resource and keeps base64 out of the text", async () => {
    const dir = await harness.tempDir();

    const { result, fake } = await save(dir, "invoice_pdf", 12);

    expect(result.isError).toBeFalsy();
    const target = join(await realpath(dir), "RE-1001.pdf");
    expect(dataOf(result)).toEqual({
      uri: "sevdesk://invoices/12/pdf",
      filename: "RE-1001.pdf",
      mimeType: "application/pdf",
      bytes: PDF_BYTES.byteLength,
      savedTo: target,
    });
    expect(textOf(result)).toMatch(
      /^Invoice 12: saved the PDF file \(\d+ bytes\) as a new file in SEVDESK_OUTPUT_DIR; nothing changed in sevDesk\./,
    );
    expect(result.content[1]).toMatchObject({
      type: "resource_link",
      uri: "sevdesk://invoices/12/pdf",
      name: "RE-1001.pdf",
    });
    expect(JSON.stringify(result)).not.toContain(PDF_BASE64.slice(0, 16));
    expect((await readFile(target)).equals(PDF_BYTES)).toBe(true);
    if (POSIX) {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
    expect(fake.calls.map((call) => [call.path, call.query])).toEqual([
      ["/Invoice/12/getPdf", { preventSendBy: true }],
    ]);
  });

  it.each([
    ["credit_note_pdf", "GU-1001.pdf"],
    ["order_pdf", "AN-1001.pdf"],
    ["invoice_xml", "invoice-12.xml"],
  ])("saves %s as %s", async (document, filename) => {
    const dir = await harness.tempDir();

    const { result } = await save(dir, document, 12);

    expect(dataOf(result)["savedTo"]).toBe(join(await realpath(dir), filename));
    expect(await readdir(dir)).toEqual([filename]);
  });

  it("refuses a document kind whose toolset is disabled, before sending anything", async () => {
    const dir = await harness.tempDir();

    const { result, fake } = await save(dir, "order_pdf", 12, {
      toolsets: new Set<ToolsetName>(["meta", "invoices"]),
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nothing was sent");
    expect(textOf(result)).toContain("needs the orders toolset, which is not enabled");
    expect(fake.calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a missing directory, a file and an unwritable directory", async () => {
    const dir = await harness.tempDir();
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    const locked = join(dir, "locked");
    await mkdir(locked, { mode: 0o500 });

    const cases: [string, string][] = [
      [join(dir, "missing"), "does not exist"],
      [file, "is not a directory"],
    ];
    if (POSIX && process.getuid?.() !== 0) {
      cases.push([locked, "is not writable"]);
    }
    for (const [outputDir, expected] of cases) {
      const { result, fake } = await save(outputDir, "invoice_pdf", 12);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(expected);
      expect(textOf(result)).toContain("nothing was sent");
      expect(fake.calls).toEqual([]);
    }
  });

  it("never overwrites an existing file: it adds a numeric suffix", async () => {
    const dir = await harness.tempDir();
    await writeFile(join(dir, "RE-1001.pdf"), "keep me");
    const real = await realpath(dir);
    const { client } = await harness.setup({ outputDir: dir });
    const call = () =>
      client.callTool({ name: NAME, arguments: { document: "invoice_pdf", id: 12 } });

    const first = await call();
    const second = await call();

    expect(dataOf(first)["savedTo"]).toBe(join(real, "RE-1001-1.pdf"));
    expect(dataOf(second)["savedTo"]).toBe(join(real, "RE-1001-2.pdf"));
    expect(await readFile(join(dir, "RE-1001.pdf"), "utf8")).toBe("keep me");
  });

  it.runIf(POSIX)("does not follow a symlink planted under the target name", async () => {
    const dir = await harness.tempDir();
    const outside = await harness.tempDir();
    const victim = join(outside, "victim.pdf");
    await writeFile(victim, "secret");
    await symlink(victim, join(dir, "RE-1001.pdf"));
    await symlink(join(outside, "created.pdf"), join(dir, "RE-1001-1.pdf"));

    const { result } = await save(dir, "invoice_pdf", 12);

    expect(dataOf(result)["savedTo"]).toBe(join(await realpath(dir), "RE-1001-2.pdf"));
    expect(await readFile(victim, "utf8")).toBe("secret");
    expect(await readdir(outside)).toEqual(["victim.pdf"]);
  });

  it.runIf(POSIX)("resolves a symlinked output directory to its real path", async () => {
    const dir = await harness.tempDir();
    const real = await harness.tempDir();
    const link = join(dir, "out-link");
    await symlink(real, link);

    const { result } = await save(link, "order_pdf", 12);

    expect(dataOf(result)["savedTo"]).toBe(join(await realpath(real), "AN-1001.pdf"));
    expect(await readdir(real)).toEqual(["AN-1001.pdf"]);
  });

  it("keeps a hostile file name from sevDesk inside the directory", async () => {
    const dir = await harness.tempDir();
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });

    const { result } = await save(nested, "invoice_pdf", 14);

    expect(dataOf(result)).toMatchObject({
      filename: "escape.pdf",
      savedTo: join(await realpath(nested), "escape.pdf"),
    });
    expect(await readdir(join(dir, "a"))).toEqual(["b"]);
  });

  it("writes nothing when the fetch fails", async () => {
    const dir = await harness.tempDir();

    const { result } = await save(dir, "invoice_xml", 13);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no e-invoice XML for invoice 13");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects an unknown document kind before sending anything", async () => {
    const dir = await harness.tempDir();

    const { result, fake } = await save(dir, "voucher_pdf", 12);

    expect(result.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});
