import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";

export function registerInstitutionTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_institutions",
    {
      title: "List institutions",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async () =>
      ok({ count: store.listInstitutions().length, institutions: store.listInstitutions() }),
    ),
  );

  server.registerTool(
    "get_institution",
    {
      title: "Get institution",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ id }) => ok(store.getInstitution(id) ?? { found: false })),
  );
}
