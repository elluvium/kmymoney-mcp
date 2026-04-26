import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";
import { DateStr } from "../util/schemas.js";
import { fromDecimal, fromString, isZero, sum, toDecimal, toString as rToString } from "../kmy/money.js";
import type { Transaction } from "../kmy/types.js";

const SplitInputSchema = z.object({
  id: z.string().optional().describe("Existing split id (e.g. S0001) to preserve on update"),
  account: z.string().describe("Account id or name (resolved server-side)"),
  /**
   * Amount can be given as either a decimal string ("-50.00") via `amount`
   * or a rational string ("-5000/100") via `value`. `shares` defaults to value
   * when currencies match.
   */
  amount: z.string().optional().describe("Signed decimal amount, e.g. '-50.00'"),
  value: z.string().optional().describe("Signed rational, e.g. '-5000/100'"),
  shares: z.string().optional(),
  price: z.string().optional().describe("Rational price, defaults to 1/1"),
  memo: z.string().optional(),
  payee: z.string().optional().describe("Payee id (e.g. P000001)"),
  action: z.string().optional(),
  reconcileFlag: z.string().optional(),
  reconcileDate: DateStr.optional(),
  number: z.string().optional(),
  bankId: z.string().optional(),
  tags: z.array(z.string()).optional().describe("Tag ids"),
});

export type SplitInput = z.infer<typeof SplitInputSchema>;

function decorate(store: Pick<Store, "accountPath">, t: Transaction) {
  return {
    ...t,
    splits: t.splits.map((s) => ({
      ...s,
      accountPath: store.accountPath(s.account).join(":") || null,
      decimal: safeDecimal(s.value),
    })),
  };
}

function safeDecimal(rat: string): string | null {
  try {
    return toDecimal(fromString(rat), 2);
  } catch {
    return null;
  }
}

export function registerTransactionTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List/filter transactions. All filters are optional and combine with AND. Results are sorted by postDate ascending by default.",
      inputSchema: {
        dateFrom: DateStr.optional().describe("Inclusive YYYY-MM-DD"),
        dateTo: DateStr.optional().describe("Inclusive YYYY-MM-DD"),
        account: z.string().optional().describe("Account id or name"),
        payee: z.string().optional().describe("Payee id"),
        tag: z.string().optional().describe("Tag id"),
        category: z.string().optional().describe("Category (expense/income account) id or name"),
        memoContains: z.string().optional(),
        commodity: z.string().optional(),
        limit: z.number().int().positive().max(5000).optional(),
        offset: z.number().int().min(0).optional(),
        sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort by postDate, default asc"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ dateFrom, dateTo, account, payee, tag, category, memoContains, commodity, limit, offset, sortOrder }) => {
      const accountId = account ? store.resolveAccount(account) : undefined;
      const categoryId = category ? store.resolveAccount(category) : undefined;
      const txns = store.listTransactions({
        dateFrom,
        dateTo,
        accountId,
        payeeId: payee,
        tagId: tag,
        categoryId,
        memoContains,
        commodity,
        limit,
        offset,
        sortOrder,
      });
      return ok({
        count: txns.length,
        transactions: txns.map((t) => decorate(store, t)),
      });
    }),
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get transaction",
      description: "Fetch a single transaction with its splits.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => {
      const t = store.getTransaction(id);
      if (!t) return ok({ found: false });
      return ok({ found: true, transaction: decorate(store, t) });
    }),
  );

  server.registerTool(
    "add_transaction",
    {
      title: "Add transaction",
      description:
        "Create a new balanced transaction. Splits must sum to zero in the transaction commodity. Provide amounts as either `amount` (decimal) or `value` (rational). Set dry_run=true to preview without writing.",
      inputSchema: {
        postDate: DateStr.describe("YYYY-MM-DD"),
        entryDate: DateStr.optional(),
        commodity: z.string().describe("3-letter currency code, e.g. 'UAH'"),
        memo: z.string().optional(),
        splits: z.array(SplitInputSchema).min(2),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ postDate, entryDate, commodity, memo, splits, dry_run }) => {
      const resolved = splits.map((s) => {
        const accountId = store.resolveAccount(s.account);
        const value = s.value ?? (s.amount != null ? rToString(fromDecimal(s.amount)) : undefined);
        if (!value) throw new Error("each split needs `amount` or `value`");
        const shares = s.shares ?? value;
        return {
          account: accountId,
          value,
          shares,
          price: s.price ?? "1/1",
          memo: s.memo,
          payee: s.payee,
          action: s.action,
          reconcileFlag: s.reconcileFlag,
          reconcileDate: s.reconcileDate,
          number: s.number,
          bankId: s.bankId,
          tags: s.tags,
        };
      });

      if (dry_run) {
        const total = sum(resolved.map((s) => fromString(s.value)));
        return ok({
          dry_run: true,
          would_add: { postDate, entryDate, commodity, memo, splits: resolved },
          balance_check: isZero(total) ? "ok" : `unbalanced: ${rToString(total)}`,
        });
      }

      const result = await store.mutate(() =>
        store.addTransaction({ postDate, entryDate, commodity, memo, splits: resolved }),
      );
      return ok({ created: decorate(store, result) });
    }),
  );

  server.registerTool(
    "update_transaction",
    {
      title: "Update transaction",
      description:
        "Patch a transaction. Only fields present in the call are changed; pass `null` to clear an optional field (e.g. memo). To modify splits, pass the full new splits array. Include each split's existing `id` to preserve identity; new splits will be assigned fresh ids.",
      inputSchema: {
        id: z.string(),
        postDate: DateStr.optional(),
        entryDate: DateStr.optional(),
        memo: z.string().nullish().describe("null to clear"),
        commodity: z.string().optional(),
        splits: z.array(SplitInputSchema).optional(),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ id, postDate, entryDate, memo, commodity, splits, dry_run }) => {
      const resolvedSplits = splits?.map((s) => {
        const accountId = store.resolveAccount(s.account);
        const value = s.value ?? (s.amount != null ? rToString(fromDecimal(s.amount)) : undefined);
        if (!value) throw new Error("each split needs `amount` or `value`");
        return {
          id: s.id,
          account: accountId,
          value,
          shares: s.shares ?? value,
          price: s.price ?? "1/1",
          memo: s.memo,
          payee: s.payee,
          action: s.action,
          reconcileFlag: s.reconcileFlag,
          reconcileDate: s.reconcileDate,
          number: s.number,
          bankId: s.bankId,
          tags: s.tags,
        };
      });
      if (dry_run)
        return ok({
          dry_run: true,
          patch: { postDate, entryDate, memo, commodity, splits: resolvedSplits },
        });
      const result = await store.mutate(() =>
        store.updateTransaction(id, {
          postDate,
          entryDate,
          memo,
          commodity,
          splits: resolvedSplits,
        }),
      );
      return ok({ updated: decorate(store, result) });
    }),
  );

  server.registerTool(
    "delete_transaction",
    {
      title: "Delete transaction",
      description: "Remove a transaction by id.",
      inputSchema: {
        id: z.string(),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, dry_run }) => {
      const existing = store.getTransaction(id);
      if (!existing) return ok({ found: false });
      if (dry_run) return ok({ dry_run: true, would_delete: existing });
      await store.mutate(() => store.deleteTransaction(id));
      return ok({ deleted: id });
    }),
  );
}
