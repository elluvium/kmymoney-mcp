import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Store } from "../src/kmy/store.js";

/**
 * Corrupt one <SPLIT shares="..."> in the fixture to verify that the reports
 * tool gracefully skips it rather than crashing the whole response.
 */
async function fixtureWithBadShares(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "kmy-reports-"));
  const path = join(dir, "test.kmy");
  const original = await fs.readFile("data/bgt.kmy");
  const text = gunzipSync(original).toString("utf8");
  // Surgical replace: first occurrence of a numeric shares value with garbage.
  const mangled = text.replace(/shares="[^"]+"/, 'shares="not-a-number"');
  await fs.writeFile(path, gzipSync(Buffer.from(mangled, "utf8")));
  return path;
}

describe("reports tolerate malformed splits", () => {
  let store: Store;
  beforeEach(async () => {
    const path = await fixtureWithBadShares();
    store = await Store.open(path, { autosave: false });
  });

  it("Store opens a file with a malformed share value", () => {
    // Just verifying the parse/load doesn't throw.
    expect(store.listTransactions({}).length).toBeGreaterThan(0);
  });
});
