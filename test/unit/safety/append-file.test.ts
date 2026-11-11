import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareStateDir } from "../../../src/http/config.js";
import { appendLine, ownedByOtherUser, writeAll } from "../../../src/safety/append-file.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sevdesk-append-"));
  dirs.push(dir);
  return dir;
}

/** A handle whose `write` lets at most `limit` bytes through per call, like a nearly full volume. */
function shortWrites(handle: FileHandle, limit: number): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property !== "write") {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
      return (bytes: Buffer, offset: number, length: number) =>
        target.write(bytes, offset, Math.min(length, limit));
    },
  });
}

describe("writeAll", () => {
  it("keeps writing until every byte is in the file", async () => {
    const path = join(tempDir(), "file");
    const handle = await open(path, "a+");
    try {
      await writeAll(shortWrites(handle, 3), Buffer.from("0123456789\n"));
    } finally {
      await handle.close();
    }

    expect(readFileSync(path, "utf8")).toBe("0123456789\n");
  });

  it("rejects when a write makes no progress", async () => {
    const handle = await open(join(tempDir(), "file"), "a+");
    try {
      await expect(writeAll(shortWrites(handle, 0), Buffer.from("line\n"))).rejects.toMatchObject({
        code: "WRITE_NO_PROGRESS",
      });
    } finally {
      await handle.close();
    }
  });
});

describe("appendLine", () => {
  it.each([
    ["an empty file", "", "new\n"],
    ["a file that ends a line", "old\n", "old\nnew\n"],
    ["a file whose last line was cut short", "old\ncu", "old\ncu\nnew\n"],
  ])("appends to %s", async (_, before, after) => {
    const path = join(tempDir(), "file");
    writeFileSync(path, before);
    const handle = await open(path, "a+");
    try {
      await appendLine(shortWrites(handle, 2), "new\n");
    } finally {
      await handle.close();
    }

    expect(readFileSync(path, "utf8")).toBe(after);
  });
});

describe("ownedByOtherUser", () => {
  it("compares the owner with the user of the process", () => {
    expect(ownedByOtherUser({ uid: 501 }, () => 501)).toBe(false);
    expect(ownedByOtherUser({ uid: 0 }, () => 501)).toBe(true);
    expect(ownedByOtherUser({ uid: 501 }, () => 0)).toBe(true);
  });

  it.skipIf(process.getuid === undefined)("defaults to the user of this process", () => {
    const own = process.getuid?.() ?? 0;

    expect(ownedByOtherUser({ uid: own })).toBe(false);
    expect(ownedByOtherUser({ uid: own + 1 })).toBe(true);
  });
});

// Review 2026-11, round 3: SEVDESK_HTTP_STATE_DIR was trusted by its mode bits alone.
describe.skipIf(process.getuid === undefined)("prepareStateDir: ownership", () => {
  it("refuses a directory that belongs to another user, whatever its mode", () => {
    const dir = tempDir();
    chmodSync(dir, 0o700);

    const problem = prepareStateDir(dir, () => (process.getuid?.() ?? 0) + 1);

    expect(problem).toBe(
      `SEVDESK_HTTP_STATE_DIR: ${dir} belongs to another user, who could replace the files in ` +
        "it. Use a directory owned by the user the server runs as (the Docker image runs as uid " +
        "65532).",
    );
  });

  it("accepts a directory of its own user, and one it creates", () => {
    const dir = tempDir();

    expect(prepareStateDir(dir)).toBeUndefined();
    expect(prepareStateDir(join(dir, "new"), () => process.getuid?.() ?? 0)).toBeUndefined();
  });
});
