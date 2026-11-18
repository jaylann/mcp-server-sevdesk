/**
 * Link downloads before a write tool's locks (`src/safety/link-prefetch.ts`): the outcome of a
 * prefetch, file or error, goes to the first matching read of the call, once; every other read goes
 * to the call's file access unchanged.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ReadFileOptions } from "../../../src/safety/file-access.js";
import { localFileAccess } from "../../../src/safety/file-sources.js";
import { prefetchLinks } from "../../../src/safety/link-prefetch.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { fakeLinks, LINK, LINK_HOST, LINK_PDF, served } from "../../helpers/links.js";

const PDF_ONLY: ReadFileOptions = { maxBytes: 1024, kinds: ["pdf"] };

function access(links = fakeLinks(), fileDirs: string[] = []) {
  const files = localFileAccess(
    { fileDirs, outputDir: undefined, fileUrlHosts: [LINK_HOST] },
    links.reader,
  );
  return { links, ...prefetchLinks(files) };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("prefetchLinks", () => {
  it("hands a prefetched download to the first matching read, once", async () => {
    const { links, prefetcher, files } = access();
    await prefetcher.prefetch(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(1);

    const file = await files.read(LINK, { ...PDF_ONLY, signal: new AbortController().signal });
    expect(file.bytes).toEqual(LINK_PDF);
    expect(file.host).toBe(LINK_HOST);
    expect(links.requests).toHaveLength(1);

    // A second read downloads again, as every read of a link did before.
    await files.read(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(2);
  });

  it("keeps a failed download for the read, which rethrows it", async () => {
    const { links, prefetcher, files } = access(
      fakeLinks({ respond: () => served("<html>nope</html>", { "content-type": "text/html" }) }),
    );
    await expect(prefetcher.prefetch(LINK, PDF_ONLY)).resolves.toBeUndefined();
    const error: unknown = await files.read(LINK, PDF_ONLY).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    expect(links.requests).toHaveLength(1);
  });

  it("downloads a link once when it is prefetched twice", async () => {
    const { links, prefetcher } = access();
    await prefetcher.prefetch(LINK, PDF_ONLY);
    await prefetcher.prefetch(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(1);
  });

  it("does not hand a download to a read with other options", async () => {
    const { links, prefetcher, files } = access();
    await prefetcher.prefetch(LINK, PDF_ONLY);
    await files.read(LINK, { maxBytes: 1024, kinds: ["pdf", "xml"] });
    expect(links.requests).toHaveLength(2);
  });

  it("leaves local paths and uploads to the read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-prefetch-"));
    cleanup = () => rm(dir, { recursive: true, force: true });
    const path = join(dir, "Beleg.pdf");
    await writeFile(path, LINK_PDF);
    const { links, prefetcher, files } = access(fakeLinks(), [dir]);

    await prefetcher.prefetch(path, PDF_ONLY);
    await prefetcher.prefetch("upload:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", PDF_ONLY);
    expect(links.requests).toHaveLength(0);

    // The file changes after the prefetch: the read sees the new bytes, it was never read before.
    const changed = new TextEncoder().encode("%PDF-1.7\nneu\n%%EOF");
    await writeFile(path, changed);
    expect((await files.read(path, PDF_ONLY)).bytes).toEqual(changed);
  });

  it("passes everything else through to the call's file access", () => {
    const { files } = access();
    expect(files.canRead).toBe(true);
    expect(files.canDeliver).toBe(false);
    expect(files.describeDelivery()).toBe("nowhere: SEVDESK_OUTPUT_DIR is not set");
    expect(() => {
      files.release(LINK);
    }).not.toThrow();
    expect(() => files.requestUpload("receipt")).toThrow(SevdeskError);
  });
});
