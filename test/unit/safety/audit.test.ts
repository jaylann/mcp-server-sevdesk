import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type AuditEvent, createAuditLog } from "../../../src/safety/audit.js";
import { TEST_TOKEN } from "../../helpers/config.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sevdesk-audit-"));
  dirs.push(dir);
  return dir;
}

const NOW = new Date("2026-11-07T20:00:00.000Z");

/** An `executing` event; an override of `undefined` removes the member. */
function event(
  overrides: { readonly [K in keyof AuditEvent]?: AuditEvent[K] | undefined } = {},
): AuditEvent {
  const merged: Record<string, unknown> = {
    event: "executing",
    callId: "call-1",
    tool: "sevdesk_invoice_finalize",
    tier: "commit",
    argsHash: "a".repeat(64),
    args: { id: 7 },
    approval: "elicit",
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as AuditEvent;
}

async function lines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("audit log", () => {
  it("is a no-op without a path", async () => {
    const log = createAuditLog({ path: undefined, secrets: [TEST_TOKEN] });

    expect(log.enabled).toBe(false);
    await expect(log.record(event())).resolves.toBeUndefined();
  });

  it("appends one JSON line per event, in order, to a new 0600 file", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const log = createAuditLog({ path, secrets: [TEST_TOKEN], now: () => NOW });

    await Promise.all([
      log.record(event({ event: "confirmation_requested", approval: undefined })),
      log.record(event()),
      log.record(
        event({
          event: "executed",
          approval: undefined,
          affected: [{ objectName: "Invoice", id: "7" }],
        }),
      ),
    ]);

    expect(log.enabled).toBe(true);
    expect(await lines(path)).toEqual([
      {
        ts: "2026-11-07T20:00:00.000Z",
        event: "confirmation_requested",
        callId: "call-1",
        tool: "sevdesk_invoice_finalize",
        tier: "commit",
        argsHash: "a".repeat(64),
        args: { id: 7 },
      },
      expect.objectContaining({ event: "executing", approval: "elicit" }),
      expect.objectContaining({
        event: "executed",
        affected: [{ objectName: "Invoice", id: "7" }],
      }),
    ]);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("appends to an existing file and tightens its mode to 0600", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    await writeFile(path, '{"existing":true}\n', { mode: 0o644 });
    await chmod(path, 0o644);
    const log = createAuditLog({ path, secrets: [TEST_TOKEN] });

    await log.record(event());

    const all = await lines(path);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({ existing: true });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("never writes the token, in values, keys or previews", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const log = createAuditLog({ path, secrets: [TEST_TOKEN] });

    await log.record(
      event({
        event: "dry_run",
        args: {
          note: `token ${TEST_TOKEN}`,
          [TEST_TOKEN]: 1,
          nested: [{ t: TEST_TOKEN.toUpperCase() }],
        },
        preview: {
          action: `Use ${TEST_TOKEN}.`,
          facts: [],
          warnings: [],
          irreversible: false,
        },
      }),
    );

    const text = await readFile(path, "utf8");
    expect(text.toLowerCase()).not.toContain(TEST_TOKEN);
    expect(text).toContain("[REDACTED]");
  });

  it("keeps hidden characters visible as escapes, logs long texts whole and drops non-JSON values", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const log = createAuditLog({ path, secrets: [TEST_TOKEN] });
    const rlo = String.fromCodePoint(0x202e);
    const vs16 = String.fromCodePoint(0xfe0f);

    await log.record(
      event({
        args: {
          name: `Muster${rlo} GmbH${vs16}`,
          text: "Zeile 1\nZeile 2\tTab",
          email: "x".repeat(12_000),
          huge: "y".repeat(20_005),
          skip: undefined,
          fn: () => 1,
        },
      }),
    );

    const [line] = await lines(path);
    const args = line?.["args"] as Record<string, unknown>;
    expect(args["name"]).toBe("Muster\\u{202e} GmbH\\u{fe0f}");
    expect(args["text"]).toBe("Zeile 1\nZeile 2\\u{9}Tab");
    expect(args["email"]).toBe("x".repeat(12_000));
    expect(args["huge"]).toBe(`${"y".repeat(20_000)}… [5 more characters not logged]`);
    expect(args).not.toHaveProperty("skip");
    expect(args["fn"]).toBe("[function]");
  });

  it("records failures with their error kind and completed writes", async () => {
    const path = join(await tempDir(), "audit.jsonl");
    const log = createAuditLog({ path, secrets: [TEST_TOKEN] });

    await log.record(
      event({
        event: "failed",
        approval: undefined,
        error: "validation",
        affected: [{ objectName: "Contact", id: "123" }],
      }),
    );

    expect((await lines(path))[0]).toMatchObject({
      event: "failed",
      error: "validation",
      affected: [{ objectName: "Contact", id: "123" }],
    });
  });

  it("rejects when the line cannot be written, and keeps working afterwards", async () => {
    const dir = await tempDir();
    const blocked = join(dir, "is-a-directory");
    await mkdir(blocked);
    const log = createAuditLog({ path: blocked, secrets: [] });

    await expect(log.record(event())).rejects.toThrow();
    await expect(log.record(event())).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("refuses to follow a symlink at the path", async () => {
    const dir = await tempDir();
    const target = join(dir, "target.jsonl");
    await writeFile(target, "");
    const link = join(dir, "audit.jsonl");
    await symlink(target, link);
    const log = createAuditLog({ path: link, secrets: [] });

    await expect(log.record(event())).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("");
  });
});
