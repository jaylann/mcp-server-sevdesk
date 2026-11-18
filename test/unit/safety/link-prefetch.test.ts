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

/** Calls made by a test, disposed after it (the cap on prefetches is per process). */
const calls: { dispose(): void }[] = [];
let accounts = 0;

function access(links = fakeLinks(), fileDirs: string[] = [], account = `account-${++accounts}`) {
  const files = localFileAccess(
    { fileDirs, outputDir: undefined, fileUrlHosts: [LINK_HOST] },
    links.reader,
  );
  const call = prefetchLinks(files, account);
  calls.push(call);
  return { links, ...call };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  for (const call of calls.splice(0)) call.dispose();
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

  it("keeps at most one untaken download per account; the next call reads its link itself", async () => {
    // The download limits count running downloads only; a prefetched file stays in memory until
    // its call gets the lock. Without the cap every queued call of the account parked one.
    const links = fakeLinks();
    const first = access(links, [], "account-cap");
    const second = access(links, [], "account-cap");
    await first.prefetcher.prefetch(LINK, PDF_ONLY);
    await second.prefetcher.prefetch(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(1);

    // Another account is not held up by this one.
    const other = access(links, [], "account-other");
    await other.prefetcher.prefetch(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(2);

    // The second call reads its link inside the lock, as before the prefetch existed.
    expect((await second.files.read(LINK, PDF_ONLY)).bytes).toEqual(LINK_PDF);
    expect(links.requests).toHaveLength(3);
  });

  it("frees the account's place when a read takes the download or the call ends", async () => {
    const links = fakeLinks();
    const taken = access(links, [], "account-free");
    await taken.prefetcher.prefetch(LINK, PDF_ONLY);
    await taken.files.read(LINK, PDF_ONLY);

    const dropped = access(links, [], "account-free");
    await dropped.prefetcher.prefetch(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(2);
    dropped.dispose();
    // Disposed: the outcome is gone, a read downloads again.
    await dropped.files.read(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(3);

    const next = access(links, [], "account-free");
    await next.prefetcher.prefetch(LINK, PDF_ONLY);
    expect(links.requests).toHaveLength(4);
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
