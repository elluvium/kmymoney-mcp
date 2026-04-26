import {
  type AstNode,
  allAttrs,
  attr,
  childrenOf,
  ensureSection,
  findChild,
  findChildren,
  findRoot,
  makeNode,
  readKeyValues,
  setAttr,
  tagOf,
} from "./ast.js";
import { loadDocumentWithStat, saveDocument } from "./io.js";
import { formatId, makeIdGenerator } from "./ids.js";
import {
  ACCOUNT_TYPE_NAMES,
  type Account,
  type Budget,
  type Currency,
  type FileInfo,
  type FileSummary,
  type Institution,
  type Payee,
  type Price,
  type Security,
  type Split,
  type Tag,
  type Transaction,
  type User,
} from "./types.js";
import { fromString, isZero, sum, toString as rToString } from "./money.js";

interface StoreOptions {
  autosave: boolean;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  // Guard against "2025-13-45" etc. — Date normalizes impossibles silently, so
  // we round-trip and compare the YYYY-MM-DD slice.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** Async mutex so concurrent mutations/saves never interleave. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class Store {
  private ast!: AstNode[];
  private root!: AstNode;
  private mutex = new Mutex();
  private dirty = false;
  private loadedMtimeMs = 0;

  constructor(
    private readonly path: string,
    private readonly options: StoreOptions,
  ) {}

  static async open(path: string, options: StoreOptions): Promise<Store> {
    const s = new Store(path, options);
    await s.reload();
    return s;
  }

  async reload(): Promise<void> {
    const { ast, mtimeMs } = await loadDocumentWithStat(this.path);
    this.ast = ast;
    this.root = findRoot(this.ast);
    this.loadedMtimeMs = mtimeMs;
    this.dirty = false;
  }

  async save(): Promise<void> {
    return this.mutex.run(async () => this.doSave());
  }

  /** Run a mutation under the mutex, autosave if enabled. */
  async mutate<T>(fn: () => T): Promise<T> {
    return this.mutex.run(async () => {
      const result = fn();
      this.dirty = true;
      if (this.options.autosave) {
        await this.doSave();
      }
      return result;
    });
  }

  /** Wait for any in-flight mutation/save to finish. Used on shutdown. */
  async drain(): Promise<void> {
    await this.mutex.run(async () => {});
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Internal save — must run under the mutex. Sets LAST_MODIFIED_DATE, writes
   * to disk, and refreshes the mtime cache. If the save throws (stale file,
   * disk error), rolls the date attribute back so in-memory state still
   * matches disk.
   */
  private async doSave(): Promise<void> {
    const fi = findChild(this.root, "FILEINFO");
    const lm = fi ? findChild(fi, "LAST_MODIFIED_DATE") : null;
    const prevDate = lm ? attr(lm, "date") : null;
    const today = new Date().toISOString().slice(0, 10);
    if (lm) setAttr(lm, "date", today);
    try {
      const result = await saveDocument(this.path, this.ast, {
        expectedMtimeMs: this.loadedMtimeMs || undefined,
      });
      this.loadedMtimeMs = result.mtimeMs;
      this.dirty = false;
    } catch (err) {
      if (lm && prevDate != null) setAttr(lm, "date", prevDate);
      throw err;
    }
  }

  // ---------- Top-level metadata ----------

  fileInfo(): FileInfo {
    const fi = findChild(this.root, "FILEINFO");
    if (!fi) throw new Error("FILEINFO missing");
    const get = (tag: string, a: string) => {
      const n = findChild(fi, tag);
      return n ? attr(n, a) : "";
    };
    return {
      creationDate: get("CREATION_DATE", "date"),
      lastModifiedDate: get("LAST_MODIFIED_DATE", "date"),
      version: get("VERSION", "id"),
      fixVersion: get("FIXVERSION", "id"),
    };
  }

  user(): User {
    const u = findChild(this.root, "USER");
    if (!u) return { name: "", email: "" };
    const addr = findChild(u, "ADDRESS");
    return {
      name: attr(u, "name"),
      email: attr(u, "email"),
      address: addr ? allAttrs(addr) : undefined,
    };
  }

  summary(): FileSummary {
    const counts: Record<string, number> = {};
    for (const child of childrenOf(this.root)) {
      const tag = tagOf(child);
      if (!tag) continue;
      const kids = childrenOf(child);
      counts[tag] = kids.length;
    }
    return { fileInfo: this.fileInfo(), user: this.user(), counts };
  }

  // ---------- Accounts ----------

  private accountNodes(): AstNode[] {
    const section = findChild(this.root, "ACCOUNTS");
    return section ? findChildren(section, "ACCOUNT") : [];
  }

  private accountFromNode(n: AstNode): Account {
    const type = Number(attr(n, "type"));
    const subs = findChild(n, "SUBACCOUNTS");
    const subIds = subs ? findChildren(subs, "SUBACCOUNT").map((s) => attr(s, "id")) : [];
    return {
      id: attr(n, "id"),
      name: attr(n, "name"),
      type,
      typeName: ACCOUNT_TYPE_NAMES[type] ?? `Unknown(${type})`,
      currency: attr(n, "currency"),
      parentAccount: attr(n, "parentaccount"),
      institution: attr(n, "institution") || undefined,
      number: attr(n, "number") || undefined,
      opened: attr(n, "opened") || undefined,
      lastReconciled: attr(n, "lastreconciled") || undefined,
      lastModified: attr(n, "lastmodified") || undefined,
      description: attr(n, "description") || undefined,
      subAccountIds: subIds,
      keyValues: readKeyValues(n),
    };
  }

  listAccounts(filter: {
    type?: number | number[];
    institution?: string;
    currency?: string;
    parentAccount?: string;
    nameContains?: string;
    includeStandardRoots?: boolean;
  } = {}): Account[] {
    const types = filter.type == null
      ? null
      : new Set(Array.isArray(filter.type) ? filter.type : [filter.type]);
    const out: Account[] = [];
    for (const n of this.accountNodes()) {
      const a = this.accountFromNode(n);
      if (!filter.includeStandardRoots && a.id.startsWith("AStd::")) continue;
      if (types && !types.has(a.type)) continue;
      if (filter.institution && a.institution !== filter.institution) continue;
      if (filter.currency && a.currency !== filter.currency) continue;
      if (filter.parentAccount && a.parentAccount !== filter.parentAccount) continue;
      if (
        filter.nameContains &&
        !a.name.toLowerCase().includes(filter.nameContains.toLowerCase())
      )
        continue;
      out.push(a);
    }
    return out;
  }

  getAccount(id: string): Account | null {
    for (const n of this.accountNodes()) {
      if (attr(n, "id") === id) return this.accountFromNode(n);
    }
    return null;
  }

  /** Return a name → account map and id → account map for O(1) lookup. */
  accountIndex(): { byId: Map<string, Account>; byName: Map<string, Account> } {
    const byId = new Map<string, Account>();
    const byName = new Map<string, Account>();
    for (const n of this.accountNodes()) {
      const a = this.accountFromNode(n);
      byId.set(a.id, a);
      byName.set(a.name.toLowerCase(), a);
    }
    return { byId, byName };
  }

  // ---------- Payees ----------

  private payeeNodes(): AstNode[] {
    const section = findChild(this.root, "PAYEES");
    return section ? findChildren(section, "PAYEE") : [];
  }

  private payeeFromNode(n: AstNode): Payee {
    const addr = findChild(n, "ADDRESS");
    return {
      id: attr(n, "id"),
      name: attr(n, "name"),
      email: attr(n, "email") || undefined,
      reference: attr(n, "reference") || undefined,
      defaultAccountId: attr(n, "defaultaccountid") || undefined,
      matchingEnabled: attr(n, "matchingenabled") === "1",
      matchIgnoreCase: attr(n, "matchignorecase") === "1",
      matchKey: attr(n, "matchkey") || undefined,
      address: addr ? allAttrs(addr) : undefined,
    };
  }

  listPayees(): Payee[] {
    return this.payeeNodes().map((n) => this.payeeFromNode(n));
  }

  getPayee(id: string): Payee | null {
    for (const n of this.payeeNodes()) {
      if (attr(n, "id") === id) return this.payeeFromNode(n);
    }
    return null;
  }

  addPayee(input: { name: string; email?: string; reference?: string }): Payee {
    if (!input.name?.trim()) throw new Error("payee name is required");
    if (this.listPayees().some((p) => p.name === input.name)) {
      throw new Error(`payee already exists: ${input.name}`);
    }
    const section = ensureSection(this.root, "PAYEES");
    const gen = makeIdGenerator(
      "payee",
      this.listPayees().map((p) => p.id),
    );
    const id = gen();
    const node = makeNode(
      "PAYEE",
      {
        name: input.name,
        email: input.email ?? "",
        matchignorecase: "1",
        id,
        matchingenabled: "0",
        usingmatchkey: "0",
        reference: input.reference ?? "",
        defaultaccountid: "",
        matchkey: "",
      },
      [makeNode("ADDRESS", { state: "", postcode: "", telephone: "", street: "", city: "" }, [])],
    );
    childrenOf(section).push(node);
    setAttr(section, "count", String(findChildren(section, "PAYEE").length));
    return this.payeeFromNode(node);
  }

  /**
   * Update a payee. Semantics: a field absent from the patch is left untouched;
   * `null` clears the field to empty string; a string sets it. `name` cannot
   * be cleared — pass a non-empty string to rename.
   */
  updatePayee(
    id: string,
    patch: {
      name?: string;
      email?: string | null;
      reference?: string | null;
      defaultAccountId?: string | null;
    },
  ): Payee {
    for (const n of this.payeeNodes()) {
      if (attr(n, "id") !== id) continue;
      if (patch.name !== undefined) {
        if (patch.name == null || !patch.name.trim()) {
          throw new Error("payee name is required");
        }
        if (this.listPayees().some((p) => p.id !== id && p.name === patch.name)) {
          throw new Error(`payee already exists: ${patch.name}`);
        }
        setAttr(n, "name", patch.name);
      }
      if (patch.email !== undefined) setAttr(n, "email", patch.email ?? "");
      if (patch.reference !== undefined) setAttr(n, "reference", patch.reference ?? "");
      if (patch.defaultAccountId !== undefined)
        setAttr(n, "defaultaccountid", patch.defaultAccountId ?? "");
      return this.payeeFromNode(n);
    }
    throw new Error(`payee not found: ${id}`);
  }

  deletePayee(id: string): void {
    // Refuse if any split references this payee.
    for (const t of this.transactionNodes()) {
      const splits = findChild(t, "SPLITS");
      if (!splits) continue;
      for (const s of findChildren(splits, "SPLIT")) {
        if (attr(s, "payee") === id) {
          throw new Error(`payee ${id} is referenced by transaction ${attr(t, "id")}`);
        }
      }
    }
    const section = findChild(this.root, "PAYEES");
    if (!section) throw new Error("no PAYEES section");
    const kids = childrenOf(section);
    const idx = kids.findIndex((n) => tagOf(n) === "PAYEE" && attr(n, "id") === id);
    if (idx === -1) throw new Error(`payee not found: ${id}`);
    kids.splice(idx, 1);
    setAttr(section, "count", String(findChildren(section, "PAYEE").length));
  }

  // ---------- Tags ----------

  private tagNodes(): AstNode[] {
    const section = findChild(this.root, "TAGS");
    return section ? findChildren(section, "TAG") : [];
  }

  private tagFromNode(n: AstNode): Tag {
    return {
      id: attr(n, "id"),
      name: attr(n, "name"),
      closed: attr(n, "closed") === "1",
      color: attr(n, "tagcolor") || undefined,
      notes: attr(n, "notes") || undefined,
    };
  }

  listTags(): Tag[] {
    return this.tagNodes().map((n) => this.tagFromNode(n));
  }

  addTag(input: { name: string; color?: string }): Tag {
    if (!input.name?.trim()) throw new Error("tag name is required");
    const section = ensureSection(this.root, "TAGS");
    const gen = makeIdGenerator(
      "tag",
      this.listTags().map((t) => t.id),
    );
    const id = gen();
    const node = makeNode(
      "TAG",
      { name: input.name, id, closed: "0", tagcolor: input.color ?? "#000000" },
      [],
    );
    childrenOf(section).push(node);
    setAttr(section, "count", String(findChildren(section, "TAG").length));
    return this.tagFromNode(node);
  }

  deleteTag(id: string): void {
    // Refuse if referenced from any split.
    for (const t of this.transactionNodes()) {
      const splits = findChild(t, "SPLITS");
      if (!splits) continue;
      for (const s of findChildren(splits, "SPLIT")) {
        for (const tagRef of findChildren(s, "TAG")) {
          if (attr(tagRef, "id") === id) {
            throw new Error(`tag ${id} is referenced by transaction ${attr(t, "id")}`);
          }
        }
      }
    }
    const section = findChild(this.root, "TAGS");
    if (!section) throw new Error("no TAGS section");
    const kids = childrenOf(section);
    const idx = kids.findIndex((n) => tagOf(n) === "TAG" && attr(n, "id") === id);
    if (idx === -1) throw new Error(`tag not found: ${id}`);
    kids.splice(idx, 1);
    setAttr(section, "count", String(findChildren(section, "TAG").length));
  }

  // ---------- Institutions ----------

  private institutionNodes(): AstNode[] {
    const section = findChild(this.root, "INSTITUTIONS");
    return section ? findChildren(section, "INSTITUTION") : [];
  }

  private institutionFromNode(n: AstNode): Institution {
    const addr = findChild(n, "ADDRESS");
    const ids = findChild(n, "ACCOUNTIDS");
    return {
      id: attr(n, "id"),
      name: attr(n, "name"),
      sortcode: attr(n, "sortcode") || undefined,
      manager: attr(n, "manager") || undefined,
      address: addr ? allAttrs(addr) : undefined,
      accountIds: ids ? findChildren(ids, "ACCOUNTID").map((a) => attr(a, "id")) : [],
      keyValues: readKeyValues(n),
    };
  }

  listInstitutions(): Institution[] {
    return this.institutionNodes().map((n) => this.institutionFromNode(n));
  }

  getInstitution(id: string): Institution | null {
    for (const n of this.institutionNodes()) {
      if (attr(n, "id") === id) return this.institutionFromNode(n);
    }
    return null;
  }

  // ---------- Transactions ----------

  private transactionNodes(): AstNode[] {
    const section = findChild(this.root, "TRANSACTIONS");
    return section ? findChildren(section, "TRANSACTION") : [];
  }

  private splitFromNode(n: AstNode): Split {
    const tagIds = findChildren(n, "TAG").map((t) => attr(t, "id"));
    return {
      id: attr(n, "id"),
      account: attr(n, "account"),
      shares: attr(n, "shares"),
      value: attr(n, "value"),
      price: attr(n, "price"),
      memo: attr(n, "memo") || undefined,
      payee: attr(n, "payee") || undefined,
      action: attr(n, "action") || undefined,
      reconcileFlag: attr(n, "reconcileflag") || undefined,
      reconcileDate: attr(n, "reconciledate") || undefined,
      number: attr(n, "number") || undefined,
      bankId: attr(n, "bankid") || undefined,
      tags: tagIds,
      keyValues: readKeyValues(n),
    };
  }

  private transactionFromNode(n: AstNode): Transaction {
    const splitsParent = findChild(n, "SPLITS");
    const splits = splitsParent
      ? findChildren(splitsParent, "SPLIT").map((s) => this.splitFromNode(s))
      : [];
    return {
      id: attr(n, "id"),
      postDate: attr(n, "postdate"),
      entryDate: attr(n, "entrydate"),
      commodity: attr(n, "commodity"),
      memo: attr(n, "memo") || undefined,
      splits,
      keyValues: readKeyValues(n),
    };
  }

  listTransactions(filter: {
    dateFrom?: string;
    dateTo?: string;
    accountId?: string;
    payeeId?: string;
    tagId?: string;
    categoryId?: string;
    memoContains?: string;
    commodity?: string;
    limit?: number;
    offset?: number;
  } = {}): Transaction[] {
    const all = this.transactionNodes().map((n) => this.transactionFromNode(n));
    let out = all;
    if (filter.dateFrom) out = out.filter((t) => t.postDate >= filter.dateFrom!);
    if (filter.dateTo) out = out.filter((t) => t.postDate <= filter.dateTo!);
    if (filter.commodity) out = out.filter((t) => t.commodity === filter.commodity);
    if (filter.accountId)
      out = out.filter((t) => t.splits.some((s) => s.account === filter.accountId));
    if (filter.payeeId)
      out = out.filter((t) => t.splits.some((s) => s.payee === filter.payeeId));
    if (filter.tagId)
      out = out.filter((t) => t.splits.some((s) => s.tags.includes(filter.tagId!)));
    if (filter.categoryId)
      out = out.filter((t) => t.splits.some((s) => s.account === filter.categoryId));
    if (filter.memoContains) {
      const needle = filter.memoContains.toLowerCase();
      out = out.filter(
        (t) =>
          (t.memo ?? "").toLowerCase().includes(needle) ||
          t.splits.some((s) => (s.memo ?? "").toLowerCase().includes(needle)),
      );
    }
    out.sort((a, b) => (a.postDate < b.postDate ? -1 : a.postDate > b.postDate ? 1 : 0));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? out.length;
    return out.slice(offset, offset + limit);
  }

  getTransaction(id: string): Transaction | null {
    for (const n of this.transactionNodes()) {
      if (attr(n, "id") === id) return this.transactionFromNode(n);
    }
    return null;
  }

  /** Validate that a set of splits sums to zero in their transaction commodity. */
  private assertSplitsBalanced(splits: Pick<Split, "value">[]): void {
    const total = sum(splits.map((s) => fromString(s.value)));
    if (!isZero(total)) {
      throw new Error(
        `splits do not balance: sum of values = ${rToString(total)} (must be 0)`,
      );
    }
  }

  /** Verify every referenced account exists and belongs to the same currency where required. */
  private assertAccountRefs(accountIds: string[]): void {
    const idx = this.accountIndex();
    for (const id of accountIds) {
      if (!idx.byId.has(id)) throw new Error(`unknown account id: ${id}`);
    }
  }

  addTransaction(input: {
    postDate: string;
    entryDate?: string;
    commodity: string;
    memo?: string;
    splits: Array<Omit<Split, "id" | "tags" | "keyValues"> & { tags?: string[] }>;
  }): Transaction {
    if (!isIsoDate(input.postDate)) {
      throw new Error(`postDate must be YYYY-MM-DD: ${input.postDate}`);
    }
    if (input.entryDate != null && !isIsoDate(input.entryDate)) {
      throw new Error(`entryDate must be YYYY-MM-DD: ${input.entryDate}`);
    }
    if (input.splits.length < 2) {
      throw new Error("a transaction must have at least 2 splits");
    }
    this.assertAccountRefs(input.splits.map((s) => s.account));
    this.assertSplitsBalanced(input.splits);

    const section = ensureSection(this.root, "TRANSACTIONS");
    const gen = makeIdGenerator(
      "transaction",
      this.transactionNodes().map((n) => attr(n, "id")),
    );
    const id = gen();

    const splitNodes: AstNode[] = input.splits.map((s, i) => {
      const splitId = formatId("split", i + 1);
      const splitNode = makeNode(
        "SPLIT",
        {
          number: s.number ?? "",
          id: splitId,
          shares: s.shares,
          memo: s.memo ?? "",
          value: s.value,
          price: s.price ?? "1/1",
          payee: s.payee ?? "",
          action: s.action ?? "",
          reconciledate: s.reconcileDate ?? "",
          reconcileflag: s.reconcileFlag ?? "0",
          account: s.account,
          bankid: s.bankId ?? "",
        },
        [],
      );
      if (s.tags && s.tags.length > 0) {
        for (const tid of s.tags) {
          childrenOf(splitNode).push(makeNode("TAG", { id: tid }, []));
        }
      }
      return splitNode;
    });

    const node = makeNode(
      "TRANSACTION",
      {
        id,
        memo: input.memo ?? "",
        entrydate: input.entryDate ?? new Date().toISOString().slice(0, 10),
        postdate: input.postDate,
        commodity: input.commodity,
      },
      [makeNode("SPLITS", {}, splitNodes)],
    );
    childrenOf(section).push(node);
    setAttr(section, "count", String(findChildren(section, "TRANSACTION").length));
    return this.transactionFromNode(node);
  }

  updateTransaction(
    id: string,
    patch: {
      postDate?: string;
      entryDate?: string;
      memo?: string | null;
      commodity?: string;
      splits?: Array<
        Omit<Split, "id" | "tags" | "keyValues"> & { id?: string; tags?: string[] }
      >;
    },
  ): Transaction {
    if (patch.postDate !== undefined && !isIsoDate(patch.postDate)) {
      throw new Error(`postDate must be YYYY-MM-DD: ${patch.postDate}`);
    }
    if (patch.entryDate !== undefined && !isIsoDate(patch.entryDate)) {
      throw new Error(`entryDate must be YYYY-MM-DD: ${patch.entryDate}`);
    }
    for (const n of this.transactionNodes()) {
      if (attr(n, "id") !== id) continue;
      if (patch.postDate !== undefined) setAttr(n, "postdate", patch.postDate);
      if (patch.entryDate !== undefined) setAttr(n, "entrydate", patch.entryDate);
      if (patch.memo !== undefined) setAttr(n, "memo", patch.memo ?? "");
      if (patch.commodity !== undefined) setAttr(n, "commodity", patch.commodity);
      if (patch.splits) {
        if (patch.splits.length < 2)
          throw new Error("a transaction must have at least 2 splits");
        this.assertAccountRefs(patch.splits.map((s) => s.account));
        this.assertSplitsBalanced(patch.splits);
        const splitsParentIdx = childrenOf(n).findIndex((c) => tagOf(c) === "SPLITS");
        const existingParent = splitsParentIdx === -1 ? null : childrenOf(n)[splitsParentIdx];
        const existingIds = existingParent
          ? findChildren(existingParent, "SPLIT").map((s) => attr(s, "id"))
          : [];
        const existingSet = new Set(existingIds);
        const usedIds = new Set<string>();
        const idGen = makeIdGenerator("split", existingIds);
        const splitNodes: AstNode[] = patch.splits.map((s) => {
          let splitId: string;
          if (s.id && existingSet.has(s.id) && !usedIds.has(s.id)) {
            splitId = s.id;
          } else {
            do {
              splitId = idGen();
            } while (usedIds.has(splitId));
          }
          usedIds.add(splitId);
          const splitNode = makeNode(
            "SPLIT",
            {
              number: s.number ?? "",
              id: splitId,
              shares: s.shares,
              memo: s.memo ?? "",
              value: s.value,
              price: s.price ?? "1/1",
              payee: s.payee ?? "",
              action: s.action ?? "",
              reconciledate: s.reconcileDate ?? "",
              reconcileflag: s.reconcileFlag ?? "0",
              account: s.account,
              bankid: s.bankId ?? "",
            },
            [],
          );
          if (s.tags?.length)
            for (const tid of s.tags)
              childrenOf(splitNode).push(makeNode("TAG", { id: tid }, []));
          return splitNode;
        });
        const newSplitsParent = makeNode("SPLITS", {}, splitNodes);
        if (splitsParentIdx === -1) childrenOf(n).push(newSplitsParent);
        else childrenOf(n)[splitsParentIdx] = newSplitsParent;
      }
      return this.transactionFromNode(n);
    }
    throw new Error(`transaction not found: ${id}`);
  }

  deleteTransaction(id: string): void {
    const section = findChild(this.root, "TRANSACTIONS");
    if (!section) throw new Error("no TRANSACTIONS section");
    const kids = childrenOf(section);
    const idx = kids.findIndex((n) => tagOf(n) === "TRANSACTION" && attr(n, "id") === id);
    if (idx === -1) throw new Error(`transaction not found: ${id}`);
    kids.splice(idx, 1);
    setAttr(section, "count", String(findChildren(section, "TRANSACTION").length));
  }

  // ---------- Currencies / Securities / Prices ----------

  listCurrencies(): Currency[] {
    const section = findChild(this.root, "CURRENCIES");
    if (!section) return [];
    return findChildren(section, "CURRENCY").map((n) => ({
      id: attr(n, "id"),
      name: attr(n, "name"),
      symbol: attr(n, "symbol"),
      scf: attr(n, "scf"),
      saf: attr(n, "saf"),
      pp: attr(n, "pp"),
      type: attr(n, "type"),
      roundingMethod: attr(n, "rounding-method"),
    }));
  }

  listSecurities(): Security[] {
    const section = findChild(this.root, "SECURITIES");
    if (!section) return [];
    return findChildren(section, "SECURITY").map((n) => ({
      id: attr(n, "id"),
      name: attr(n, "name"),
      symbol: attr(n, "symbol"),
      type: attr(n, "type"),
      tradingCurrency: attr(n, "trading-currency"),
      tradingMarket: attr(n, "trading-market") || undefined,
      saf: attr(n, "saf"),
      pp: attr(n, "pp"),
      roundingMethod: attr(n, "rounding-method"),
      keyValues: readKeyValues(n),
    }));
  }

  listPrices(filter: { from?: string; to?: string; dateFrom?: string; dateTo?: string } = {}): Price[] {
    const section = findChild(this.root, "PRICES");
    if (!section) return [];
    const out: Price[] = [];
    for (const pair of findChildren(section, "PRICEPAIR")) {
      const from = attr(pair, "from");
      const to = attr(pair, "to");
      if (filter.from && from !== filter.from) continue;
      if (filter.to && to !== filter.to) continue;
      for (const p of findChildren(pair, "PRICE")) {
        const date = attr(p, "date");
        if (filter.dateFrom && date < filter.dateFrom) continue;
        if (filter.dateTo && date > filter.dateTo) continue;
        out.push({
          from,
          to,
          date,
          price: attr(p, "price"),
          source: attr(p, "source") || undefined,
        });
      }
    }
    return out;
  }

  // ---------- Budgets ----------

  listBudgets(): Budget[] {
    const section = findChild(this.root, "BUDGETS");
    if (!section) return [];
    return findChildren(section, "BUDGET").map((n) => ({
      id: attr(n, "id"),
      name: attr(n, "name"),
      start: attr(n, "start"),
      version: attr(n, "version"),
      accounts: findChildren(n, "ACCOUNT").map((acc) => ({
        id: attr(acc, "id"),
        budgetLevel: attr(acc, "budgetlevel"),
        amount: attr(acc, "amount"),
        periods: findChildren(acc, "PERIOD").map((p) => ({
          amount: attr(p, "amount"),
          start: attr(p, "start") || undefined,
        })),
      })),
    }));
  }

  getBudget(id: string): Budget | null {
    return this.listBudgets().find((b) => b.id === id) ?? null;
  }

  // ---------- ID helpers ----------

  /**
   * Resolve an account id or human-readable name (or :-separated path like
   * "Expense:Food:Coffee") to an account id. Throws if ambiguous or missing.
   */
  resolveAccount(idOrName: string): string {
    const { byId, byName } = this.accountIndex();
    if (byId.has(idOrName)) return idOrName;
    const lower = idOrName.toLowerCase();
    if (byName.has(lower)) return byName.get(lower)!.id;
    if (idOrName.includes(":")) {
      const parts = idOrName.split(":");
      const leaf = parts[parts.length - 1]!.toLowerCase();
      const matches = [...byId.values()].filter((a) => a.name.toLowerCase() === leaf);
      if (matches.length === 1) return matches[0]!.id;
      for (const a of matches) {
        const fullPath = this.accountPath(a.id).join(":").toLowerCase();
        if (fullPath.endsWith(parts.join(":").toLowerCase())) return a.id;
      }
    }
    throw new Error(`account not found: ${idOrName}`);
  }

  accountPath(id: string): string[] {
    const { byId } = this.accountIndex();
    const out: string[] = [];
    let cur = byId.get(id) ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      // Stop at the standard roots.
      if (cur.id.startsWith("AStd::")) break;
      out.unshift(cur.name);
      if (!cur.parentAccount) break;
      cur = byId.get(cur.parentAccount) ?? null;
    }
    return out;
  }
}
