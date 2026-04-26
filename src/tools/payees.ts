import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";

export function registerPayeeTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_payees",
    {
      title: "List payees",
      description: "List all payees.",
      inputSchema: {
        nameContains: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ nameContains }) => {
      let payees = store.listPayees();
      if (nameContains) {
        const n = nameContains.toLowerCase();
        payees = payees.filter((p) => p.name.toLowerCase().includes(n));
      }
      return ok({ count: payees.length, payees });
    }),
  );

  server.registerTool(
    "get_payee",
    {
      title: "Get payee",
      description: "Fetch a single payee by id.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => ok(store.getPayee(id) ?? { found: false })),
  );

  server.registerTool(
    "add_payee",
    {
      title: "Add payee",
      description: "Create a new payee.",
      inputSchema: {
        name: z.string().min(1),
        email: z.string().optional(),
        reference: z.string().optional(),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ name, email, reference, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, would_add: { name, email, reference } });
      const p = await store.mutate(() => store.addPayee({ name, email, reference }));
      return ok({ created: p });
    }),
  );

  server.registerTool(
    "update_payee",
    {
      title: "Update payee",
      description:
        "Patch a payee. Only fields present in the call are changed; pass `null` on any optional field to clear it.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        email: z.string().nullish().describe("null to clear"),
        reference: z.string().nullish().describe("null to clear"),
        defaultAccountId: z.string().nullish().describe("null to clear"),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ id, name, email, reference, defaultAccountId, dry_run }) => {
      if (dry_run)
        return ok({ dry_run: true, patch: { id, name, email, reference, defaultAccountId } });
      const p = await store.mutate(() =>
        store.updatePayee(id, { name, email, reference, defaultAccountId }),
      );
      return ok({ updated: p });
    }),
  );

  server.registerTool(
    "delete_payee",
    {
      title: "Delete payee",
      description: "Remove a payee. Fails if any transaction references it.",
      inputSchema: {
        id: z.string(),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, would_delete: id });
      await store.mutate(() => store.deletePayee(id));
      return ok({ deleted: id });
    }),
  );
}
