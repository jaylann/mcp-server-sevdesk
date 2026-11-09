/**
 * `mcp-server-sevdesk healthcheck`: asks the HTTP server on this machine for `/healthz` and turns
 * the answer into an exit code, for container health checks (the distroless image has no curl).
 * Reads the same `SEVDESK_HTTP_HOST`/`SEVDESK_HTTP_PORT`/`PORT` the server does; a server bound to
 * all interfaces is asked on 127.0.0.1.
 *
 * Without `SEVDESK_HTTP_AUTH` the container does not run the HTTP mode (registry users start the
 * image with `--stdio`): there is nothing to probe, and the check passes.
 */
import { type Env, nonEmpty } from "../config.js";
import { PACKAGE_NAME } from "../version.js";
import { readHttpHost, readHttpPort } from "./config.js";
import { HEALTHZ_PATH } from "./router.js";

/** How long the check may take. */
const HEALTHCHECK_TIMEOUT_MS = 3_000;

export interface HealthcheckDeps {
  readonly fetch?: typeof fetch;
  /** Receives the failure reason (default: stderr). */
  readonly write?: (line: string) => void;
  readonly timeoutMs?: number;
}

/**
 * 0 when `/healthz` answers 200 `{"status":"ok"}` in time, or when `SEVDESK_HTTP_AUTH` is unset
 * (not the HTTP mode); else 1.
 */
export async function runHealthcheck(env: Env, deps: HealthcheckDeps = {}): Promise<number> {
  if (nonEmpty(env["SEVDESK_HTTP_AUTH"]) === undefined) return 0;
  const write =
    deps.write ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const fail = (reason: string): number => {
    write(`${PACKAGE_NAME} healthcheck: ${reason}`);
    return 1;
  };
  const problems: string[] = [];
  const host = readHttpHost(env, problems);
  const port = readHttpPort(env, problems);
  if (problems.length > 0) return fail(problems.join(" "));
  if (port === 0) return fail("the port is 0 (chosen at random); set SEVDESK_HTTP_PORT.");

  const url = `http://${targetHost(host)}:${String(port)}${HEALTHZ_PATH}`;
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS),
      redirect: "error",
    });
    const body = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
    if (response.status === 200 && body?.status === "ok") return 0;
    return fail(`${url} answered ${String(response.status)}.`);
  } catch {
    return fail(`no answer from ${url}.`);
  }
}

/** Where to reach a server bound to `host` from this machine. */
function targetHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}
