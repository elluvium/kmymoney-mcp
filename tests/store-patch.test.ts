import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/kmy/store.js";

async function openTestStore(autosave = true): Promise<Store> {
  const dir = await fs.mkdtemp(join(tmpdir(), "kmy-patch-"));
  const path = join(dir, "test.kmy");
  await fs.copyFile("data/bgt.kmy", path);
  return Store.open(path, { autosave });
}

describe("Store patch semantics", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openTestStore(true);
  });

  it("updatePayee({ email: null }) clears email", async () => {
    const [p] = store.listPayees();
    if (!p) throw new Error("fixture has no payees");
    await store.mutate(() => store.updatePayee(p.id, { email: "test@example.com" }));
    expect(store.getPayee(p.id)!.email).toBe("test@example.com");

    await store.mutate(() => store.updatePayee(p.id, { email: null }));
    expect(store.getPayee(p.id)!.email).toBeUndefined();

    // And round-trips through disk.
    await store.reload();
    expect(store.getPayee(p.id)!.email).toBeUndefined();
  });

  it("updatePayee with absent field leaves it untouched", async () => {
    const [p] = store.listPayees();
    if (!p) throw new Error("fixture has no payees");
    await store.mutate(() =>
      store.updatePayee(p.id, { email: "keep@me.com", reference: "ref-1" }),
    );
    await store.mutate(() => store.updatePayee(p.id, { reference: "ref-2" }));
    const after = store.getPayee(p.id)!;
    expect(after.email).toBe("keep@me.com");
    expect(after.reference).toBe("ref-2");
  });

  it("updateTransaction({ memo: null }) clears memo", async () => {
    const [t] = store.listTransactions({});
    if (!t) throw new Error("fixture has no transactions");
    await store.mutate(() => store.updateTransaction(t.id, { memo: "hello" }));
    expect(store.getTransaction(t.id)!.memo).toBe("hello");

    await store.mutate(() => store.updateTransaction(t.id, { memo: null }));
    expect(store.getTransaction(t.id)!.memo).toBeUndefined();
  });

  it("updateTransaction({ entryDate }) updates entry date", async () => {
    const [t] = store.listTransactions({});
    if (!t) throw new Error("fixture has no transactions");
    await store.mutate(() =>
      store.updateTransaction(t.id, { entryDate: "2026-04-01" }),
    );
    expect(store.getTransaction(t.id)!.entryDate).toBe("2026-04-01");
  });

  it("updateTransaction rejects impossible dates", async () => {
    const [t] = store.listTransactions({});
    if (!t) throw new Error("fixture has no transactions");
    await expect(
      store.mutate(() =>
        store.updateTransaction(t.id, { postDate: "2025-13-45" }),
      ),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("drain() completes without error", async () => {
    await expect(store.drain()).resolves.toBeUndefined();
  });
});
