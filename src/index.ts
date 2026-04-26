#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Store } from "./kmy/store.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Log to stderr only — stdout is reserved for MCP's JSON-RPC framing.
  process.stderr.write(
    `[kmymoney-mcp] opening ${config.filePath} (autosave=${config.autosave})\n`,
  );
  const store = await Store.open(config.filePath, { autosave: config.autosave });
  const server = buildServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[kmymoney-mcp] ready on stdio\n");

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      process.stderr.write(`[kmymoney-mcp] second ${signal}, forcing exit\n`);
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write(`[kmymoney-mcp] ${signal} received, draining...\n`);
    store
      .drain()
      .catch((err) => {
        process.stderr.write(
          `[kmymoney-mcp] drain failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[kmymoney-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
