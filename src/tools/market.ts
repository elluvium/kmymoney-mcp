import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "../kmy/store.js";
import { ok, safe } from "../util/result.js";
import { DateStr } from "../util/schemas.js";

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerMarketTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_currencies",
    { title: "List currencies", inputSchema: {}, annotations: READ_ANNOTATIONS },
    safe(async () => ok({ currencies: store.listCurrencies() })),
  );

  server.registerTool(
    "list_securities",
    { title: "List securities", inputSchema: {}, annotations: READ_ANNOTATIONS },
    safe(async () => ok({ securities: store.listSecurities() })),
  );

  server.registerTool(
    "list_prices",
    {
      title: "List prices",
      description: "List exchange / security prices from PRICEPAIRs.",
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        dateFrom: DateStr.optional(),
        dateTo: DateStr.optional(),
      },
      annotations: READ_ANNOTATIONS,
    },
    safe(async ({ from, to, dateFrom, dateTo }) =>
      ok({ prices: store.listPrices({ from, to, dateFrom, dateTo }) }),
    ),
  );

  server.registerTool(
    "list_budgets",
    { title: "List budgets", inputSchema: {}, annotations: READ_ANNOTATIONS },
    safe(async () => ok({ budgets: store.listBudgets() })),
  );

  server.registerTool(
    "get_budget",
    {
      title: "Get budget",
      inputSchema: { id: z.string() },
      annotations: READ_ANNOTATIONS,
    },
    safe(async ({ id }) => ok(store.getBudget(id) ?? { found: false })),
  );
}
