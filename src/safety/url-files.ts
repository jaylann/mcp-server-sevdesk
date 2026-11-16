/**
 * Receipt and e-invoice files from an https link (`file: "https://…"`), for the tools that take a
 * file (`FileAccess.read`, `./file-sources.ts`). The link comes from the model, so the download is
 * fenced in like the client metadata fetch of OAuth mode (`src/http/oauth/cimd.ts`):
 *
 * - off unless the operator lists hosts in `SEVDESK_FILE_URL_HOSTS`: with none, every link is
 *   refused with a message naming the setting, before any network I/O;
 * - https only, the default port, no user info, a host name (no IP literal) on that list (exact,
 *   or `*.example.com` for the subdomains of example.com), all checked before any network I/O;
 * - the host is resolved once per download and every address must be public
 *   (`./public-address.ts`); the connection goes to the checked address (`./pinned-https.ts`), so a
 *   second resolution is never used;
 * - redirects (301, 302, 303, 307, 308) are followed at most {@link MAX_REDIRECTS} times, and each
 *   target passes the same checks (https, user info, port, IP literal, list, public address); a
 *   host already resolved in this download keeps its first address. Cloud storage and supplier
 *   portals hand out links that redirect, and the list bounds where a redirect may lead;
 * - no credentials: the request carries `Accept` and `User-Agent` only, never a cookie, an
 *   `Authorization` header or the sevDesk token;
 * - status 200 only, no compressed body, a content type that fits a PDF, PNG, JPEG or XML file (or
 *   a generic one such as `application/octet-stream`) and agrees with the content, at most the
 *   caller's size limit (on `Content-Length` before the body is read, and while it streams); the
 *   kind is recognized by content like a local file's (`sniffKind`);
 * - {@link TIMEOUT_MS} for the whole download including redirects, {@link RESOLVE_TIMEOUT_MS} per
 *   resolution, and the tool call's cancellation; at most {@link MAX_ACTIVE_DOWNLOADS} downloads at
 *   once in the process, since each holds up to the size limit in memory.
 *
 * Nothing is kept: the bytes live in the tool call only, so there is nothing to release. Messages
 * are trusted text: they name the setting and the allowed hosts (the operator's configuration),
 * never the link, its path or query (a signed link carries its signature there), a redirect
 * target, an address, or anything the remote host sent.
 */
import { isIP } from "node:net";

import { SevdeskError } from "../sevdesk/errors.js";
import type { InputFile, ReadFileOptions } from "./file-access.js";
import { type LocalFileKind, sniffKind } from "./local-files.js";
import { createPinnedGet, type PinnedGet, type PinnedGetResponse } from "./pinned-https.js";
import {
  type ResolvedAddress,
  resolvePublicAddress,
  type Resolver,
  SsrfError,
  systemResolver,
} from "./public-address.js";

/** Redirects followed in one download. */
const MAX_REDIRECTS = 3;
/** The whole download, every redirect included. */
const TIMEOUT_MS = 60_000;
/** One TLS handshake. */
const CONNECT_TIMEOUT_MS = 10_000;
/** One host name resolution (the system resolver can wait much longer). */
const RESOLVE_TIMEOUT_MS = 5_000;
/** Downloads at once in this process; another one is refused until one finishes. */
const MAX_ACTIVE_DOWNLOADS = 4;
/** Largest body when a request names no limit (the callers pass theirs: 20 MiB today). */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** Most allowed hosts a message lists. */
const MAX_HOSTS_SHOWN = 10;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const READ_HEADERS = ["content-type", "content-length", "content-encoding", "location"];
const ACCEPT = "application/pdf, image/png, image/jpeg, application/xml, text/xml;q=0.9, */*;q=0.1";
const USER_AGENT = "mcp-server-sevdesk (file download)";

/** Declared content types that name one kind. */
const TYPE_KINDS: Readonly<Record<string, LocalFileKind>> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/pjpeg": "jpeg",
  "application/xml": "xml",
  "text/xml": "xml",
};

/** Declared content types that say nothing about the kind: the content decides. */
const GENERIC_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/download",
  "application/force-download",
  "application/x-download",
]);

/** Reads the file an https link names (see the module comment). */
export type UrlFileReader = (ref: string, options: ReadFileOptions) => Promise<InputFile>;

export interface UrlFileReaderOptions {
  /** `SEVDESK_FILE_URL_HOSTS`: exact host names or `*.example.com`. Empty: every link is refused. */
  readonly hosts: readonly string[];
  /** Tests: the resolver (default: the system's) and the transport (default: {@link createLinkGet}). */
  readonly resolve?: Resolver | undefined;
  readonly get?: PinnedGet | undefined;
  /** Tests: shorter limits than {@link TIMEOUT_MS} and {@link RESOLVE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  readonly resolveTimeoutMs?: number | undefined;
}

export interface LinkGetOptions {
  /** Tests only: the port to connect to (default 443), extra trusted CAs, shorter timeouts. */
  readonly port?: number | undefined;
  readonly ca?: string | Buffer | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly totalTimeoutMs?: number | undefined;
}

/** Downloads running in this process (see {@link MAX_ACTIVE_DOWNLOADS}). */
let activeDownloads = 0;

/** The body was larger than the limit (raised by the transport, mapped to a refusal here). */
class TooLargeError extends Error {
  constructor() {
    super("too large");
    this.name = "TooLargeError";
  }
}

/** The transport of a download: {@link createPinnedGet} with the headers and limits above. */
export function createLinkGet(options: LinkGetOptions = {}): PinnedGet {
  return createPinnedGet({
    accept: ACCEPT,
    userAgent: USER_AGENT,
    readHeaders: READ_HEADERS,
    maxBytes: DEFAULT_MAX_BYTES,
    tooLarge: () => new TooLargeError(),
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? TIMEOUT_MS,
    port: options.port,
    ca: options.ca,
  });
}

/** Whether `host` (a URL's lower-case host name) is on the list: exactly, or under `*.domain`. */
export function isAllowedHost(host: string, hosts: readonly string[]): boolean {
  return hosts.some((entry) =>
    entry.startsWith("*.")
      ? host.length > entry.length - 1 && host.endsWith(entry.slice(1))
      : host === entry,
  );
}

/** A reader for the links of `options.hosts` under the rules of the module comment. */
export function createUrlFileReader(options: UrlFileReaderOptions): UrlFileReader {
  const { hosts } = options;
  const resolve = options.resolve ?? systemResolver;
  const get = options.get ?? createLinkGet();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;

  async function download(first: URL, read: ReadFileOptions): Promise<InputFile> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = read.signal === undefined ? deadline : AbortSignal.any([read.signal, deadline]);
    const stopped = (): SevdeskError | undefined => {
      if (read.signal?.aborted === true) {
        return new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
      }
      return deadline.aborted
        ? refusal(
            `The download from the link did not finish within ${String(timeoutMs / 1000)} ` +
              "seconds. Try again later, or pass the file another way",
          )
        : undefined;
    };
    // One resolution per host and download: a redirect back to a host reuses its address.
    const addresses = new Map<string, ResolvedAddress>();
    let url = first;
    for (let redirects = 0; ; redirects += 1) {
      let address = addresses.get(url.hostname);
      if (address === undefined) {
        try {
          address = await resolvePublicAddress(url.hostname, (hostname) =>
            bounded(resolve(hostname), resolveTimeoutMs, signal),
          );
        } catch (error) {
          throw stopped() ?? resolveRefusal(error);
        }
        addresses.set(url.hostname, address);
      }
      let response: PinnedGetResponse;
      try {
        response = await get({
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          address,
          maxBytes: read.maxBytes,
          signal,
        });
      } catch (error) {
        if (error instanceof TooLargeError) throw tooLarge(read.maxBytes);
        throw stopped() ?? networkRefusal(error);
      }
      if (!REDIRECT_STATUSES.has(response.status)) return fileFrom(url, response, read);
      if (redirects >= MAX_REDIRECTS) {
        throw refusal(
          `The link redirects more than ${String(MAX_REDIRECTS)} times; pass the final download ` +
            "link instead",
        );
      }
      url = redirectTarget(url, response.headers["location"], hosts);
    }
  }

  return async (ref, read) => {
    if (hosts.length === 0) {
      throw refusal(
        "Files from links are off: SEVDESK_FILE_URL_HOSTS is not set (it lists the hosts " +
          "receipts and e-invoices may be downloaded from). The user or the server's operator " +
          "can set it and restart the server; until then pass the file another way",
      );
    }
    const url = parseLink(ref);
    checkLink(url, hosts, "The link");
    if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
      throw refusal(
        "Too many downloads from links are running on this server at once; try again in a moment",
      );
    }
    activeDownloads += 1;
    try {
      return await download(url, read);
    } finally {
      activeDownloads -= 1;
    }
  };
}

/** `ref` as a URL without its fragment, or a refusal. */
function parseLink(ref: string): URL {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw refusal("The link is not a valid URL");
  }
  url.hash = "";
  return url;
}

/**
 * Refuses `url` unless it is an https link on the default port, without user info, to a host name
 * on the list. `subject` starts each message ("The link", or for a redirect "The link redirects to
 * a target that"); nothing of the URL itself is put into it.
 */
function checkLink(url: URL, hosts: readonly string[], subject: string): void {
  if (url.protocol !== "https:") {
    throw refusal(`${subject} is not https; only https links are read`);
  }
  if (url.username !== "" || url.password !== "") {
    throw refusal(`${subject} carries a user name or password; links with credentials are refused`);
  }
  if (url.port !== "") {
    throw refusal(`${subject} names a port; only the default https port is used`);
  }
  const host = url.hostname;
  if (host.startsWith("[") || isIP(host) !== 0) {
    throw refusal(
      `${subject} names an IP address; only the host names in SEVDESK_FILE_URL_HOSTS are allowed`,
    );
  }
  if (!isAllowedHost(host, hosts)) {
    throw refusal(
      `${subject} is on a host outside SEVDESK_FILE_URL_HOSTS (allowed: ${hostList(hosts)}); ` +
        "the operator decides which hosts files may come from",
    );
  }
}

/** The checked target of a redirect from `from`, or a refusal. */
function redirectTarget(from: URL, location: string | undefined, hosts: readonly string[]): URL {
  if (location === undefined || location.trim() === "") {
    throw refusal("The link redirects without naming a target");
  }
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw refusal("The link redirects to a target that is not a valid URL");
  }
  next.hash = "";
  checkLink(next, hosts, "The link redirects to a target that");
  return next;
}

/** The file in a final answer, or a refusal (see the module comment). */
function fileFrom(url: URL, response: PinnedGetResponse, read: ReadFileOptions): InputFile {
  if (response.status !== 200) {
    throw refusal(
      `The link answered with HTTP ${String(response.status)}${statusHint(response.status)}`,
    );
  }
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    throw refusal("The link answered with a compressed body; only uncompressed files are read");
  }
  const declared = declaredKind(response.headers["content-type"]);
  if (declared === undefined) {
    throw refusal(
      `The link did not answer with a ${kindList(read.kinds)} file but with another content ` +
        "type (a sign-in or error page looks like this). Check that the link downloads the file " +
        "itself",
    );
  }
  const declaredLength = Number(response.headers["content-length"] ?? "0");
  if (declaredLength > read.maxBytes || response.body.length > read.maxBytes) {
    throw tooLarge(read.maxBytes);
  }
  const kind = sniffKind(response.body);
  if (kind === undefined || !read.kinds.includes(kind)) {
    throw refusal(
      `The file at the link is not an accepted file type (accepted: ${kindList(read.kinds)}; ` +
        "checked by content)",
    );
  }
  if (declared !== "generic" && declared !== kind) {
    throw refusal("The file at the link does not match the content type the link declared");
  }
  return {
    name: linkFileName(url, kind),
    kind,
    // A plain copy, like a local read: no view into the transport's buffers.
    bytes: new Uint8Array(response.body),
    source: "url",
    host: url.hostname,
  };
}

/** The kind a `Content-Type` names, `generic` when it names none, `undefined` when it does not fit. */
function declaredKind(header: string | undefined): LocalFileKind | "generic" | undefined {
  const type = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "" || GENERIC_TYPES.has(type)) return "generic";
  const kind = TYPE_KINDS[type];
  if (kind !== undefined) return kind;
  return /^application\/[a-z0-9.+-]+\+xml$/.test(type) ? "xml" : undefined;
}

/**
 * The name a downloaded file is uploaded under: the last segment of the link's path, decoded and
 * cleaned to `[A-Za-z0-9._-]`, at most 80 characters, with the extension of the kind its content
 * shows (`download.pdf` when nothing usable is left). Never used as a path.
 */
function linkFileName(url: URL, kind: LocalFileKind): string {
  const extension = kind === "jpeg" ? "jpg" : kind;
  const segment = url.pathname.split("/").pop() ?? "";
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A broken escape stays as it is and is cleaned below.
  }
  const stem = decoded
    .replace(/\.(?:pdf|png|jpe?g|xml)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .slice(0, 80)
    .replace(/[._-]+$/, "");
  return `${stem === "" ? "download" : stem}.${extension}`;
}

/** What a status usually means for a download link (trusted text; the status is a number). */
function statusHint(status: number): string {
  if (status === 401 || status === 403) {
    return " (the link needs a sign-in or has expired; this server sends no credentials)";
  }
  if (status === 404 || status === 410) return " (not found, or the link has expired)";
  return "";
}

function resolveRefusal(error: unknown): SevdeskError {
  if (error instanceof SsrfError && error.reason === "blocked_address") {
    return refusal(
      "The link's host resolves to an address this server does not connect to (private, " +
        "loopback, link-local, CGNAT, multicast or another non-public range)",
    );
  }
  return refusal("The link's host could not be resolved; check the link or try again later");
}

/**
 * A failed connection or transfer. Only Node's own error code is shown (`ECONNREFUSED`,
 * `CERT_HAS_EXPIRED`, …), cleaned to its alphabet; the message may hold addresses or remote text.
 */
function networkRefusal(error: unknown): SevdeskError {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? ` (${error.code})`
      : "";
  return refusal(
    `The file could not be downloaded from the link${code}: a network or certificate error. ` +
      "Check the link, or try again later",
  );
}

function tooLarge(maxBytes: number): SevdeskError {
  return refusal(`The file at the link is larger than the limit here of ${String(maxBytes)} bytes`);
}

/** `promise`, or a rejection after `ms` or when `signal` aborts. */
function bounded<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, ms);
    const onAbort = (): void => {
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** The allowed hosts for a message: the operator's own configuration, at most ten of them. */
function hostList(hosts: readonly string[]): string {
  const shown = hosts.slice(0, MAX_HOSTS_SHOWN).join(", ");
  const more = hosts.length - MAX_HOSTS_SHOWN;
  return more > 0 ? `${shown} and ${String(more)} more` : shown;
}

function kindList(kinds: readonly LocalFileKind[]): string {
  return kinds.map((kind) => kind.toUpperCase()).join(", ");
}

function refusal(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. Nothing was sent to sevDesk.`,
  });
}
