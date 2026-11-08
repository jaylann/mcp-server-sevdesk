/**
 * Downloads a finished sevDesk export (the DATEV ZIP) from the presigned link sevDesk hands out
 * (`GET /ExportJob/jobDownloadInfo` → `link`, an Amazon S3 URL valid for 7 days). This is the only
 * request this server sends anywhere but the sevDesk API, so it is deliberately narrow:
 *
 * - **https only**, default port, no user info, and the host must be in {@link EXPORT_HOSTS}
 *   (sevDesk's export bucket on Amazon S3);
 * - **no redirects** (`redirect: "manual"`; a 3xx is refused), so the link cannot bounce the
 *   request elsewhere;
 * - **no Authorization header**: the sevDesk token never leaves for S3 (the link carries its own
 *   signature); no cookies, no credentials;
 * - **capped body** (`readCappedBody`, streamed) and a timeout;
 * - **the link is a secret**: anyone holding it can fetch the export for 7 days. It never appears
 *   in an error message, a log line or a tool result, and errors carry no `cause` that could
 *   contain it.
 *
 * Host: the live probe (2026-11-08) recorded links to exactly
 * `sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com` (also the spec's example),
 * answered without credentials with 200 `binary/octet-stream` and a ZIP. Only that host is
 * accepted ({@link EXPORT_HOSTS}).
 */
import { readCappedBody } from "./client.js";
import { SevdeskError } from "./errors.js";

/** Hosts a presigned export link may point to (recorded live, 2026-11-08). */
export const EXPORT_HOSTS: ReadonlySet<string> = new Set([
  "sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com",
]);

/** Largest export accepted by default: 100 MiB (a DATEV ZIP with document images can be big). */
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
/** Default time for the whole download. */
const EXPORT_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Test seam: the `fetch` {@link downloadPresignedExport} uses, looked up on every call. Production
 * code never changes it; tests swap it with {@link swapPresignedFetch} and must restore it. It is
 * never the global `fetch` being replaced, so nothing else is affected.
 */
export const presignedTransport: { fetch: typeof fetch } = {
  fetch: (input, init) => globalThis.fetch(input, init),
};

/** Replaces {@link presignedTransport}'s fetch; returns the function that restores the previous one. */
export function swapPresignedFetch(replacement: typeof fetch): () => void {
  const previous = presignedTransport.fetch;
  presignedTransport.fetch = replacement;
  return () => {
    presignedTransport.fetch = previous;
  };
}

export interface PresignedDownloadOptions {
  /** Defaults to {@link MAX_EXPORT_BYTES}. */
  readonly maxBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Defaults to {@link EXPORT_DOWNLOAD_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

export interface PresignedDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
}

/** Whether `link` is a URL this module would fetch (scheme, port, user info, host). */
export function isAllowedExportLink(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    (url.port === "" || url.port === "443") &&
    EXPORT_HOSTS.has(url.hostname)
  );
}

/**
 * Fetches `link` under the rules of the module doc and returns the body. Throws a
 * {@link SevdeskError} (`unexpected_response` for a refused link, redirect, error status or an
 * oversized body; `network`, `timeout` or `aborted` otherwise) whose message never contains the
 * link.
 */
export async function downloadPresignedExport(
  link: string,
  options: PresignedDownloadOptions = {},
): Promise<PresignedDownload> {
  if (!isAllowedExportLink(link)) {
    throw failure(
      "unexpected_response",
      "sevDesk returned an export download link this server does not accept (not an https " +
        "link to sevDesk's export storage). Nothing was downloaded.",
    );
  }
  const maxBytes = options.maxBytes ?? MAX_EXPORT_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? EXPORT_DOWNLOAD_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await presignedTransport.fetch(link, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "application/zip, application/octet-stream, */*" },
      signal,
    });
  } catch {
    throw abortOr(options.signal, timeout, "network", "The export download failed (network).");
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw failure(
      "unexpected_response",
      "The export download was redirected; redirects are not followed. Nothing was saved.",
    );
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    throw failure(
      "unexpected_response",
      `The export download failed with HTTP ${String(response.status)} (the link may have ` +
        "expired). Nothing was saved.",
    );
  }
  try {
    const bytes = await readCappedBody(response, maxBytes, (received) =>
      failure(
        "unexpected_response",
        `The export is larger than ${String(maxBytes)} bytes (stopped after ${String(received)}); ` +
          "nothing was saved. Export a shorter period or without document images.",
      ),
    );
    return { bytes, contentType: response.headers.get("content-type") ?? undefined };
  } catch (error) {
    if (error instanceof SevdeskError) throw error;
    throw abortOr(options.signal, timeout, "network", "The export download broke off (network).");
  }
}

function failure(kind: "unexpected_response" | "network", message: string): SevdeskError {
  return new SevdeskError({ kind, message });
}

/** The error for a failed fetch: cancelled, timed out, or `fallback`. Never carries the cause. */
function abortOr(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
  kind: "network",
  message: string,
): SevdeskError {
  if (caller?.aborted === true) {
    return new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
  if (timeout.aborted) {
    return new SevdeskError({
      kind: "timeout",
      message: "The export download did not finish in time. Nothing was saved.",
    });
  }
  return failure(kind, message);
}
