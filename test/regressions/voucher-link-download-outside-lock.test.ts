/**
 * A receipt downloaded from a link must not hold up the account's other voucher draft calls.
 *
 * `sevdesk_voucher_create_draft`, `sevdesk_voucher_import_einvoice` and
 * `sevdesk_voucher_recognize_receipt` hold `ACCOUNT_VOUCHER_DRAFTS` from `prepare` to the end of
 * `execute`, so that the duplicate check and the save do not interleave. `prepare` used to download
 * a receipt link inside that lock, and a slow host (up to the download timeout, 60 s) blocked every
 * other draft call of the account (follow-up list of #134).
 *
 * Guard: the tools' `preload` downloads the link before the lock (`src/safety/link-prefetch.ts`),
 * and `prepare` reads those very bytes. Tested through the real server, write flow and record
 * locks; only the link reader is replaced by one whose download waits until the test lets it go.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import type { InputFile, ReadFileOptions } from "../../src/safety/file-access.js";
import { localFileAccess } from "../../src/safety/file-sources.js";
import { prefetchLinks } from "../../src/safety/link-prefetch.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { voucherCreateDraftTool } from "../../src/tools/vouchers/draft-create.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { LINK, LINK_HOST, LINK_PDF } from "../helpers/links.js";
import { closeWriteHarnessesAfterEach, resultData, writeHarness } from "../helpers/write-flow.js";
import { prepareWrite } from "../helpers/write-tools.js";
import {
  CREATE_READ_ROUTES,
  readBackRoutes,
  saveRoute,
  uploadRoute,
} from "../unit/tools/vouchers/routes.js";

/** The downloads the fake reader started, and the switch that lets them finish. */
const downloads = vi.hoisted(() => {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    started: 0,
    gate,
    open: () => {
      open();
    },
  };
});

vi.mock("../../src/safety/file-sources.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/safety/file-sources.js")>();
  return {
    ...original,
    linkReader:
      () =>
      async (_ref: string, _options: ReadFileOptions): Promise<InputFile> => {
        downloads.started += 1;
        await downloads.gate;
        return {
          name: "Rechnung-4711.pdf",
          kind: "pdf",
          bytes: LINK_PDF,
          source: "url",
          host: LINK_HOST,
        };
      },
  };
});

closeWriteHarnessesAfterEach();

const ARGS = {
  supplierId: 1001,
  number: "ER-2026-0815",
  date: "2026-11-02",
  positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
};

function harness() {
  return writeHarness({
    tools: [voucherCreateDraftTool],
    routes: [...CREATE_READ_ROUTES, saveRoute(), uploadRoute, ...readBackRoutes()],
    config: { fileUrlHosts: [LINK_HOST] },
  });
}

/** Resolves after `ms` with `"timed out"`. */
function after(ms: number): Promise<"timed out"> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("timed out");
    }, ms);
  });
}

/** Waits until `check` holds (at most two seconds). */
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

describe("a receipt link is downloaded outside the voucher-drafts lock", () => {
  it("lets another draft call of the account run while the download waits", async () => {
    const { client } = await harness();

    let settled = false;
    const slow = client
      .callTool({ name: "sevdesk_voucher_create_draft", arguments: { ...ARGS, file: LINK } })
      .finally(() => {
        settled = true;
      });
    await until(() => downloads.started === 1);

    const other = await Promise.race([
      client.callTool({
        name: "sevdesk_voucher_create_draft",
        arguments: { ...ARGS, number: "ER-2026-0816" },
      }),
      after(2_000),
    ]);
    expect(other).not.toBe("timed out");
    expect((other as CallToolResult).isError).not.toBe(true);
    expect(resultData(other as CallToolResult)).toMatchObject({ status: "done" });
    expect(settled).toBe(false);

    downloads.open();
    const result = await slow;
    expect(result.isError).not.toBe(true);
    expect(resultData(result)).toMatchObject({
      status: "done",
      result: { receipt: { name: "Rechnung-4711.pdf", downloadedFrom: `https://${LINK_HOST}` } },
    });
    // prepare got the bytes of the download before the lock; nothing was downloaded twice.
    expect(downloads.started).toBe(1);
  });

  it.each([
    ["sevdesk_voucher_create_draft", { ...ARGS, file: LINK }],
    ["sevdesk_voucher_import_einvoice", { file: LINK, accountDatevId: 4266 }],
    ["sevdesk_voucher_recognize_receipt", { file: LINK }],
  ])("%s: prepare takes the download its preload started", async (name, args) => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === name) as AnyWriteToolDefinition;
    let reads = 0;
    const files = localFileAccess(
      { fileDirs: [], outputDir: undefined, fileUrlHosts: [LINK_HOST] },
      () => {
        reads += 1;
        return Promise.resolve({
          name: "Rechnung-4711.pdf",
          kind: "pdf",
          bytes: LINK_PDF,
          source: "url",
          host: LINK_HOST,
        });
      },
    );
    const call = prefetchLinks(files, `account-${name}`);
    const { prefetcher, files: prefetched } = call;
    await tool.preload?.(args, { signal: new AbortController().signal, files: prefetcher });
    expect(reads).toBe(1);
    const prepareReads = vi.spyOn(prefetched, "read");
    // prepare may refuse later (the PDF is no e-invoice); what counts is that it read no link.
    await prepareWrite(
      tool,
      args,
      new FakeSevdeskClient(CREATE_READ_ROUTES),
      { fileUrlHosts: [LINK_HOST] },
      prefetched,
    ).catch(() => undefined);
    call.dispose();
    expect(prepareReads).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
  });

  it("downloads nothing for arguments the write flow refuses first", async () => {
    const { client } = await harness();
    const before = downloads.started;
    const result = await client.callTool({
      name: "sevdesk_voucher_create_draft",
      arguments: { ...ARGS, number: "ER-2026-0817​", file: LINK },
    });
    expect(result.isError).toBe(true);
    expect(downloads.started).toBe(before);
  });

  it("frees the account's prefetch when prepare refuses without reading the download", async () => {
    // At most one prefetch per account waits for its prepare (src/safety/link-prefetch.ts). One
    // that no prepare takes must not keep that place after its call, or the account's later link
    // drafts would all download inside the lock again.
    const refusing = {
      ...voucherCreateDraftTool,
      prepare: () =>
        Promise.reject(
          new SevdeskError({ kind: "validation", message: "Refused before reading the file." }),
        ),
    };
    const { client } = await writeHarness({
      tools: [refusing],
      routes: CREATE_READ_ROUTES,
      config: { fileUrlHosts: [LINK_HOST] },
    });
    downloads.open();
    const before = downloads.started;
    for (const number of ["ER-2026-0830", "ER-2026-0831"]) {
      const result = await client.callTool({
        name: "sevdesk_voucher_create_draft",
        arguments: { ...ARGS, number, file: LINK },
      });
      expect(result.isError).toBe(true);
    }
    // Each call prefetched its link: the first call's untaken download was dropped with it.
    expect(downloads.started - before).toBe(2);
  });
});
