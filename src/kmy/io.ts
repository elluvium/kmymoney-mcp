import { promises as fs } from "node:fs";
import { dirname, join, basename } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseXml, serializeXml } from "./parser.js";
import type { AstNode } from "./ast.js";

export const BACKUP_COUNT = 10;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 20;
const LOCK_RETRY_ATTEMPTS = 50; // ~1 s total budget

export class StaleFileError extends Error {
  readonly code = "EKMY_STALE";
  constructor(path: string, expected: number, actual: number) {
    super(
      `file ${path} was modified externally (expected mtimeMs=${expected}, found ${actual}); reload and retry`,
    );
    this.name = "StaleFileError";
  }
}

export interface LoadResult {
  ast: AstNode[];
  mtimeMs: number;
}

/** Read a KMyMoney file and return its AST plus the on-disk mtimeMs at read time. */
export async function loadDocumentWithStat(path: string): Promise<LoadResult> {
  const [buf, st] = await Promise.all([fs.readFile(path), fs.stat(path)]);
  const text = looksGzipped(buf)
    ? gunzipSync(buf).toString("utf8")
    : buf.toString("utf8");
  return { ast: parseXml(text), mtimeMs: st.mtimeMs };
}

/** Read a KMyMoney file (gzipped XML by default, plain XML accepted). */
export async function loadDocument(path: string): Promise<AstNode[]> {
  return (await loadDocumentWithStat(path)).ast;
}

function looksGzipped(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

interface SaveOptions {
  /** If true, produce plain XML; otherwise gzip (default). */
  plain?: boolean;
  /** If false, skip rolling backups (default true). */
  backup?: boolean;
  /** If false, skip the cross-process lockfile (default true). */
  lock?: boolean;
  /**
   * If set, verify the live file's mtimeMs matches this value before rotating
   * backups / writing. Throws StaleFileError on mismatch so we never clobber
   * an external edit (KMyMoney, another process) the caller hasn't observed.
   */
  expectedMtimeMs?: number;
}

export interface SaveResult {
  /** New mtimeMs of the live file on disk after a successful save. */
  mtimeMs: number;
}

/**
 * Persist a document atomically.
 *
 *   1. Acquire an exclusive `.lock` file (O_EXCL; stale >60s reclaimed, retries with backoff).
 *   2. If `expectedMtimeMs` given, re-stat and bail if the file drifted under us.
 *   3. Serialize + gzip to `<path>.tmp` (same dir / same FS).
 *   4. Rotate backups `.N~` on disk.
 *   5. Hard-link the live file to `.1~` so the original inode survives; falls back
 *      to `copyFile` on filesystems without hardlink support (EXDEV/EPERM/ENOSYS).
 *   6. Atomic rename `<path>.tmp` → `<path>`.
 *
 * On failure we best-effort unwind step 4 + restore `.1~` to the live path so the
 * user is never left with rotated backups and no live file.
 */
export async function saveDocument(
  path: string,
  ast: AstNode[],
  opts: SaveOptions = {},
): Promise<SaveResult> {
  const plain = opts.plain ?? false;
  const backup = opts.backup ?? true;
  const wantLock = opts.lock ?? true;

  const xml = serializeXml(ast);
  const payload: Buffer = plain
    ? Buffer.from(xml, "utf8")
    : gzipSync(Buffer.from(xml, "utf8"));

  const dir = dirname(path);
  const name = basename(path);
  const tmpPath = join(dir, `${name}.tmp`);
  const lockPath = join(dir, `${name}.lock`);

  const release = wantLock ? await acquireLock(lockPath) : async () => {};
  let rotated = false;
  let linked = false;
  try {
    if (opts.expectedMtimeMs != null) {
      const st = await statOrNull(path);
      if (st && st.mtimeMs !== opts.expectedMtimeMs) {
        throw new StaleFileError(path, opts.expectedMtimeMs, st.mtimeMs);
      }
    }

    await fs.writeFile(tmpPath, payload, { flag: "w" });

    const hadOriginal = await fileExists(path);
    try {
      if (backup) {
        await rotateBackups(path);
        rotated = true;
      }
      if (hadOriginal && backup) {
        await linkOrCopy(path, `${path}.1~`);
        linked = true;
      }
      await fs.rename(tmpPath, path);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      // If we got as far as linking .1~ but rename failed, the live file still
      // points at the original inode via the hardlink — nothing to restore.
      // If we rotated but never linked, the live path still exists untouched;
      // try to unwind the rotation so .1~…/.10~ point where they did before.
      if (rotated && !linked) {
        await unwindRotation(path).catch(() => {});
      }
      if (!(await fileExists(path)) && (await fileExists(`${path}.1~`))) {
        try {
          await linkOrCopy(`${path}.1~`, path);
        } catch {
          /* give up — user still has .1~ as the canonical copy */
        }
      }
      throw err;
    }

    const st = await fs.stat(path);
    return { mtimeMs: st.mtimeMs };
  } finally {
    await release();
  }
}

async function rotateBackups(path: string): Promise<void> {
  const exists = await fileExists(path);
  if (!exists) return; // fresh file, nothing to rotate

  const oldest = `${path}.${BACKUP_COUNT}~`;
  if (await fileExists(oldest)) {
    await fs.rm(oldest, { force: true });
  }

  for (let i = BACKUP_COUNT - 1; i >= 1; i--) {
    const src = `${path}.${i}~`;
    const dst = `${path}.${i + 1}~`;
    if (await fileExists(src)) {
      await fs.rename(src, dst);
    }
  }
  // Caller links path → .1~ afterwards.
}

/** Best-effort reverse of rotateBackups — used when post-rotation work fails. */
async function unwindRotation(path: string): Promise<void> {
  for (let i = 2; i <= BACKUP_COUNT; i++) {
    const src = `${path}.${i}~`;
    const dst = `${path}.${i - 1}~`;
    if (await fileExists(src)) {
      await fs.rename(src, dst).catch(() => {});
    }
  }
}

async function linkOrCopy(src: string, dst: string): Promise<void> {
  try {
    await fs.link(src, dst);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP") {
      await fs.copyFile(src, dst);
      return;
    }
    throw err;
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const payload = `${process.pid} ${Date.now()}\n`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(payload);
      await fh.close();
      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      lastError = err;
      // Lock file already exists — check if it's stale.
      const st = await statOrNull(lockPath);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Stale — try to reclaim. If another process beat us to it, the next
        // iteration's `open("wx")` will either succeed or hit EEXIST again.
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      // Lock is live — back off and retry.
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(
    `unable to acquire lock at ${lockPath} after ${LOCK_RETRY_ATTEMPTS} attempts` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function statOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
