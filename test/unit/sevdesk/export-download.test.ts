import { afterEach, describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  downloadPresignedExport,
  EXPORT_HOSTS,
  isAllowedExportLink,
  presignedTransport,
  swapPresignedFetch,
} from "../../../src/sevdesk/export-download.js";
import { createFakeFetch } from "../../helpers/fake-fetch.js";

const HOST = "sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com";
const SECRET = "X-Amz-Signature=deadbeefcafe";
const LINK = `https://${HOST}/9001/0a0e1eff/zip/BITTE-ENTPACKEN.zip?X-Amz-Expires=604800&${SECRET}`;
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function useFetch(...replies: Parameters<typeof createFakeFetch>) {
  const fake = createFakeFetch(...replies);
  restore = swapPresignedFetch(fake.fetch);
  return fake;
}

/** Runs `download` and returns the SevdeskError it throws. */
async function failure(download: Promise<unknown>): Promise<SevdeskError> {
  try {
    await download;
  } catch (error) {
    if (error instanceof SevdeskError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

describe("isAllowedExportLink", () => {
  it("accepts only https links to the recorded export host", () => {
    expect([...EXPORT_HOSTS]).toEqual([HOST]);
    expect(isAllowedExportLink(LINK)).toBe(true);
    expect(isAllowedExportLink(`https://${HOST}:443/x`)).toBe(true);
    for (const link of [
      `http://${HOST}/x`,
      `https://${HOST}:8443/x`,
      `https://user:pass@${HOST}/x`,
      "https://evil.example.com/x",
      `https://${HOST}.evil.example.com/x`,
      "https://other-bucket.s3.eu-central-1.amazonaws.com/x",
      "not a url",
      `ftp://${HOST}/x`,
    ]) {
      expect(isAllowedExportLink(link), link).toBe(false);
    }
  });
});

describe("downloadPresignedExport", () => {
  it("downloads without credentials, redirects or an Authorization header", async () => {
    const fake = useFetch(
      new Response(ZIP, { status: 200, headers: { "content-type": "binary/octet-stream" } }),
    );

    const result = await downloadPresignedExport(LINK);

    expect(result).toEqual({ bytes: ZIP, contentType: "binary/octet-stream" });
    const request = fake.requests[0];
    expect(request?.url.href).toBe(LINK);
    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cookie")).toBeNull();
    expect(request?.method).toBe("GET");
  });

  it("refuses a link to another host without sending anything", async () => {
    const fake = useFetch();
    const link = `https://evil.example.com/steal?${SECRET}`;

    const error = await failure(downloadPresignedExport(link));

    expect(error.kind).toBe("unexpected_response");
    expect(fake.requests).toEqual([]);
    expect(error.message).not.toContain("evil");
    expect(error.message).not.toContain(SECRET);
  });

  it("refuses redirects", async () => {
    useFetch(
      new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }),
    );

    const error = await failure(downloadPresignedExport(LINK));

    expect(error.message).toContain("redirected");
    expect(error.message).not.toContain(HOST);
  });

  it("refuses an opaque redirect answer", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    useFetch(opaque);

    await expect(downloadPresignedExport(LINK)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("reports error statuses without the link", async () => {
    useFetch(new Response("<Error>AccessDenied</Error>", { status: 403 }));

    const error = await failure(downloadPresignedExport(LINK));

    expect(error.message).toBe(
      "The export download failed with HTTP 403 (the link may have expired). Nothing was saved.",
    );
  });

  it("refuses oversized bodies, declared or streamed", async () => {
    useFetch(
      new Response(ZIP, { status: 200, headers: { "content-length": "999" } }),
      new Response(new Uint8Array(20), { status: 200 }),
    );

    const declared = await failure(downloadPresignedExport(LINK, { maxBytes: 10 }));
    expect(declared.message).toContain("larger than 10 bytes");
    const streamed = await failure(downloadPresignedExport(LINK, { maxBytes: 10 }));
    expect(streamed.message).toContain("larger than 10 bytes");
  });

  it("maps network failures, timeouts and cancellations without the link", async () => {
    useFetch({ throws: new TypeError(`fetch failed for ${LINK}`) });
    const network = await failure(downloadPresignedExport(LINK));
    expect(network).toMatchObject({ kind: "network" });
    expect(network.message).not.toContain(SECRET);
    expect(network.cause).toBeUndefined();

    restore?.();
    useFetch("hang");
    await expect(downloadPresignedExport(LINK, { timeoutMs: 5 })).rejects.toMatchObject({
      kind: "timeout",
    });

    restore?.();
    useFetch("hang");
    const controller = new AbortController();
    const pending = downloadPresignedExport(LINK, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("maps a body that breaks off mid-stream to a network error", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50]));
        controller.error(new Error(`socket closed ${LINK}`));
      },
    });
    useFetch(new Response(broken, { status: 200 }));

    const error = await failure(downloadPresignedExport(LINK));

    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(SECRET);
  });

  it("swapPresignedFetch restores the previous fetch", () => {
    const original = presignedTransport.fetch;
    const undo = swapPresignedFetch(() => Promise.reject(new Error("fake")));
    expect(presignedTransport.fetch).not.toBe(original);
    undo();
    expect(presignedTransport.fetch).toBe(original);
  });
});
