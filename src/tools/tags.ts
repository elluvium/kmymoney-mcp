import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";

export function registerTagTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "List all tags.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => ok({ count: store.listTags().length, tags: store.listTags() })),
  );

  server.registerTool(
    "add_tag",
    {
      title: "Add tag",
      inputSchema: {
        name: z.string().min(1),
        color: z.string().optional(),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ name, color, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, would_add: { name, color } });
      const t = await store.mutate(() => store.addTag({ name, color }));
      return ok({ created: t });
    }),
  );

  server.registerTool(
    "delete_tag",
    {
      title: "Delete tag",
      description: "Delete a tag. Fails if referenced by any transaction split.",
      inputSchema: { id: z.string(), dry_run: z.boolean().optional().default(false) },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id, dry_run }) => {
      if (dry_run) return ok({ dry_run: true, would_delete: id });
      await store.mutate(() => store.deleteTag(id));
      return ok({ deleted: id });
    }),
  );
}
