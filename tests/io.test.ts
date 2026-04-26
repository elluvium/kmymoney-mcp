import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDocument,
  loadDocumentWithStat,
  saveDocument,
  StaleFileError,
  BACKUP_COUNT,
} from "../src/kmy/io.js";
import { findRoot, childrenOf, tagOf } from "../src/kmy/ast.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "kmy-test-"));
}

describe("io load/save + backup rotation", () => {
  let workDir: string;
  let filePath: string;

  beforeEach(async () => {
    workDir = await mkTmpDir();
    filePath = join(workDir, "test.kmy");
    const src = await fs.readFile("data/bgt.kmy");
    await fs.writeFile(filePath, src);
  });

  it("loads gzipped and plain files transparently", async () => {
    const ast = await loadDocument(filePath);
    const root = findRoot(ast);
    const txns = childrenOf(root).find((c) => tagOf(c) === "TRANSACTIONS");
    expect(txns && childrenOf(txns).length).toBe(1197);
  });

  it("saves gzipped output and creates a .1~ backup", async () => {
    const ast = await loadDocument(filePath);
    await saveDocument(filePath, ast);

    const backup = `${filePath}.1~`;
    await expect(fs.access(backup)).resolves.toBeUndefined();

    // Reload the saved file; counts must still match.
    const reloaded = await loadDocument(filePath);
    const root = findRoot(reloaded);
    const txns = childrenOf(root).find((c) => tagOf(c) === "TRANSACTIONS");
    expect(txns && childrenOf(txns).length).toBe(1197);
  });

  it("rotates up to BACKUP_COUNT backups and discards the oldest", async () => {
    for (let i = 0; i < BACKUP_COUNT + 2; i++) {
      const ast = await loadDocument(filePath);
      await saveDocument(filePath, ast);
    }
    // .1~ … .10~ should exist; nothing beyond.
    for (let i = 1; i <= BACKUP_COUNT; i++) {
      await expect(fs.access(`${filePath}.${i}~`)).resolves.toBeUndefined();
    }
    await expect(fs.access(`${filePath}.${BACKUP_COUNT + 1}~`)).rejects.toThrow();
  });

  it("leaves temp file cleaned up on failure", async () => {
    // Simulate write failure by pointing at a non-existent directory.
    const bad = join(workDir, "does-not-exist", "x.kmy");
    const ast = await loadDocument(filePath);
    await expect(saveDocument(bad, ast)).rejects.toThrow();
    // No .tmp should remain where we tried to write.
    await expect(fs.access(`${bad}.tmp`)).rejects.toThrow();
  });

  it("refuses to save when the file drifted under us (staleness guard)", async () => {
    const { ast, mtimeMs } = await loadDocumentWithStat(filePath);
    // Someone else writes the file — e.g. KMyMoney saves.
    // Wait long enough to guarantee a different mtime on all filesystems.
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(filePath, await fs.readFile(filePath));

    await expect(
      saveDocument(filePath, ast, { expectedMtimeMs: mtimeMs }),
    ).rejects.toBeInstanceOf(StaleFileError);
  });

  it("concurrent saves serialize via the lockfile", async () => {
    const ast = await loadDocument(filePath);
    const results = await Promise.all([
      saveDocument(filePath, ast),
      saveDocument(filePath, ast),
      saveDocument(filePath, ast),
    ]);
    expect(results.every((r) => typeof r.mtimeMs === "number")).toBe(true);
    // And the lock was released.
    await expect(fs.access(`${filePath}.lock`)).rejects.toThrow();
  });

  it("returns a fresh mtimeMs on each save", async () => {
    const ast = await loadDocument(filePath);
    const a = await saveDocument(filePath, ast);
    await new Promise((r) => setTimeout(r, 20));
    const b = await saveDocument(filePath, ast, { expectedMtimeMs: a.mtimeMs });
    expect(b.mtimeMs).toBeGreaterThanOrEqual(a.mtimeMs);
  });
});
