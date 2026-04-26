import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/kmy/store.js";

async function openTestStore(autosave = false): Promise<Store> {
  const dir = await fs.mkdtemp(join(tmpdir(), "kmy-store-"));
  const path = join(dir, "test.kmy");
  await fs.copyFile("data/bgt.kmy", path);
  return Store.open(path, { autosave });
}

describe("Store reads", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openTestStore(false);
  });

  it("summarizes the file", () => {
    const s = store.summary();
    expect(s.counts.ACCOUNTS).toBe(115);
    expect(s.counts.TRANSACTIONS).toBe(1197);
    expect(s.fileInfo.version).toBe("1");
  });

  it("lists accounts excluding standard roots by default", () => {
    const all = store.listAccounts();
    expect(all.some((a) => a.id.startsWith("AStd::"))).toBe(false);
    const withRoots = store.listAccounts({ includeStandardRoots: true });
    expect(withRoots.length).toBeGreaterThan(all.length);
  });

  it("lists payees and tags", () => {
    expect(store.listPayees().length).toBe(17);
    expect(store.listTags().length).toBe(1);
  });

  it("filters transactions by date range and account", () => {
    const fst = store.listTransactions({ dateFrom: "2025-01-01", dateTo: "2025-01-31" });
    expect(fst.length).toBeGreaterThan(0);
    expect(fst.every((t) => t.postDate >= "2025-01-01" && t.postDate <= "2025-01-31")).toBe(true);
  });

  it("lists currencies, securities, prices, budgets", () => {
    expect(store.listCurrencies().map((c) => c.id).sort()).toEqual([
      "BTC",
      "EUR",
      "UAH",
      "USD",
    ]);
    expect(store.listSecurities().length).toBe(4);
    expect(store.listPrices().length).toBeGreaterThan(0);
    expect(store.listBudgets().length).toBe(1);
  });

  it("resolves account by id and name", () => {
    const all = store.listAccounts();
    const sample = all[0]!;
    expect(store.resolveAccount(sample.id)).toBe(sample.id);
    expect(store.resolveAccount(sample.name)).toBe(sample.id);
  });
});

describe("Store writes", () => {
  it("adds a payee and round-trips through save/reload", async () => {
    const store = await openTestStore(true);
    const before = store.listPayees().length;
    const p = await store.mutate(() => store.addPayee({ name: "Test Coffee Co." }));
    expect(p.id.startsWith("P")).toBe(true);
    expect(store.listPayees().length).toBe(before + 1);

    await store.reload();
    expect(store.listPayees().some((x) => x.name === "Test Coffee Co.")).toBe(true);
  });

  it("rejects transaction with unbalanced splits", async () => {
    const store = await openTestStore(false);
    const accts = store.listAccounts().slice(0, 2);
    await expect(
      store.mutate(() =>
        store.addTransaction({
          postDate: "2026-04-26",
          commodity: "UAH",
          splits: [
            { account: accts[0]!.id, shares: "100/1", value: "100/1", price: "1/1" },
            { account: accts[1]!.id, shares: "-50/1", value: "-50/1", price: "1/1" },
          ],
        }),
      ),
    ).rejects.toThrow(/splits do not balance/);
  });

  it("rejects transaction referencing unknown account", async () => {
    const store = await openTestStore(false);
    const accts = store.listAccounts();
    await expect(
      store.mutate(() =>
        store.addTransaction({
          postDate: "2026-04-26",
          commodity: "UAH",
          splits: [
            { account: accts[0]!.id, shares: "100/1", value: "100/1", price: "1/1" },
            { account: "A999999", shares: "-100/1", value: "-100/1", price: "1/1" },
          ],
        }),
      ),
    ).rejects.toThrow(/unknown account/);
  });

  it("adds and deletes a balanced transaction", async () => {
    const store = await openTestStore(true);
    const accts = store.listAccounts({ type: 1 }).concat(store.listAccounts({ type: 13 }));
    const asset = accts.find((a) => a.type === 1) ?? store.listAccounts()[0]!;
    const expense = accts.find((a) => a.type === 13) ?? store.listAccounts()[1]!;
    const before = store.listTransactions({}).length;

    const txn = await store.mutate(() =>
      store.addTransaction({
        postDate: "2026-04-26",
        commodity: asset.currency,
        memo: "test latte",
        splits: [
          { account: asset.id, shares: "-5000/100", value: "-5000/100", price: "1/1" },
          { account: expense.id, shares: "5000/100", value: "5000/100", price: "1/1" },
        ],
      }),
    );
    expect(store.listTransactions({}).length).toBe(before + 1);

    await store.mutate(() => store.deleteTransaction(txn.id));
    expect(store.listTransactions({}).length).toBe(before);
  });
});
