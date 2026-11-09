/**
 * How `startHttpMode` wires remote file transfer: browser sessions without the approval inbox,
 * the transfer routes, the state directory's `files/` folder (emptied only after the grant
 * store's lock), and nothing of it when `SEVDESK_HTTP_FILES=off`. The upload and download flow
 * itself is covered by `transfer-routes.test.ts` and the end-to-end test.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateDirError } from "../../../src/http/oauth/index.js";
import { type RunningHttp, startHttpMode } from "../../../src/http/run.js";
import { TEST_TOKEN } from "../../helpers/config.js";

const ORIGIN = "https://mcp.example.com";
const BEARER = randomBytes(32).toString("base64url");
const ID = "z".repeat(43);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sdmcp-run-files-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function start(env: Record<string, string>) {
  const lines: string[] = [];
  const running: RunningHttp = await startHttpMode({
    env: {
      SEVDESK_HTTP_AUTH: "bearer",
      SEVDESK_HTTP_PUBLIC_URL: ORIGIN,
      SEVDESK_HTTP_HOST: "127.0.0.1",
      SEVDESK_HTTP_PORT: "0",
      SEVDESK_HTTP_BEARER_TOKEN: BEARER,
      SEVDESK_API_TOKEN: TEST_TOKEN,
      SEVDESK_CONFIRM: "elicit",
      ...env,
    },
    log: { info: (event) => lines.push(event), warn: (event) => lines.push(event) },
    identity: () => Promise.resolve({ accountId: "1001" }),
  });
  cleanup.push(() => running.close());
  const fetch = (path: string, init?: RequestInit) =>
    running.server.router.fetch(new Request(`${ORIGIN}${path}`, init), "203.0.113.7");
  /** The status, after reading the body (a request counts as in flight until then). */
  const statusOf = async (path: string, init?: RequestInit): Promise<number> => {
    const response = await fetch(path, init);
    await response.text();
    return response.status;
  };
  return { running, fetch, statusOf, lines };
}

describe("startHttpMode: remote file transfer", () => {
  it("serves the transfer pages with sign-in in bearer mode without the inbox", async () => {
    const dir = await stateDir();
    await mkdir(join(dir, "files"), { mode: 0o755 });
    await writeFile(join(dir, "files", "leftover.bin"), "from an earlier process");
    const { fetch, statusOf } = await start({ SEVDESK_HTTP_STATE_DIR: dir });

    // The folder was emptied and tightened once the grant store held the lock.
    expect(await readdir(join(dir, "files"))).toEqual([]);
    expect((await stat(join(dir, "files"))).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["grants.lock", "files"]));

    const page = await fetch(`/uploads/${ID}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`name="next" value="/uploads/${ID}"`);
    expect(await statusOf("/approvals")).toBe(404);

    const login = await fetch("/approvals/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TEST_TOKEN, next: `/files/${ID}` }),
    });
    await login.text();
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe(`${ORIGIN}/files/${ID}`);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^__Host-sevdesk_session=/);
    const missing = await fetch(`/files/${ID}`, { headers: { Cookie: cookie } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("File not found");
  });

  it("keeps the files in memory without a state directory", async () => {
    const { statusOf } = await start({});
    expect(await statusOf(`/uploads/${ID}`)).toBe(200);
    expect(await statusOf(`/files/${ID}`)).toBe(200);
  });

  it("opens no sessions, routes or folder when files and the inbox are off", async () => {
    const dir = await stateDir();
    const { statusOf } = await start({ SEVDESK_HTTP_STATE_DIR: dir, SEVDESK_HTTP_FILES: "off" });
    expect(await statusOf(`/uploads/${ID}`)).toBe(404);
    expect(await statusOf(`/files/${ID}`)).toBe(404);
    expect(await statusOf("/approvals/login", { method: "POST" })).toBe(404);
    expect(await readdir(dir)).toEqual([]);
  });

  it("shares one sign-in between the inbox and the transfer pages", async () => {
    const { fetch, statusOf } = await start({ SEVDESK_CONFIRM: "browser" });
    const login = await fetch("/approvals/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TEST_TOKEN }),
    });
    await login.text();
    expect(login.headers.get("location")).toBe(`${ORIGIN}/approvals`);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(await statusOf("/approvals", { headers: { Cookie: cookie } })).toBe(200);
    expect(await statusOf(`/uploads/${ID}`, { headers: { Cookie: cookie } })).toBe(404);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses to start when the files folder cannot be emptied, releasing the lock",
    async () => {
      const dir = await stateDir();
      const stuck = join(dir, "files", "stuck");
      await mkdir(stuck, { recursive: true });
      await writeFile(join(stuck, "blob.bin"), "x");
      await chmod(stuck, 0o500);
      cleanup.push(() => chmod(stuck, 0o700).catch(() => undefined));
      const failed = start({ SEVDESK_HTTP_STATE_DIR: dir });
      await expect(failed).rejects.toBeInstanceOf(StateDirError);
      await expect(failed).rejects.toThrow(/cannot prepare .*files/);
      await chmod(stuck, 0o700);
      // The grant store's lock was released: a new start succeeds.
      const { statusOf } = await start({ SEVDESK_HTTP_STATE_DIR: dir });
      expect(await statusOf(`/uploads/${ID}`)).toBe(200);
    },
  );
});
