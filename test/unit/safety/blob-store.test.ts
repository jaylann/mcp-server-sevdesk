import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deriveKeySet } from "../../../src/http/keys.js";
import { BlobStoreError, openBlobStore } from "../../../src/safety/blob-store.js";

const PDF = Buffer.from("%PDF-1.7\nRechnung 4711 Muster GmbH IBAN DE02120300000000202051\n%%EOF");
const A = { accountScope: "1001", kind: "pdf" } as const;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdmcp-blobs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory blob store", () => {
  it("stores, reads and deletes blobs bound to account and kind", async () => {
    const store = await openBlobStore();
    expect(store.mode).toBe("memory");
    const id = await store.put(A, PDF);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await store.get(id, A)).toEqual(PDF);
    expect(await store.get(id, { accountScope: "2002", kind: "pdf" })).toBeUndefined();
    expect(await store.get(id, { accountScope: "1001", kind: "xml" })).toBeUndefined();
    await store.delete(id);
    expect(await store.get(id, A)).toBeUndefined();
    await store.delete(id);
  });

  it("forgets everything on close and refuses new blobs", async () => {
    const store = await openBlobStore();
    const id = await store.put(A, PDF);
    await store.close();
    expect(await store.get(id, A)).toBeUndefined();
    await expect(store.put(A, PDF)).rejects.toThrow(/closed/);
  });
});

describe("disk blob store", () => {
  it("creates the folder 0700 and writes 0600 files with random names, encrypted", async () => {
    const dir = join(tempDir(), "files");
    const store = await openBlobStore({ dir });
    expect(store.mode).toBe("disk");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const id = await store.put(A, PDF);
    const names = readdirSync(dir);
    expect(names).toEqual([`${id}.bin`]);
    const path = join(dir, `${id}.bin`);
    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      const raw = readFileSync(fd);
      expect(raw.includes(Buffer.from("Rechnung"))).toBe(false);
      expect(raw.includes(Buffer.from("%PDF"))).toBe(false);
    } finally {
      closeSync(fd);
    }
    expect(await store.get(id, A)).toEqual(PDF);
    await store.close();
  });

  it("empties a folder left by an earlier process when it opens", async () => {
    const dir = join(tempDir(), "files");
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(join(dir, "old.bin"), "leftover");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.bin"), "leftover");
    const store = await openBlobStore({ dir });
    expect(readdirSync(dir)).toEqual([]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await store.close();
  });

  it("replaces a file or a symlink at the folder's path, never following the link", async () => {
    const root = tempDir();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "not ours");
    const linked = join(root, "linked");
    symlinkSync(elsewhere, linked);
    const store = await openBlobStore({ dir: linked });
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
    expect(lstatSync(linked).isDirectory()).toBe(true);
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
    await store.close();

    const file = join(root, "file");
    writeFileSync(file, "x");
    const second = await openBlobStore({ dir: file });
    expect(lstatSync(file).isDirectory()).toBe(true);
    await second.close();
  });

  it("refuses a folder it cannot create", async () => {
    const root = tempDir();
    writeFileSync(join(root, "blocker"), "x");
    await expect(openBlobStore({ dir: join(root, "blocker", "files") })).rejects.toThrow(
      BlobStoreError,
    );
  });

  it("refuses a swapped blob file (the additional data binds the id)", async () => {
    const dir = join(tempDir(), "files");
    const store = await openBlobStore({ dir });
    const first = await store.put(A, PDF);
    const second = await store.put(A, Buffer.from("%PDF-1.7 other"));
    renameSync(join(dir, `${second}.bin`), join(dir, `${first}.bin`));
    expect(await store.get(first, A)).toBeUndefined();
    expect(await store.get(second, A)).toBeUndefined();
    await store.close();
  });

  it("does not open blobs of another process's key", async () => {
    const dir = join(tempDir(), "files");
    const keys = deriveKeySet(new Uint8Array(randomBytes(32)));
    const store = await openBlobStore({ dir, keys });
    const id = await store.put(A, PDF);
    const raw = readFileSync(join(dir, `${id}.bin`));
    const other = await openBlobStore({ dir: join(tempDir(), "files") });
    const copied = await other.put(A, Buffer.from("x"));
    writeFileSync(join(dirs.at(-1) ?? "", "files", `${copied}.bin`), raw);
    expect(await other.get(copied, A)).toBeUndefined();
    await store.close();
    await other.close();
  });

  it("answers undefined for missing and malformed ids, and deletes idempotently", async () => {
    const dir = join(tempDir(), "files");
    const store = await openBlobStore({ dir });
    expect(await store.get("A".repeat(22), A)).toBeUndefined();
    expect(await store.get("../../etc/passwd", A)).toBeUndefined();
    await store.delete("../escape");
    const id = await store.put(A, PDF);
    await store.delete(id);
    await store.delete(id);
    expect(readdirSync(dir)).toEqual([]);
    await store.close();
  });

  it("refuses to follow a symlink planted as a blob file", async () => {
    const root = tempDir();
    const dir = join(root, "files");
    const store = await openBlobStore({ dir });
    const id = await store.put(A, PDF);
    const target = join(root, "target");
    writeFileSync(target, "secret");
    rmSync(join(dir, `${id}.bin`));
    symlinkSync(target, join(dir, `${id}.bin`));
    await expect(store.get(id, A)).rejects.toThrow();
    await store.close();
  });

  it("removes its blobs on close and refuses new ones", async () => {
    const dir = join(tempDir(), "files");
    const store = await openBlobStore({ dir });
    await store.put(A, PDF);
    await store.put(A, PDF);
    await store.close();
    expect(readdirSync(dir)).toEqual([]);
    await expect(store.put(A, PDF)).rejects.toThrow(/closed/);
  });
});
