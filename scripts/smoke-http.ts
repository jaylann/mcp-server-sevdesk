/**
 * HTTP smoke test for the remote mode (`--http`, bearer auth). Two ways to run it:
 *
 * - `--bin <path>/dist/index.js`: starts the installed bin with `--http` on a free loopback port
 *   (bearer mode, a random bearer token, a dummy sevDesk token and an unreachable base URL, so
 *   nothing leaves the machine), reads the origin from its `listening on <origin>/mcp` line, runs
 *   the checks, then checks that `--http` without `SEVDESK_HTTP_AUTH` exits 1, that SIGTERM stops
 *   the server with exit code 0 within 5 s, and that no secret appeared in its output.
 * - `--url <origin> --bearer <token>`: runs the checks against a running server (the Docker CI
 *   job). The token may also come from `SEVDESK_HTTP_BEARER_TOKEN`; the origin must be the
 *   server's public URL (its Host is checked).
 *
 * Checks: `/healthz`; 401 without and with a wrong token; a foreign Host and a foreign Origin get
 * 403; the SDK client in both protocol eras sees the server name, the version and a non-empty
 * tool list.
 *
 * Usage: pnpm exec tsx scripts/smoke-http.ts --bin <dist/index.js> | --url <origin> [--bearer <t>]
 * (or `node scripts/smoke-http.ts …` on Node with type stripping; the script imports packages
 * only, no project sources). On Windows the SIGTERM check only expects the server to stop.
 * Exit codes: 0 ok, 1 failure, 2 usage error.
 */
import {
  type ChildProcess,
  type ChildProcessByStdio,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const EXPECTED_NAME = "mcp-server-sevdesk";
const TIMEOUT_MS = 60_000;
const LISTEN_TIMEOUT_MS = 15_000;
const SIGTERM_TIMEOUT_MS = 5_000;
const DUMMY_SEVDESK_TOKEN = "0".repeat(32);
const FOREIGN_HOST = "smoke-foreign.invalid";

interface Options {
  readonly bin?: string;
  readonly url?: string;
  readonly bearer?: string;
}

function usage(message: string): never {
  console.error(`smoke-http: ${message}`);
  console.error(
    "usage: smoke-http.ts --bin <path-to-dist/index.js> | --url <origin> [--bearer <token>]",
  );
  process.exit(2);
}

function parseOptions(argv: readonly string[]): Options {
  const options: { bin?: string; url?: string; bearer?: string } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`${String(flag)} needs a value`);
    if (flag === "--bin") options.bin = value;
    else if (flag === "--url") options.url = value;
    else if (flag === "--bearer") options.bearer = value;
    else usage(`unknown argument ${String(flag)}`);
  }
  if ((options.bin === undefined) === (options.url === undefined)) {
    usage("pass either --bin or --url");
  }
  return options;
}

/** A minimal environment for the server: no inherited secrets or proxies. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ok(name: string): void {
  console.log(`smoke-http: ok ${name}`);
}

/** A request with full control over `Host` (fetch does not allow setting it). */
function rawStatus(
  origin: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<number> {
  const url = new URL(path, origin);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      { method: body === undefined ? "GET" : "POST", headers, servername: url.hostname },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`${path} timed out`)));
    req.end(body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-http", version: "0.0.0" },
  },
});
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function runChecks(origin: string, bearer: string, version: string | undefined) {
  const mcpUrl = new URL("/mcp", origin);

  const health = await fetch(new URL("/healthz", origin));
  const healthBody = (await health.json().catch(() => undefined)) as
    { status?: unknown } | undefined;
  check(
    health.status === 200 && healthBody?.status === "ok",
    `/healthz answered ${String(health.status)}`,
  );
  ok("healthz");

  const anonymous = await fetch(mcpUrl, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
  check(anonymous.status === 401, `POST /mcp without auth answered ${String(anonymous.status)}`);
  check(
    (anonymous.headers.get("www-authenticate") ?? "").startsWith(
      'Bearer realm="mcp-server-sevdesk"',
    ),
    "the 401 has no bearer challenge",
  );
  ok("401 without a token");

  const wrong = await fetch(mcpUrl, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
    body: INITIALIZE,
  });
  check(wrong.status === 401, `POST /mcp with a wrong token answered ${String(wrong.status)}`);
  ok("401 with a wrong token");

  const authorized = { ...MCP_HEADERS, Authorization: `Bearer ${bearer}` };
  const foreignHost = await rawStatus(
    origin,
    "/mcp",
    { ...authorized, Host: FOREIGN_HOST },
    INITIALIZE,
  );
  check(foreignHost === 403, `a foreign Host got ${String(foreignHost)}`);
  ok("foreign Host refused");

  const foreignOrigin = await rawStatus(
    origin,
    "/mcp",
    { ...authorized, Origin: `https://${FOREIGN_HOST}` },
    INITIALIZE,
  );
  check(foreignOrigin === 403, `a foreign Origin got ${String(foreignOrigin)}`);
  ok("foreign Origin refused");

  for (const era of ["modern", "legacy"] as const) {
    const client = new Client(
      { name: "smoke-http", version: "0.0.0" },
      era === "legacy" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      }),
    );
    const info = client.getServerVersion();
    check(
      info?.name === EXPECTED_NAME,
      `${era}: expected ${EXPECTED_NAME}, got ${String(info?.name)}`,
    );
    check(
      version === undefined || info.version === version,
      `${era}: --version printed ${String(version)} but the server reports ${info.version}`,
    );
    const { tools } = await client.listTools();
    check(tools.length > 0, `${era}: the server listed no tools`);
    await client.close();
    ok(`${era} client: ${info.name} ${info.version}, ${String(tools.length)} tools`);
  }
}

/** Starts the bin with `--http` and resolves with its origin once it listens. */
function startServer(
  bin: string,
  env: Record<string, string>,
  output: string[],
): { child: ChildProcessByStdio<null, Readable, Readable>; origin: Promise<string> } {
  const child = spawn(process.execPath, [bin, "--http"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const origin = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`the server did not report listening within ${String(LISTEN_TIMEOUT_MS)} ms`),
      );
    }, LISTEN_TIMEOUT_MS);
    const lines = createInterface({ input: child.stderr });
    lines.on("line", (line) => {
      output.push(line);
      console.error(`server: ${line}`);
      const match = /listening on (https?:\/\/\S+)\/mcp\b/.exec(line);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited early with code ${String(code)}`));
    });
  });
  return { child, origin };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the server did not exit within ${String(timeoutMs)} ms of SIGTERM`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function runBin(bin: string): Promise<void> {
  const version = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim();

  const unauthenticated = spawnSync(process.execPath, [bin, "--http"], {
    env: { ...baseEnv(), SEVDESK_API_TOKEN: DUMMY_SEVDESK_TOKEN },
    encoding: "utf8",
    timeout: 10_000,
  });
  check(
    unauthenticated.status === 1,
    `--http without SEVDESK_HTTP_AUTH exited with ${String(unauthenticated.status)}, expected 1`,
  );
  check(
    unauthenticated.stderr.includes("SEVDESK_HTTP_AUTH"),
    "--http without SEVDESK_HTTP_AUTH did not name the variable",
  );
  ok("--http without SEVDESK_HTTP_AUTH exits 1");

  const bearer = randomBytes(32).toString("base64url");
  const output: string[] = [];
  const { child, origin } = startServer(
    bin,
    {
      ...baseEnv(),
      SEVDESK_HTTP_AUTH: "bearer",
      SEVDESK_HTTP_HOST: "127.0.0.1",
      SEVDESK_HTTP_PORT: "0",
      SEVDESK_HTTP_BEARER_TOKEN: bearer,
      SEVDESK_API_TOKEN: DUMMY_SEVDESK_TOKEN,
      // Port 9 (discard) on loopback: connection refused at once, nothing leaves the machine.
      SEVDESK_BASE_URL: "https://127.0.0.1:9/api/v1",
    },
    output,
  );
  try {
    await runChecks(await origin, bearer, version);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  child.kill("SIGTERM");
  const code = await waitForExit(child, SIGTERM_TIMEOUT_MS);
  if (process.platform === "win32") {
    // Windows has no SIGTERM: kill() terminates the process, so only the exit itself is checked.
    ok("the server stopped");
  } else {
    check(code === 0, `the server exited with ${String(code)} after SIGTERM, expected 0`);
    ok("SIGTERM exits 0");
  }

  const text = output.join("\n");
  check(!text.includes(bearer), "the bearer token appeared in the server output");
  check(!text.includes(DUMMY_SEVDESK_TOKEN), "the sevDesk token appeared in the server output");
  ok("no secrets in the server output");
}

const options = parseOptions(process.argv.slice(2));
const timer = setTimeout(() => {
  console.error(`smoke-http: timed out after ${String(TIMEOUT_MS)} ms`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  if (options.bin !== undefined) {
    await runBin(options.bin);
  } else {
    const bearer = options.bearer ?? process.env["SEVDESK_HTTP_BEARER_TOKEN"];
    if (bearer === undefined || bearer === "")
      usage("--url needs --bearer or SEVDESK_HTTP_BEARER_TOKEN");
    let origin: string;
    try {
      origin = new URL(options.url ?? "").origin;
    } catch {
      usage("--url must be an origin such as http://localhost:8080");
    }
    await runChecks(origin, bearer, undefined);
  }
  clearTimeout(timer);
  console.log("smoke-http: ok");
} catch (error) {
  console.error("smoke-http: failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
