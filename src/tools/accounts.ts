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

  server.registerTool(
    "add_account",
    {
      title: "Add account",
      description:
        "Create a new account under an existing parent. Pass type as a name (e.g. 'Checking', 'Expense') or numeric code. parentAccount accepts an id or name. Set dry_run=true to preview without writing.",
      inputSchema: {
        name: z.string().min(1).describe("Account display name"),
        type: z
          .union([z.number(), z.string()])
          .describe("Account type name (e.g. 'Checking', 'Expense') or numeric code"),
        currency: z.string().min(1).describe("3-letter currency code, e.g. 'USD'"),
        parentAccount: z.string().describe("Parent account id or name"),
        number: z.string().optional().describe("Account number"),
        description: z.string().optional(),
        institution: z.string().optional().describe("Institution id"),
        opened: z.string().optional().describe("Opening date YYYY-MM-DD"),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ name, type, currency, parentAccount, number, description, institution, opened, dry_run }) => {
      const typeNum = resolveTypes([type])![0]!;
      const parentId = store.resolveAccount(parentAccount);
      if (dry_run) {
        return ok({
          dry_run: true,
          would_add: { name, type: typeNum, currency, parentAccount: parentId, number, description, institution, opened },
        });
      }
      const account = await store.mutate(() =>
        store.addAccount({ name, type: typeNum, currency, parentAccount: parentId, number, description, institution, opened }),
      );
      return ok({ created: account });
    }),
  );

  server.registerTool(
    "update_account",
    {
      title: "Update account",
      description:
        "Patch an account's name, number, description, or institution. Only provided fields are changed; pass null to clear an optional field. Set dry_run=true to preview without writing.",
      inputSchema: {
        id: z.string().describe("Account id (e.g. A000001)"),
        name: z.string().optional().describe("New display name"),
        number: z.string().nullish().describe("Account number; null to clear"),
        description: z.string().nullish().describe("Description; null to clear"),
        institution: z.string().nullish().describe("Institution id; null to clear"),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, name, number, description, institution, dry_run }) => {
      const existing = store.getAccount(id);
      if (!existing) return ok({ found: false });
      if (dry_run) {
        const preview = {
          ...existing,
          ...(name !== undefined && { name }),
          ...(number !== undefined && { number: number ?? undefined }),
          ...(description !== undefined && { description: description ?? undefined }),
          ...(institution !== undefined && { institution: institution ?? undefined }),
        };
        return ok({ dry_run: true, account: preview });
      }
      const updated = await store.mutate(() =>
        store.updateAccount(id, { name, number, description, institution }),
      );
      return ok({ account: updated });
    }),
  );
}
