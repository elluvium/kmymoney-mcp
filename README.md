# KMyMoney MCP Server

A Model Context Protocol server that exposes a [KMyMoney](https://kmymoney.org/) data file (`.kmy`, gzipped XML) to MCP clients such as Claude Code or Claude Desktop.

## Features

- Read tools: accounts, categories, transactions, payees, tags, institutions, budgets, currencies, securities, prices.
- Analytics: balances, net worth, spending by category, income by source, monthly cash flow.
- Write tools with validation: add / update / delete transactions, payees, tags, accounts, budgets — all with optional `dry_run`.
- Safe saves: atomic rename + rolling `.1~ … .10~` backups (matches KMyMoney's own convention).
- Exact rational arithmetic (no floating-point drift for money).
- Transport: stdio.

## Requirements

- Node.js ≥ 20.
- A KMyMoney `.kmy` file (gzipped XML format).

## Install & build

```bash
npm install
npm run build
```

## Configure

Set `KMYMONEY_FILE` in your environment (or a `.env` file — see `.env.example`). Optionally set `KMY_AUTOSAVE` to one of `false`, `0`, `no`, or `off` to disable auto-save after each mutation and require an explicit `kmy_save` call. Any other value (including unset) leaves auto-save enabled.

## Use with Claude Code / Claude Desktop

Add an entry to your MCP client config (e.g. `~/.claude.json` or `.mcp.json` in the project):

```json
{
  "mcpServers": {
    "kmymoney": {
      "command": "node",
      "args": ["/absolute/path/to/kmymoney-mcp/dist/index.js"],
      "env": {
        "KMYMONEY_FILE": "/absolute/path/to/your.kmy"
      }
    }
  }
}
```

For development you can point at `tsx` instead:

```json
{
  "command": "npx",
  "args": ["tsx", "/absolute/path/to/kmymoney-mcp/src/index.ts"],
  "env": { "KMYMONEY_FILE": "..." }
}
```

## Safety

Writes are atomic:

1. A `.lock` file is created with `O_EXCL` (stale locks > 60 s are reclaimed) so two `kmymoney-mcp` processes can't clobber each other's rotation.
2. The new document is written to a sibling `.tmp` file.
3. Existing backups rotate (`.9~ → .10~`, …, `.1~ → .2~`; the old `.10~` is discarded).
4. The live file is hard-linked to `.1~`, so the original inode is preserved under two names.
5. The `.tmp` file is renamed onto the live path atomically — the old inode stays reachable via `.1~`.

If any step after the temp write fails, the temp is removed and the tool attempts to restore the live file from `.1~`. Backups already rotated in step 3 are not unrotated. Close KMyMoney before mutating — it does not coordinate on `.lock` files.

## Scripts

- `npm run dev` — run via tsx without building.
- `npm test` — vitest suite (round-trip parse/serialize against `data/bgt.kmy`, backup rotation, money arithmetic, tool handlers).
- `npm run typecheck` — `tsc --noEmit`.

## License

MIT.
