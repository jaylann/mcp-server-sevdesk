/**
 * Where the bytes of transferred files (uploads and download links, `transfer-store.ts`) wait
 * while their records live: in memory, or with `SEVDESK_HTTP_STATE_DIR` in `<stateDir>/files/`.
 * Either way they are encrypted (AES-256-GCM, `sealBytes`) under a key drawn at random when the
 * store opens, so nothing stored outlives the process: a restart, a copied volume or a backup
 * holds only ciphertext nobody can open. The additional data binds each blob to its id, account
 * scope and kind, so a blob file swapped for another fails to open.
 *
 * Disk layout: the folder has mode 0700 and is emptied when the store opens (leftovers of an
 * earlier process are unreadable anyway). The caller opens the store only after it holds the
 * state directory's lock (`grants.lock`), so a second server can never empty the folder of a
 * live one. Each blob is one file with a random name, created with `O_EXCL` and mode 0600 and
 * opened with `O_NOFOLLOW`; names never derive from anything a user or the model chose.
 */
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { type KeySet } from "../http/keys.js";
import { openBytes, sealBytes } from "../http/seal.js";
import { createEphemeralKeys } from "../http/session.js";
import { randomId } from "./web.js";

/** @public What a blob is bound to: decrypting it needs the same values. */
export interface BlobBinding {
  /** The account scope of the record (`RequestPrincipal.accountScope`). */
  readonly accountScope: string;
  /** The file kind (`pdf`, `png`, `jpeg`, `xml`, `csv`, `zip`). */
  readonly kind: string;
}

export interface BlobStore {
  readonly mode: "memory" | "disk";
  /** Encrypts and stores `bytes`; resolves the new blob's random id. */
  put(binding: BlobBinding, bytes: Uint8Array): Promise<string>;
  /**
   * The bytes of blob `id`, or `undefined` when it is gone or does not open with `binding`
   * (another account or kind, a swapped or altered file).
   */
  get(id: string, binding: BlobBinding): Promise<Uint8Array | undefined>;
  /** Removes blob `id`; a missing blob is no error. */
  delete(id: string): Promise<void>;
  /** Removes every blob this store wrote; later calls reject. */
  close(): Promise<void>;
}

export interface BlobStoreOptions {
  /** `<stateDir>/files`; `undefined` keeps the blobs in memory. */
  readonly dir?: string | undefined;
  /** Encryption keys (default: fresh random ones, `createEphemeralKeys`). Tests pass their own. */
  readonly keys?: KeySet;
}

/** Blob ids: 16 random bytes, base64url. */
const BLOB_ID = /^[A-Za-z0-9_-]{22}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW: number = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;

/** A problem preparing the blob folder; the message names the path, never file content. */
export class BlobStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobStoreError";
  }
}

/**
 * Opens a blob store: in memory, or in `options.dir`, which is created (0700) or emptied first.
 * Rejects with {@link BlobStoreError} when the folder cannot be prepared.
 */
export async function openBlobStore(options: BlobStoreOptions = {}): Promise<BlobStore> {
  const keys = options.keys ?? createEphemeralKeys().current;
  return options.dir === undefined ? memoryBlobStore(keys) : await diskBlobStore(keys, options.dir);
}

function context(id: string, binding: BlobBinding): string {
  return JSON.stringify([id, binding.accountScope, binding.kind]);
}

function closedError(): Error {
  return new Error("The file store is closed.");
}

function memoryBlobStore(keys: KeySet): BlobStore {
  const blobs = new Map<string, Buffer>();
  let closed = false;
  return {
    mode: "memory",
    put(binding, bytes) {
      if (closed) return Promise.reject(closedError());
      const id = randomId(16);
      blobs.set(id, sealBytes(keys, context(id, binding), bytes));
      return Promise.resolve(id);
    },
    get(id, binding) {
      const sealed = blobs.get(id);
      return Promise.resolve(
        sealed === undefined ? undefined : openBytes(keys, context(id, binding), sealed),
      );
    },
    delete(id) {
      blobs.delete(id);
      return Promise.resolve();
    },
    close() {
      closed = true;
      blobs.clear();
      return Promise.resolve();
    },
  };
}

async function diskBlobStore(keys: KeySet, dir: string): Promise<BlobStore> {
  await prepareFolder(dir);
  const written = new Set<string>();
  let closed = false;
  const pathOf = (id: string): string | undefined =>
    BLOB_ID.test(id) ? join(dir, `${id}.bin`) : undefined;

  async function remove(id: string): Promise<void> {
    written.delete(id);
    const path = pathOf(id);
    if (path === undefined) return;
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  return {
    mode: "disk",
    async put(binding, bytes) {
      if (closed) throw closedError();
      const id = randomId(16);
      const path = join(dir, `${id}.bin`);
      const sealed = sealBytes(keys, context(id, binding), bytes);
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        FILE_MODE,
      );
      written.add(id);
      try {
        await handle.writeFile(sealed);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await remove(id).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return id;
    },
    async get(id, binding) {
      const path = pathOf(id);
      if (path === undefined) return undefined;
      let sealed: Buffer;
      try {
        const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
        try {
          sealed = await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      return openBytes(keys, context(id, binding), sealed);
    },
    delete: remove,
    async close() {
      closed = true;
      await Promise.all([...written].map((id) => remove(id).catch(() => undefined)));
    },
  };
}

/**
 * Creates `dir` (0700) or empties it. Something else at the path (a file, a symlink) is removed
 * and replaced by a directory: the folder belongs to this server alone.
 */
async function prepareFolder(dir: string): Promise<void> {
  const failed = (what: string): BlobStoreError =>
    new BlobStoreError(
      `SEVDESK_HTTP_STATE_DIR: cannot ${what} ${dir} for uploaded and downloadable files. ` +
        "Check that the state directory is writable by this process.",
    );
  let info: Stats | undefined;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (!isMissing(error)) throw failed("inspect");
    info = undefined;
  }
  try {
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) {
      await rm(dir, { force: true });
      info = undefined;
    }
    if (info === undefined) {
      await mkdir(dir, { mode: DIR_MODE });
    } else {
      for (const entry of await readdir(dir)) {
        await rm(join(dir, entry), { recursive: true, force: true });
      }
    }
    await chmod(dir, DIR_MODE);
  } catch {
    throw failed("prepare");
  }
  const after = await lstat(dir).catch(() => undefined);
  if (after === undefined || !after.isDirectory() || after.isSymbolicLink()) {
    throw failed("prepare");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
