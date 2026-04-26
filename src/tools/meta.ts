import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";

export function registerMetaTools(server: McpServer, store: Store): void {
  server.registerTool(
    "kmy_file_info",
    {
      title: "File summary",
      description:
        "Return the file's version, user, last-modified date, and counts of every entity kind.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async () => ok(store.summary())),
  );

  server.registerTool(
    "kmy_save",
    {
      title: "Save pending changes",
      description:
        "Explicitly flush the in-memory document to disk with a rolling backup. Only needed if auto-save is disabled.",
      inputSchema: {},
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async () => {
      await store.save();
      return ok({ saved: true });
    }),
  );

  server.registerTool(
    "kmy_reload",
    {
      title: "Reload file from disk",
      description: "Discard any unsaved in-memory state and re-read the file.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true to proceed"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ confirm }) => {
      if (!confirm) return ok({ reloaded: false, reason: "confirm=false" });
      await store.reload();
      return ok({ reloaded: true });
    }),
  );
}
