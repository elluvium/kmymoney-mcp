import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./kmy/store.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerPayeeTools } from "./tools/payees.js";
import { registerTagTools } from "./tools/tags.js";
import { registerInstitutionTools } from "./tools/institutions.js";
import { registerMarketTools } from "./tools/market.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerReportTools } from "./tools/reports.js";

export function buildServer(store: Store): McpServer {
  const server = new McpServer(
    {
      name: "kmymoney-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Tools for querying and mutating a KMyMoney personal-finance file. " +
        "Monetary values are rational strings like '12345/100'; helper fields add decimal representations. " +
        "Categories are accounts of type Income (12) or Expense (13) — use list_categories. " +
        "All mutation tools accept `dry_run: true` to preview without writing.",
    },
  );

  registerMetaTools(server, store);
  registerAccountTools(server, store);
  registerTransactionTools(server, store);
  registerPayeeTools(server, store);
  registerTagTools(server, store);
  registerInstitutionTools(server, store);
  registerMarketTools(server, store);
  registerReportTools(server, store);

  return server;
}
