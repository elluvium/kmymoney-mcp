import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";
import { ACCOUNT_TYPE_NAMES } from "../kmy/types.js";

const TYPE_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(ACCOUNT_TYPE_NAMES).map(([k, v]) => [v.toLowerCase(), Number(k)]),
);

function resolveTypes(input: (number | string)[] | undefined): number[] | undefined {
  if (!input) return undefined;
  return input.map((t) => {
    if (typeof t === "number") return t;
    const n = TYPE_BY_NAME[t.toLowerCase()];
    if (n == null) throw new Error(`unknown account type: ${t}`);
    return n;
  });
}

export function registerAccountTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List accounts, optionally filtered. Categories are accounts of type Income or Expense. Use type=['Income','Expense'] for categories, or the dedicated list_categories tool.",
      inputSchema: {
        type: z
          .array(z.union([z.number(), z.string()]))
          .optional()
          .describe("Filter by account type (numeric code or name like 'Checking', 'Expense')"),
        institution: z.string().optional(),
        currency: z.string().optional(),
        parentAccount: z.string().optional(),
        nameContains: z.string().optional(),
        includeStandardRoots: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ type, institution, currency, parentAccount, nameContains, includeStandardRoots }) => {
      const types = resolveTypes(type);
      const accounts = store.listAccounts({
        type: types,
        institution,
        currency,
        parentAccount,
        nameContains,
        includeStandardRoots: includeStandardRoots ?? false,
      });
      return ok({ count: accounts.length, accounts });
    }),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description: "Fetch a single account by id or name (case-insensitive).",
      inputSchema: {
        idOrName: z.string().describe("Account id (e.g. A000001) or name"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ idOrName }) => {
      const id = store.resolveAccount(idOrName);
      const account = store.getAccount(id);
      if (!account) return ok({ found: false });
      const path = store.accountPath(id);
      return ok({ found: true, account, path: path.join(":") });
    }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "List expense and income categories (accounts of type Income/Expense). Categories in KMyMoney are just accounts under the Income or Expense hierarchies.",
      inputSchema: {
        kind: z.enum(["income", "expense", "both"]).optional(),
        nameContains: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ kind = "both", nameContains }) => {
      const types =
        kind === "income" ? [12] : kind === "expense" ? [13] : [12, 13];
      const accounts = store.listAccounts({ type: types, nameContains });
      const decorated = accounts.map((a) => ({
        ...a,
        path: store.accountPath(a.id).join(":"),
      }));
      return ok({ count: decorated.length, categories: decorated });
    }),
  );
}
