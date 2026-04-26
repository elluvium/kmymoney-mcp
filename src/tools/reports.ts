import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";
import { DateStr } from "../util/schemas.js";
import {
  type Rational,
  add,
  cmp,
  fromString,
  isZero,
  mul,
  neg as rneg,
  sub,
  sum,
  toDecimal,
  toString as rToString,
  ZERO,
} from "../kmy/money.js";
import { ASSET_LIKE, LIABILITY_LIKE, EXPENSE_TYPES, INCOME_TYPES } from "../kmy/types.js";

/** Look up a from→to price as of the given date, using the latest entry on or before. */
function findRate(
  store: Store,
  from: string,
  to: string,
  asOf?: string,
): Rational | null {
  if (from === to) return fromString("1/1");
  const direct = store.listPrices({ from, to, dateTo: asOf });
  if (direct.length > 0) {
    const latest = direct.sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!;
    return fromString(latest.price);
  }
  const inverse = store.listPrices({ from: to, to: from, dateTo: asOf });
  if (inverse.length > 0) {
    const latest = inverse.sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!;
    const p = fromString(latest.price);
    if (!isZero(p)) {
      return { num: p.den, den: p.num } as Rational;
    }
  }
  return null;
}

interface ConvertOptions {
  onMissingRate?: "zero" | "throw" | "skip";
}

function convert(
  store: Store,
  amount: Rational,
  from: string,
  to: string,
  asOf: string | undefined,
  opts: ConvertOptions = {},
): Rational | null {
  if (from === to) return amount;
  const rate = findRate(store, from, to, asOf);
  if (!rate) {
    if (opts.onMissingRate === "throw")
      throw new Error(`no price available to convert ${from} → ${to}`);
    if (opts.onMissingRate === "skip") return null;
    return ZERO;
  }
  return mul(amount, rate);
}

function signedForType(type: number, value: Rational): Rational {
  // Expense accounts accumulate as positives in reports; Income as positives.
  if (EXPENSE_TYPES.has(type)) return value;
  if (INCOME_TYPES.has(type)) return rneg(value);
  return value;
}

interface MalformedSplit {
  txId: string;
  splitId: string;
  field: "value" | "shares";
  raw: string;
}

function safeFromString(raw: string): Rational | null {
  try {
    return fromString(raw);
  } catch {
    return null;
  }
}

export function registerReportTools(server: McpServer, store: Store): void {
  server.registerTool(
    "get_account_balance",
    {
      title: "Get account balance",
      description:
        "Compute the balance of an account as-of a given date (inclusive). Includes descendants by default. Optional target currency triggers FX conversion via PRICES.",
      inputSchema: {
        account: z.string().describe("Account id or name"),
        asOf: DateStr.optional().describe("YYYY-MM-DD (default: today)"),
        includeDescendants: z.boolean().optional().default(true),
        currency: z.string().optional().describe("Target currency for display"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ account, asOf, includeDescendants, currency }) => {
      const rootId = store.resolveAccount(account);
      const idx = store.accountIndex();
      const rootAccount = idx.byId.get(rootId)!;

      // Build parent→children map once — O(N) instead of O(N²) for each BFS hop.
      const childrenByParent = new Map<string, string[]>();
      for (const a of idx.byId.values()) {
        if (!a.parentAccount) continue;
        const arr = childrenByParent.get(a.parentAccount);
        if (arr) arr.push(a.id);
        else childrenByParent.set(a.parentAccount, [a.id]);
      }

      const ids = new Set<string>([rootId]);
      if (includeDescendants) {
        const queue = [rootId];
        while (queue.length) {
          const cur = queue.shift()!;
          const kids = childrenByParent.get(cur);
          if (!kids) continue;
          for (const childId of kids) {
            if (ids.has(childId)) continue;
            ids.add(childId);
            queue.push(childId);
          }
        }
      }

      const txns = store.listTransactions({ dateTo: asOf });
      const balances: Record<string, Rational> = {};
      const accountCurrencies: Record<string, string> = {};
      const malformed: MalformedSplit[] = [];
      for (const id of ids) {
        const acct = idx.byId.get(id);
        if (acct) accountCurrencies[id] = acct.currency;
      }
      for (const t of txns) {
        for (const s of t.splits) {
          if (!ids.has(s.account)) continue;
          const acct = idx.byId.get(s.account);
          if (!acct) continue;
          // Shares are in the account's native commodity.
          const shares = safeFromString(s.shares);
          if (shares == null) {
            malformed.push({ txId: t.id, splitId: s.id, field: "shares", raw: s.shares });
            continue;
          }
          balances[s.account] = add(balances[s.account] ?? ZERO, shares);
        }
      }

      const byAccount = Object.entries(balances).map(([id, bal]) => {
        const acct = idx.byId.get(id)!;
        return {
          id,
          name: acct.name,
          currency: acct.currency,
          balance_rational: rToString(bal),
          balance_decimal: toDecimal(bal, 2),
        };
      });

      let totalConverted: string | null = null;
      if (currency) {
        let total: Rational = ZERO;
        const missing: string[] = [];
        for (const [id, bal] of Object.entries(balances)) {
          const acct = idx.byId.get(id)!;
          const c = convert(store, bal, acct.currency, currency, asOf, { onMissingRate: "skip" });
          if (c == null) {
            missing.push(acct.currency);
            continue;
          }
          total = add(total, c);
        }
        totalConverted = toDecimal(total, 2);
        return ok({
          account: { id: rootId, name: rootAccount.name, currency: rootAccount.currency },
          asOf: asOf ?? new Date().toISOString().slice(0, 10),
          includedAccounts: [...ids],
          byAccount,
          total: { currency, amount: totalConverted, missing_rates: [...new Set(missing)] },
          malformed_splits: malformed,
        });
      }

      return ok({
        account: { id: rootId, name: rootAccount.name, currency: rootAccount.currency },
        asOf: asOf ?? new Date().toISOString().slice(0, 10),
        includedAccounts: [...ids],
        byAccount,
        malformed_splits: malformed,
      });
    }),
  );

  server.registerTool(
    "net_worth",
    {
      title: "Net worth",
      description:
        "Sum asset-like account balances minus liability-like balances as of a date, converted into one base currency. Returns per-currency totals too.",
      inputSchema: {
        asOf: DateStr.optional(),
        baseCurrency: z.string().default("UAH"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ asOf, baseCurrency }) => {
      const idx = store.accountIndex();
      const txns = store.listTransactions({ dateTo: asOf });
      const byAcct = new Map<string, Rational>();
      const malformed: MalformedSplit[] = [];
      for (const t of txns) {
        for (const s of t.splits) {
          const acct = idx.byId.get(s.account);
          if (!acct) continue;
          if (!ASSET_LIKE.has(acct.type) && !LIABILITY_LIKE.has(acct.type)) continue;
          const shares = safeFromString(s.shares);
          if (shares == null) {
            malformed.push({ txId: t.id, splitId: s.id, field: "shares", raw: s.shares });
            continue;
          }
          byAcct.set(s.account, add(byAcct.get(s.account) ?? ZERO, shares));
        }
      }

      const perCurrency = new Map<string, Rational>();
      const missing: string[] = [];
      let total: Rational = ZERO;
      for (const [id, bal] of byAcct) {
        const acct = idx.byId.get(id)!;
        const signed = LIABILITY_LIKE.has(acct.type) ? rneg(bal) : bal;
        perCurrency.set(acct.currency, add(perCurrency.get(acct.currency) ?? ZERO, signed));
        const conv = convert(store, signed, acct.currency, baseCurrency, asOf, { onMissingRate: "skip" });
        if (conv == null) missing.push(acct.currency);
        else total = add(total, conv);
      }
      return ok({
        asOf: asOf ?? new Date().toISOString().slice(0, 10),
        baseCurrency,
        total: toDecimal(total, 2),
        byCurrency: Object.fromEntries([...perCurrency].map(([c, r]) => [c, toDecimal(r, 2)])),
        missingRates: [...new Set(missing)],
        malformed_splits: malformed,
      });
    }),
  );

  server.registerTool(
    "spending_by_category",
    {
      title: "Spending by category",
      description:
        "Aggregate expense (and optionally income) amounts by category over a date range. Amounts are in the transaction's commodity; pass baseCurrency to convert. Pass account to restrict to transactions that touched a specific account (e.g. a bank card).",
      inputSchema: {
        dateFrom: DateStr,
        dateTo: DateStr,
        kind: z.enum(["expense", "income", "both"]).default("expense"),
        baseCurrency: z.string().optional(),
        top: z.number().int().positive().max(500).optional(),
        account: z.string().optional().describe("Account id or name — only transactions touching this account are included"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ dateFrom, dateTo, kind, baseCurrency, top, account }) => {
      const idx = store.accountIndex();
      const types = kind === "income" ? INCOME_TYPES : kind === "expense" ? EXPENSE_TYPES : new Set([...INCOME_TYPES, ...EXPENSE_TYPES]);
      const accountId = account ? store.resolveAccount(account) : undefined;
      const txns = store.listTransactions({ dateFrom, dateTo, accountId });

      const byAcct = new Map<string, Rational>();
      const malformed: MalformedSplit[] = [];
      for (const t of txns) {
        for (const s of t.splits) {
          const acct = idx.byId.get(s.account);
          if (!acct || !types.has(acct.type)) continue;
          const raw = safeFromString(s.value);
          if (raw == null) {
            malformed.push({ txId: t.id, splitId: s.id, field: "value", raw: s.value });
            continue;
          }
          const signed = signedForType(acct.type, raw);
          let amount: Rational | null = signed;
          if (baseCurrency && t.commodity !== baseCurrency) {
            amount = convert(store, signed, t.commodity, baseCurrency, t.postDate, { onMissingRate: "skip" });
            if (amount == null) continue;
          }
          byAcct.set(s.account, add(byAcct.get(s.account) ?? ZERO, amount));
        }
      }

      const rows = [...byAcct.entries()]
        .map(([id, r]) => {
          const a = idx.byId.get(id)!;
          return {
            id,
            name: a.name,
            path: store.accountPath(id).join(":"),
            type: a.typeName,
            amount: toDecimal(r, 2),
            _raw: r,
          };
        })
        .sort((a, b) => cmp(b._raw, a._raw));

      const total = sum(rows.map((r) => r._raw));
      const limited = top ? rows.slice(0, top) : rows;

      const accountInfo = accountId
        ? { id: accountId, name: idx.byId.get(accountId)?.name ?? accountId }
        : null;
      return ok({
        dateFrom,
        dateTo,
        kind,
        account: accountInfo,
        baseCurrency: baseCurrency ?? null,
        total: toDecimal(total, 2),
        count: limited.length,
        categories: limited.map(({ _raw, ...r }) => r),
        malformed_splits: malformed,
      });
    }),
  );

  server.registerTool(
    "cash_flow",
    {
      title: "Monthly cash flow",
      description:
        "Group income and expense totals by month. Optionally convert to one base currency.",
      inputSchema: {
        dateFrom: DateStr,
        dateTo: DateStr,
        baseCurrency: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ dateFrom, dateTo, baseCurrency }) => {
      const idx = store.accountIndex();
      const txns = store.listTransactions({ dateFrom, dateTo });
      const byMonth = new Map<string, { income: Rational; expense: Rational }>();
      const missing = new Set<string>();
      const malformed: MalformedSplit[] = [];

      for (const t of txns) {
        const month = t.postDate.slice(0, 7);
        const slot = byMonth.get(month) ?? { income: ZERO, expense: ZERO };
        for (const s of t.splits) {
          const acct = idx.byId.get(s.account);
          if (!acct) continue;
          const parsed = safeFromString(s.value);
          if (parsed == null) {
            malformed.push({ txId: t.id, splitId: s.id, field: "value", raw: s.value });
            continue;
          }
          let amount = parsed;
          if (baseCurrency && t.commodity !== baseCurrency) {
            const c = convert(store, amount, t.commodity, baseCurrency, t.postDate, { onMissingRate: "skip" });
            if (c == null) {
              missing.add(t.commodity);
              continue;
            }
            amount = c;
          }
          if (EXPENSE_TYPES.has(acct.type)) slot.expense = add(slot.expense, amount);
          if (INCOME_TYPES.has(acct.type)) slot.income = sub(slot.income, amount);
        }
        byMonth.set(month, slot);
      }

      const months = [...byMonth.keys()].sort();
      const rows = months.map((m) => {
        const s = byMonth.get(m)!;
        return {
          month: m,
          income: toDecimal(s.income, 2),
          expense: toDecimal(s.expense, 2),
          net: toDecimal(sub(s.income, s.expense), 2),
        };
      });
      return ok({
        dateFrom,
        dateTo,
        baseCurrency: baseCurrency ?? null,
        missingRates: [...missing],
        rows,
        malformed_splits: malformed,
      });
    }),
  );
}
