/**
 * Configuration of the HTTP mode (`--http`): reads and validates the `SEVDESK_HTTP_*` and
 * `SEVDESK_OAUTH_*` variables on top of the shared settings (`readSettings`), and reports every
 * problem at once in one {@link ConfigError}. Nothing here prints: warnings are returned for the
 * caller to log.
 *
 * The rules keep a misconfigured server from starting rather than serving insecurely: an auth mode
 * is mandatory, a non-loopback bind needs the public https origin (all URLs the server prints and
 * all Host/Origin checks derive from it), bearer secrets must be long and random, OAuth needs the
 * server secret and an account allowlist, and the server's disk is never shared between OAuth
 * accounts. Remote file transfer (`SEVDESK_HTTP_FILES`, upload pages and download links) is on by
 * default with a byte budget and a lifetime. See `docs/remote.md` for the variables.
 *
 * Invariant: no problem or warning contains a secret value.
 */
import { accessSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { localhostAllowedHostnames } from "@modelcontextprotocol/server";

import {
  type Config,
  ConfigError,
  type ConfirmMode,
  type Deployment,
  type Env,
  nonEmpty,
  readEnum,
  readList,
  readSecret,
  readSettings,
  type Settings,
  sevdeskTokenProblem,
} from "../config.js";
import { decodeSecret } from "./keys.js";
import type { HttpAuthMode, HttpConfig, HttpFilesConfig, OAuthSettings } from "./types.js";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 8080;
/** Most trusted reverse-proxy hops. */
const MAX_TRUST_PROXY = 5;
/** Bearer secrets: shortest length, fewest distinct characters, most values (rotation). */
const MIN_BEARER_LENGTH = 32;
const MIN_BEARER_DISTINCT = 16;
const MAX_BEARER_TOKENS = 2;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Lifetimes (seconds) with their bounds. */
const TTL_RULES = {
  SEVDESK_OAUTH_ACCESS_TTL: { fallback: HOUR, min: 5 * MINUTE, max: DAY, bounds: "5m and 24h" },
  SEVDESK_OAUTH_REFRESH_IDLE_TTL: {
    fallback: 14 * DAY,
    min: DAY,
    max: 90 * DAY,
    bounds: "1d and 90d",
  },
  SEVDESK_OAUTH_GRANT_TTL: { fallback: 90 * DAY, min: DAY, max: 365 * DAY, bounds: "1d and 365d" },
  SEVDESK_HTTP_FILES_TTL: {
    fallback: 30 * MINUTE,
    min: 5 * MINUTE,
    max: DAY,
    bounds: "5m and 24h",
  },
} as const;

const MEBIBYTE = 1024 * 1024;
/** `SEVDESK_HTTP_FILES_MAX_MB`: bounds, and the defaults with and without a state directory. */
const FILES_MAX_MB = { min: 32, max: 4096, withStateDir: 256, inMemory: 64 } as const;

const GENERATE_HINT = "generate one with `mcp-server-sevdesk generate-secret`";

/** Hostnames a public URL may use with plain http. */
const LOOPBACK_URL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A DNS hostname (lower case, as `readList` returns it). */
const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** A sevDesk account id in `SEVDESK_OAUTH_ACCOUNTS` (same rule as the CLI). */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface LoadHttpConfigDeps {
  /** Reads `*_FILE` secrets (default: `fs.readFileSync`, utf8). */
  readonly readFile?: (path: string) => string;
  /**
   * Creates the state directory (mode 0700) when missing and checks that it is a writable
   * directory; returns a problem (never a secret) or `undefined`. Default: {@link prepareStateDir}.
   */
  readonly prepareStateDir?: (path: string) => string | undefined;
}

/** Result of {@link loadHttpConfig}. */
export interface LoadedHttpConfig {
  /** Shared settings; `confirmOpen` is off unless `SEVDESK_CONFIRM_OPEN` was set explicitly. */
  readonly settings: Settings;
  readonly http: HttpConfig;
  /**
   * Bearer mode: the config of the one account served (`deployment.kind: "http"`, without
   * `account`, which the caller adds after the startup `/SevClient` lookup). `undefined` in OAuth
   * mode, where the resolver derives one config per account. When no public URL is set and the
   * port is 0 (tests), its origin names port 0: rebuild the deployment with {@link httpDeployment}
   * once listening.
   */
  readonly fixed: Config | undefined;
  /** Startup warnings (no secrets), for the caller to log. */
  readonly warnings: readonly string[];
  /** Every secret value read, in the encodings that could show up in text: for log redaction. */
  readonly secrets: readonly string[];
}

/**
 * Reads and validates the HTTP-mode configuration. Throws {@link ConfigError} listing every
 * problem; may create `SEVDESK_HTTP_STATE_DIR`.
 */
export function loadHttpConfig(env: Env, deps: LoadHttpConfigDeps = {}): LoadedHttpConfig {
  const readFile = deps.readFile ?? defaultReadFile;
  const problems: string[] = [];
  const warnings: string[] = [];
  const secrets: string[] = [];

  const auth = readAuthMode(env, problems);
  const base = readSettings(env, problems);
  const host = readHttpHost(env, problems);
  const port = readHttpPort(env, problems);
  const loopbackBind = isLoopbackHost(host);
  const publicUrl = readPublicUrl(env, problems);

  if (
    publicUrl === undefined &&
    !loopbackBind &&
    nonEmpty(env["SEVDESK_HTTP_PUBLIC_URL"]) === undefined
  ) {
    problems.push(
      `SEVDESK_HTTP_HOST=${host} is not a loopback address, so SEVDESK_HTTP_PUBLIC_URL must be set ` +
        "to the https origin clients use (for example https://mcp.example.com): every URL the " +
        "server hands out and every Host and Origin check derives from it.",
    );
  }

  if (!loopbackBind && publicUrl !== undefined && isLoopbackHost(publicUrl.hostname)) {
    warnings.push(
      `SEVDESK_HTTP_HOST=${host} listens on every network it is reachable from, but ` +
        `SEVDESK_HTTP_PUBLIC_URL=${publicUrl.origin} is a loopback URL: anyone who can reach the ` +
        "port can use the server (the Host check only asks for that loopback name)" +
        (publicUrl.origin.startsWith("http:")
          ? ", and bearer tokens, OAuth codes and cookies travel in clear text"
          : "") +
        ". Publish the port on 127.0.0.1 only (docker run -p 127.0.0.1:8080:8080), or put an " +
        "https reverse proxy in front and set SEVDESK_HTTP_PUBLIC_URL to its URL.",
    );
  }

  // HTTP mode never opens a browser on its own unless asked to, and never on a public bind.
  const confirmOpenSet = nonEmpty(env["SEVDESK_CONFIRM_OPEN"]) !== undefined;
  const confirmOpen = confirmOpenSet && base.confirmOpen;
  if (confirmOpen && !loopbackBind) {
    problems.push(
      "SEVDESK_CONFIRM_OPEN=1 opens approval pages in a browser on the server's own machine, " +
        `which a server bound to ${host} has no use for. Remove it: approvals are made in the ` +
        "browser inbox (SEVDESK_CONFIRM=browser).",
    );
  }
  const settings: Settings = { ...base, confirmOpen };

  const stateDir = readStateDir(env, problems, deps.prepareStateDir ?? prepareStateDir);
  const trustProxy = readTrustProxy(env, problems);
  const allowedHosts = readAllowedHosts(env, problems, publicUrl, loopbackBind ? host : undefined);
  const allowedOrigins = readAllowedOrigins(env, problems, publicUrl, loopbackBind);

  const secret = readServerSecret(env, readFile, problems, auth === "oauth", secrets, warnings);
  const previousSecret = readPreviousSecret(env, readFile, problems, secret, secrets, warnings);

  // Profiles and the OS keychain are for local (stdio) installs: a container has no keychain,
  // and an HTTP server keeps one source of configuration, its environment.
  for (const name of ["SEVDESK_PROFILE", "SEVDESK_PROFILES_PATH", "SEVDESK_API_TOKEN_KEYCHAIN"]) {
    if (nonEmpty(env[name]) !== undefined) {
      problems.push(
        `${name} works only over stdio, not with --http. Configure the HTTP server through its ` +
          "environment (SEVDESK_API_TOKEN or SEVDESK_API_TOKEN_FILE in bearer mode).",
      );
    }
  }

  let token: string | undefined;
  let bearerTokens: readonly string[] = [];
  let oauth: OAuthSettings | undefined;
  if (auth === "bearer") {
    token = readBearerSevdeskToken(env, readFile, problems);
    if (token !== undefined) secrets.push(token);
    bearerTokens = readBearerTokens(env, readFile, problems, token, warnings);
    secrets.push(...bearerTokens);
  } else if (auth === "oauth") {
    if (publicUrl === undefined && nonEmpty(env["SEVDESK_HTTP_PUBLIC_URL"]) === undefined) {
      problems.push(
        "SEVDESK_HTTP_AUTH=oauth needs SEVDESK_HTTP_PUBLIC_URL (the https origin clients use, " +
          "for example https://mcp.example.com): the OAuth issuer and resource are built from it.",
      );
    }
    for (const name of ["SEVDESK_FILE_DIRS", "SEVDESK_OUTPUT_DIR"]) {
      if (nonEmpty(env[name]) !== undefined) {
        problems.push(
          `${name} cannot be used with SEVDESK_HTTP_AUTH=oauth: every connected account would ` +
            "share the server's disk. Remove it: users upload receipts on the server's upload " +
            "pages and download exports through links instead (SEVDESK_HTTP_FILES, on by " +
            "default). Bearer mode keeps it, since it serves one account.",
        );
      }
    }
    oauth = readOAuthSettings(env, problems, warnings);
    if (stateDir === undefined && nonEmpty(env["SEVDESK_HTTP_STATE_DIR"]) === undefined) {
      warnings.push(
        "SEVDESK_HTTP_STATE_DIR is not set: OAuth grants live in memory only, so every restart " +
          "signs all clients out. Set it to a persistent directory (the Docker image uses /data).",
      );
    }
    if (
      nonEmpty(env["SEVDESK_API_TOKEN"]) !== undefined ||
      nonEmpty(env["SEVDESK_API_TOKEN_FILE"]) !== undefined
    ) {
      warnings.push(
        "SEVDESK_API_TOKEN is not used with SEVDESK_HTTP_AUTH=oauth (each user pastes their own " +
          "token on the consent page). Remove it from the server's environment.",
      );
    }
    if (
      nonEmpty(env["SEVDESK_HTTP_BEARER_TOKEN"]) !== undefined ||
      nonEmpty(env["SEVDESK_HTTP_BEARER_TOKEN_FILE"]) !== undefined
    ) {
      warnings.push("SEVDESK_HTTP_BEARER_TOKEN is not used with SEVDESK_HTTP_AUTH=oauth.");
    }
  }

  const files = readFiles(env, problems, warnings, {
    stateDir,
    plainHttp: (publicUrl?.origin ?? "http:").startsWith("http:"),
    anyAccount: oauth?.accounts === "any",
  });

  if (
    settings.confirm === "elicit" &&
    (settings.allowedTiers.has("commit") || settings.allowedTiers.has("external"))
  ) {
    warnings.push(
      "SEVDESK_CONFIRM=elicit with the commit or external tier: 2025-era clients such as " +
        "claude.ai cannot be asked for confirmation over stateless HTTP, so their commit and " +
        "external calls will be refused. Set SEVDESK_CONFIRM=browser to approve them in the " +
        "server's approval inbox (/approvals).",
    );
  }

  if (problems.length > 0 || auth === undefined) {
    throw new ConfigError(problems);
  }

  const http: HttpConfig = {
    auth,
    host,
    port,
    publicOrigin: publicUrl?.origin,
    allowedHosts,
    allowedOrigins,
    trustProxy,
    stateDir,
    bearerTokens,
    secret,
    previousSecret,
    oauth,
    files,
  };
  const fixed: Config | undefined =
    auth === "bearer" && token !== undefined
      ? {
          ...settings,
          token,
          deployment: httpDeployment(
            "bearer",
            publicUrl?.origin ?? loopbackOrigin(host, port),
            settings.confirm,
            files,
          ),
        }
      : undefined;
  return { settings, http, fixed, warnings, secrets };
}

/**
 * The `deployment` of a config served over HTTP at `origin`: the approval inbox URL is set when
 * `SEVDESK_CONFIRM=browser`, and `files` when remote file transfer is on.
 */
export function httpDeployment(
  auth: HttpAuthMode,
  origin: string,
  confirm: ConfirmMode,
  files?: HttpFilesConfig,
): Deployment {
  return {
    kind: "http",
    auth,
    publicOrigin: origin,
    approvalsUrl: confirm === "browser" ? `${origin}/approvals` : undefined,
    ...(files === undefined ? {} : { files: { ttlSeconds: files.ttlSeconds } }),
  };
}

interface FilesContext {
  /** The state directory, when one is set and usable. */
  readonly stateDir: string | undefined;
  /** Whether the server is reached over plain http (a loopback origin). */
  readonly plainHttp: boolean;
  /** `SEVDESK_OAUTH_ACCOUNTS=any`. */
  readonly anyAccount: boolean;
}

/**
 * `SEVDESK_HTTP_FILES` (`on` or `off`, default on), `SEVDESK_HTTP_FILES_MAX_MB` (32 to 4096;
 * default 256 with a state directory, 64 in memory) and `SEVDESK_HTTP_FILES_TTL` (5m to 24h,
 * default 30m). Warns about plain http (the session cookie reaches every local server on the host),
 * files held in memory, and a server open to any account.
 */
function readFiles(
  env: Env,
  problems: string[],
  warnings: string[],
  context: FilesContext,
): HttpFilesConfig | undefined {
  const mode = readEnum<"on" | "off">(env, "SEVDESK_HTTP_FILES", ["on", "off"], "on", problems);
  const tuned = ["SEVDESK_HTTP_FILES_MAX_MB", "SEVDESK_HTTP_FILES_TTL"].filter(
    (name) => nonEmpty(env[name]) !== undefined,
  );
  if (mode === "off") {
    if (tuned.length > 0 && nonEmpty(env["SEVDESK_HTTP_FILES"]) !== undefined) {
      warnings.push(`${tuned.join(" and ")} have no effect with SEVDESK_HTTP_FILES=off.`);
    }
    return undefined;
  }
  const maxMb = readFilesMaxMb(env, problems, context.stateDir !== undefined);
  const ttlSeconds = readTtl(env, "SEVDESK_HTTP_FILES_TTL", problems);
  if (context.plainHttp) {
    warnings.push(
      "SEVDESK_HTTP_FILES=on over plain http: browsers send the sign-in cookie of the upload and " +
        "download pages to every server on this host name, whatever its port, so another local " +
        "server could use them as you. Use https (a tunnel or reverse proxy) beyond local " +
        "testing, or set SEVDESK_HTTP_FILES=off.",
    );
  }
  if (context.stateDir === undefined) {
    warnings.push(
      `SEVDESK_HTTP_FILES keeps uploaded files and download links in memory (up to ` +
        `${String(maxMb)} MB, SEVDESK_HTTP_FILES_MAX_MB). Set SEVDESK_HTTP_STATE_DIR to keep ` +
        "them on disk instead (encrypted, removed at every restart), or lower the limit if " +
        "memory is tight.",
    );
  }
  if (context.anyAccount) {
    warnings.push(
      "SEVDESK_OAUTH_ACCOUNTS=any with SEVDESK_HTTP_FILES=on: the server briefly holds the " +
        "receipts and exports of every account that connects (each up to " +
        "SEVDESK_HTTP_FILES_TTL, encrypted). Set SEVDESK_HTTP_FILES=off if that is not wanted.",
    );
  }
  return { maxBytes: maxMb * MEBIBYTE, ttlSeconds };
}

function readFilesMaxMb(env: Env, problems: string[], withStateDir: boolean): number {
  const name = "SEVDESK_HTTP_FILES_MAX_MB";
  const fallback = withStateDir ? FILES_MAX_MB.withStateDir : FILES_MAX_MB.inMemory;
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= FILES_MAX_MB.min && value <= FILES_MAX_MB.max)) {
    problems.push(
      `${name}: expected a whole number of megabytes between ${String(FILES_MAX_MB.min)} and ` +
        `${String(FILES_MAX_MB.max)}, got "${raw}".`,
    );
    return fallback;
  }
  return value;
}

/** `http://<host>:<port>` for a loopback bind without a public URL (IPv6 in brackets). */
export function loopbackOrigin(host: string, port: number): string {
  const name = isIP(host) === 6 ? `[${host}]` : host;
  return new URL(`http://${name}:${String(port)}`).origin;
}

/** Whether `host` (a bind address or hostname, without brackets) is a loopback address. */
export function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (value === "localhost" || value === "::1") return true;
  const v4 = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/**
 * `SEVDESK_HTTP_HOST` (default 127.0.0.1): an IP address (IPv6 with or without brackets) or a
 * hostname.
 */
export function readHttpHost(env: Env, problems: string[]): string {
  const raw = nonEmpty(env["SEVDESK_HTTP_HOST"]);
  if (raw === undefined) return DEFAULT_HTTP_HOST;
  const value = raw.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (isIP(value) !== 0 || DNS_NAME.test(value)) return value;
  problems.push(
    `SEVDESK_HTTP_HOST: expected an IP address or hostname such as 127.0.0.1 or 0.0.0.0, got "${raw}".`,
  );
  return DEFAULT_HTTP_HOST;
}

/** `SEVDESK_HTTP_PORT`, else `PORT` (set by most platforms), else 8080; 0–65535. */
export function readHttpPort(env: Env, problems: string[]): number {
  const name = nonEmpty(env["SEVDESK_HTTP_PORT"]) !== undefined ? "SEVDESK_HTTP_PORT" : "PORT";
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return DEFAULT_HTTP_PORT;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(port >= 0 && port <= 65_535)) {
    problems.push(`${name}: expected a port number between 0 and 65535, got "${raw}".`);
    return DEFAULT_HTTP_PORT;
  }
  return port;
}

/**
 * Parses a duration: `30m`, `1h`, `14d`, `90s` or a plain number of seconds. Returns seconds, or
 * `undefined` when malformed.
 */
export function parseDuration(raw: string): number | undefined {
  const match = /^(\d{1,9})([smhd]?)$/i.exec(raw.trim());
  if (match === null) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  const factor = unit === "m" ? MINUTE : unit === "h" ? HOUR : unit === "d" ? DAY : 1;
  return Number(match[1]) * factor;
}

/** Bits per character a value may fall short of a random string's entropy before it is suspect. */
const ENTROPY_MARGIN_BITS = 0.75;
/** An ascending run this long (`abcdefgh`, `12345678`) marks a value as typed, not generated. */
const ASCENDING_RUN = 8;

/**
 * Whether `value` looks chosen by a person (a passphrase, a pattern) rather than produced by a
 * random generator: its per-character Shannon entropy falls more than {@link ENTROPY_MARGIN_BITS}
 * below what a random string of the same length over the same alphabet (hex, base64(url), or
 * printable ASCII) has on average, or it contains a long ascending run. Calibrated so random
 * values of 32 to 128 characters are never flagged in 100 000 samples each, while passphrases such
 * as `ThisIsMyServerSecretForTheSevdeskMcpServer2026` are. A heuristic for a warning only.
 */
export function looksHumanChosen(value: string): boolean {
  const alphabet = /^(?:[0-9a-f]+|[0-9A-F]+)$/.test(value)
    ? 16
    : /^[A-Za-z0-9+/_=-]+$/.test(value)
      ? 64
      : 94;
  if (shannonEntropy(value) < expectedEntropy(value.length, alphabet) - ENTROPY_MARGIN_BITS) {
    return true;
  }
  let run = 1;
  for (let index = 1; index < value.length; index += 1) {
    run = value.charCodeAt(index) === value.charCodeAt(index - 1) + 1 ? run + 1 : 1;
    if (run >= ASCENDING_RUN) return true;
  }
  return false;
}

/** Per-character Shannon entropy of `value` (bits). */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The expected per-character Shannon entropy of `n` characters drawn uniformly from `k` symbols:
 * `k · Σ_j P(count = j) · −(j/n)·log2(j/n)`, with `count ~ Binomial(n, 1/k)`.
 */
function expectedEntropy(n: number, k: number): number {
  const p = 1 / k;
  let logBinomial = 0;
  let sum = 0;
  for (let j = 1; j <= n; j += 1) {
    logBinomial += Math.log(n - j + 1) - Math.log(j);
    const probability = Math.exp(logBinomial + j * Math.log(p) + (n - j) * Math.log1p(-p));
    sum -= probability * (j / n) * Math.log2(j / n);
  }
  return k * sum;
}

function passphraseWarning(which: string): string {
  return (
    `${which} looks like a passphrase or pattern rather than random output, which makes it ` +
    `guessable offline. Replace it with the output of \`mcp-server-sevdesk generate-secret\`.`
  );
}

/**
 * Every secret in the encodings that could show up in text, for log redaction: the raw values
 * plus hex, base64 and base64url of decoded secrets.
 */
function secretEncodings(raw: string, decoded: Uint8Array): string[] {
  const bytes = Buffer.from(decoded);
  return [raw, bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")];
}

function readAuthMode(env: Env, problems: string[]): HttpAuthMode | undefined {
  if (nonEmpty(env["SEVDESK_HTTP_AUTH"]) === undefined) {
    problems.push(
      "SEVDESK_HTTP_AUTH is not set. The HTTP mode never runs without authentication: set it to " +
        "bearer (one shared secret, for your own clients) or oauth (sign-in from claude.ai and " +
        "other OAuth clients). See docs/remote.md.",
    );
    return undefined;
  }
  const before = problems.length;
  const mode = readEnum<HttpAuthMode | "">(
    env,
    "SEVDESK_HTTP_AUTH",
    ["bearer", "oauth"],
    "",
    problems,
  );
  return problems.length > before || mode === "" ? undefined : mode;
}

interface PublicUrl {
  /** `scheme://host[:port]`, no trailing slash. */
  readonly origin: string;
  /** Hostname as in `Host` headers (IPv6 in brackets). */
  readonly hostname: string;
}

function readPublicUrl(env: Env, problems: string[]): PublicUrl | undefined {
  const raw = nonEmpty(env["SEVDESK_HTTP_PUBLIC_URL"]);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not echoed: a malformed URL may still carry credentials.
    problems.push(
      "SEVDESK_HTTP_PUBLIC_URL is not a valid URL (expected e.g. https://mcp.example.com).",
    );
    return undefined;
  }
  const before = problems.length;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    problems.push("SEVDESK_HTTP_PUBLIC_URL must be an https URL such as https://mcp.example.com.");
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("SEVDESK_HTTP_PUBLIC_URL must not contain a username or password.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) {
    problems.push(
      "SEVDESK_HTTP_PUBLIC_URL must be the origin only, such as https://mcp.example.com, without " +
        "a path, query or fragment: the MCP endpoint is <origin>/mcp.",
    );
  }
  if (url.protocol === "http:" && !LOOPBACK_URL_HOSTS.has(url.hostname)) {
    problems.push(
      "SEVDESK_HTTP_PUBLIC_URL must use https unless its host is localhost, 127.0.0.1 or [::1]: " +
        "bearer tokens, OAuth codes and cookies would otherwise travel in clear text.",
    );
  }
  return problems.length > before ? undefined : { origin: url.origin, hostname: url.hostname };
}

function readTrustProxy(env: Env, problems: string[]): number {
  const raw = nonEmpty(env["SEVDESK_HTTP_TRUST_PROXY"]);
  if (raw === undefined) return 0;
  if (!/^\d$/.test(raw) || Number(raw) > MAX_TRUST_PROXY) {
    problems.push(
      `SEVDESK_HTTP_TRUST_PROXY: expected the number of reverse proxies in front of the server ` +
        `(0 to ${String(MAX_TRUST_PROXY)}), got "${raw}".`,
    );
    return 0;
  }
  return Number(raw);
}

function readAllowedHosts(
  env: Env,
  problems: string[],
  publicUrl: PublicUrl | undefined,
  loopbackBindHost: string | undefined,
): string[] {
  const hosts = new Set<string>();
  if (publicUrl !== undefined) hosts.add(publicUrl.hostname);
  if (loopbackBindHost !== undefined) {
    for (const name of localhostAllowedHostnames()) hosts.add(name);
    hosts.add(isIP(loopbackBindHost) === 6 ? `[${loopbackBindHost}]` : loopbackBindHost);
  }
  const invalid: string[] = [];
  for (const entry of readList(env["SEVDESK_HTTP_ALLOWED_HOSTS"])) {
    if (isHostname(entry)) hosts.add(entry);
    else invalid.push(entry);
  }
  if (invalid.length > 0) {
    problems.push(
      `SEVDESK_HTTP_ALLOWED_HOSTS: expected hostnames without scheme or port (IPv6 in brackets), ` +
        `got ${invalid.map((entry) => JSON.stringify(entry)).join(", ")}.`,
    );
  }
  return [...hosts];
}

function readAllowedOrigins(
  env: Env,
  problems: string[],
  publicUrl: PublicUrl | undefined,
  loopbackBind: boolean,
): string[] {
  const origins = new Set<string>();
  if (publicUrl !== undefined) origins.add(publicUrl.origin);
  if (loopbackBind) {
    for (const name of localhostAllowedHostnames()) origins.add(`http://${name}`);
  }
  const invalid: string[] = [];
  for (const entry of readList(env["SEVDESK_HTTP_ALLOWED_ORIGINS"])) {
    const origin = parseOrigin(entry);
    if (origin === undefined) invalid.push(entry);
    else origins.add(origin);
  }
  if (invalid.length > 0) {
    problems.push(
      "SEVDESK_HTTP_ALLOWED_ORIGINS: expected origins such as https://app.example.com (scheme " +
        `and host, no path), got ${invalid.map((entry) => JSON.stringify(entry)).join(", ")}.`,
    );
  }
  return [...origins];
}

function parseOrigin(entry: string): string | undefined {
  try {
    const url = new URL(entry);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin === entry.replace(/\/$/, "") ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isHostname(entry: string): boolean {
  if (/^\[[0-9a-f:.]+\]$/.test(entry)) return isIP(entry.slice(1, -1)) === 6;
  return isIP(entry) === 4 || DNS_NAME.test(entry);
}

function readStateDir(
  env: Env,
  problems: string[],
  prepare: (path: string) => string | undefined,
): string | undefined {
  const raw = nonEmpty(env["SEVDESK_HTTP_STATE_DIR"]);
  if (raw === undefined) return undefined;
  if (!isAbsolute(raw)) {
    problems.push(`SEVDESK_HTTP_STATE_DIR must be an absolute path, got ${JSON.stringify(raw)}.`);
    return undefined;
  }
  const problem = prepare(raw);
  if (problem !== undefined) {
    problems.push(problem);
    return undefined;
  }
  return raw;
}

/**
 * Creates `path` with mode 0700 when it does not exist yet, then checks that it is a directory
 * this process can write to (a read-only volume or another owner fails here, not at the first
 * consent).
 */
export function prepareStateDir(path: string): string | undefined {
  const name = "SEVDESK_HTTP_STATE_DIR";
  let exists = true;
  try {
    if (!statSync(path).isDirectory()) return `${name}: ${path} exists but is not a directory.`;
  } catch {
    exists = false;
  }
  if (!exists) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      return `${name}: cannot create ${path}. Create it, or mount a writable volume there.`;
    }
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return (
      `${name}: ${path} is not writable by this process. Mount a writable volume there ` +
      "(the Docker image runs as uid 65532)."
    );
  }
  return undefined;
}

function readServerSecret(
  env: Env,
  readFile: (path: string) => string,
  problems: string[],
  required: boolean,
  secrets: string[],
  warnings: string[],
): Uint8Array | undefined {
  const raw = readSecret(env, "SEVDESK_HTTP_SECRET", readFile, problems, {
    required,
    missing:
      "SEVDESK_HTTP_AUTH=oauth needs SEVDESK_HTTP_SECRET (or SEVDESK_HTTP_SECRET_FILE): every " +
      `token the server issues is sealed with it; ${GENERATE_HINT}.`,
    validate: (value) =>
      decodeSecret(value) === undefined
        ? "SEVDESK_HTTP_SECRET must be at least 32 random bytes, hex or base64url encoded; " +
          `${GENERATE_HINT}.`
        : undefined,
  });
  const decoded = raw === undefined ? undefined : decodeSecret(raw);
  if (raw !== undefined && decoded !== undefined) {
    secrets.push(...secretEncodings(raw, decoded));
    if (looksHumanChosen(raw)) warnings.push(passphraseWarning("SEVDESK_HTTP_SECRET"));
  }
  return decoded;
}

function readPreviousSecret(
  env: Env,
  readFile: (path: string) => string,
  problems: string[],
  current: Uint8Array | undefined,
  secrets: string[],
  warnings: string[],
): Uint8Array | undefined {
  const raw = readSecret(env, "SEVDESK_HTTP_SECRET_PREVIOUS", readFile, problems, {
    required: false,
    validate: (value) =>
      decodeSecret(value) === undefined
        ? "SEVDESK_HTTP_SECRET_PREVIOUS must be the former SEVDESK_HTTP_SECRET (at least 32 " +
          "random bytes, hex or base64url encoded)."
        : undefined,
  });
  const decoded = raw === undefined ? undefined : decodeSecret(raw);
  if (raw === undefined || decoded === undefined) return undefined;
  secrets.push(...secretEncodings(raw, decoded));
  if (looksHumanChosen(raw)) warnings.push(passphraseWarning("SEVDESK_HTTP_SECRET_PREVIOUS"));
  if (current === undefined) {
    if (
      nonEmpty(env["SEVDESK_HTTP_SECRET"]) === undefined &&
      nonEmpty(env["SEVDESK_HTTP_SECRET_FILE"]) === undefined
    ) {
      problems.push("SEVDESK_HTTP_SECRET_PREVIOUS is set without SEVDESK_HTTP_SECRET.");
    }
    return undefined;
  }
  if (Buffer.from(decoded).equals(Buffer.from(current))) {
    problems.push(
      "SEVDESK_HTTP_SECRET_PREVIOUS must differ from SEVDESK_HTTP_SECRET (it is the secret being " +
        "rotated out).",
    );
    return undefined;
  }
  return decoded;
}

function readBearerSevdeskToken(
  env: Env,
  readFile: (path: string) => string,
  problems: string[],
): string | undefined {
  return readSecret(env, "SEVDESK_API_TOKEN", readFile, problems, {
    required: true,
    missing:
      "SEVDESK_API_TOKEN is not set. Bearer mode serves one sevDesk account: create an API token " +
      "in sevDesk under Settings → Users → API token (ideally for a dedicated user) and set " +
      "SEVDESK_API_TOKEN or SEVDESK_API_TOKEN_FILE.",
    validate: (value) => sevdeskTokenProblem(value),
  });
}

function readBearerTokens(
  env: Env,
  readFile: (path: string) => string,
  problems: string[],
  sevdeskToken: string | undefined,
  warnings: string[],
): string[] {
  const name = "SEVDESK_HTTP_BEARER_TOKEN";
  const raw = readSecret(env, name, readFile, problems, {
    required: true,
    missing:
      `SEVDESK_HTTP_AUTH=bearer needs ${name} (or ${name}_FILE): a random value of at least ` +
      `${String(MIN_BEARER_LENGTH)} characters that clients send as "Authorization: Bearer ` +
      `<value>"; ${GENERATE_HINT}.`,
  });
  if (raw === undefined) return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const before = problems.length;
  if (values.length > MAX_BEARER_TOKENS) {
    problems.push(
      `${name}: at most ${String(MAX_BEARER_TOKENS)} comma-separated values (the current one ` +
        "and, while rotating, the previous one).",
    );
  }
  values.forEach((value, index) => {
    const which = values.length > 1 ? `value ${String(index + 1)} of ${name}` : name;
    if (/\s/.test(value)) {
      problems.push(`${which} contains whitespace; use a value without spaces or line breaks.`);
    } else if (value.length < MIN_BEARER_LENGTH) {
      problems.push(
        `${which} is too short: use at least ${String(MIN_BEARER_LENGTH)} random characters ` +
          `(${GENERATE_HINT}).`,
      );
    } else if (new Set(value).size < MIN_BEARER_DISTINCT) {
      problems.push(`${which} is not random enough: ${GENERATE_HINT}.`);
    } else if (looksHumanChosen(value)) {
      warnings.push(passphraseWarning(which));
    }
    if (sevdeskToken !== undefined && value === sevdeskToken) {
      problems.push(
        `${which} must differ from SEVDESK_API_TOKEN: the bearer value is handed to MCP clients, ` +
          "the sevDesk token must stay on the server.",
      );
    }
  });
  return problems.length > before ? [] : values;
}

/** Below this access-token lifetime, startup warns (clients refresh 5 minutes early). */
const SHORT_ACCESS_TTL_SECONDS = 10 * 60;

function readOAuthSettings(
  env: Env,
  problems: string[],
  warnings: string[],
): OAuthSettings | undefined {
  const before = problems.length;
  const accounts = readAccounts(env, problems, warnings);
  const clients = readClients(env, problems, warnings);
  const accessTtlSeconds = readTtl(env, "SEVDESK_OAUTH_ACCESS_TTL", problems);
  if (accessTtlSeconds < SHORT_ACCESS_TTL_SECONDS) {
    warnings.push(
      "SEVDESK_OAUTH_ACCESS_TTL is under 10 minutes. Clients refresh up to 5 minutes before an " +
        "access token expires (Claude does), so they would refresh on nearly every request.",
    );
  }
  const refreshIdleTtlSeconds = readTtl(env, "SEVDESK_OAUTH_REFRESH_IDLE_TTL", problems);
  const grantTtlSeconds = readTtl(env, "SEVDESK_OAUTH_GRANT_TTL", problems);
  if (problems.length > before || accounts === undefined) return undefined;
  return { accounts, clients, accessTtlSeconds, refreshIdleTtlSeconds, grantTtlSeconds };
}

function readAccounts(
  env: Env,
  problems: string[],
  warnings: string[],
): readonly string[] | "any" | undefined {
  const name = "SEVDESK_OAUTH_ACCOUNTS";
  const values = readList(env[name]);
  if (values.length === 0) {
    problems.push(
      `SEVDESK_HTTP_AUTH=oauth needs ${name}: the sevDesk account ids that may connect (print ` +
        "yours with `mcp-server-sevdesk account-id`), or `any` to let every sevDesk account " +
        "connect.",
    );
    return undefined;
  }
  if (values.includes("any")) {
    if (values.length > 1) {
      problems.push(`${name}: use either \`any\` or a list of account ids, not both.`);
      return undefined;
    }
    warnings.push(
      `${name}=any: every sevDesk account whose token is pasted on the consent page can connect ` +
        "through this server. List your account ids instead unless you run it for others on " +
        "purpose.",
    );
    return "any";
  }
  const invalid = values.filter((value) => !ACCOUNT_ID.test(value));
  if (invalid.length > 0) {
    problems.push(
      `${name}: expected sevDesk account ids (as printed by \`mcp-server-sevdesk account-id\`), ` +
        `got ${invalid.map((value) => JSON.stringify(value.slice(0, 64))).join(", ")}.`,
    );
    return undefined;
  }
  return [...new Set(values)];
}

function readClients(env: Env, problems: string[], warnings: string[]): readonly string[] | "any" {
  const name = "SEVDESK_OAUTH_CLIENTS";
  const values = readList(env[name]);
  if (values.length === 0) return ["claude.ai"];
  if (values.includes("any")) {
    if (values.length > 1) {
      problems.push(`${name}: use either \`any\` or a list of hostnames, not both.`);
      return ["claude.ai"];
    }
    warnings.push(
      `${name}=any: any website can publish client metadata and ask your users for consent ` +
        "through this server. List the client hosts you use instead (default claude.ai).",
    );
    return "any";
  }
  const invalid = values.filter((value) => !DNS_NAME.test(value) || !value.includes("."));
  if (invalid.length > 0) {
    problems.push(
      `${name}: expected the hostnames that serve client metadata documents, such as claude.ai, ` +
        `got ${invalid.map((value) => JSON.stringify(value)).join(", ")}.`,
    );
    return ["claude.ai"];
  }
  return [...new Set(values)];
}

function readTtl(env: Env, name: keyof typeof TTL_RULES, problems: string[]): number {
  const rule = TTL_RULES[name];
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return rule.fallback;
  const seconds = parseDuration(raw);
  if (seconds === undefined || seconds < rule.min || seconds > rule.max) {
    problems.push(
      `${name}: expected a duration between ${rule.bounds} (such as 30m, 1h, 14d, or ` +
        `seconds), got "${raw}".`,
    );
    return rule.fallback;
  }
  return seconds;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}
