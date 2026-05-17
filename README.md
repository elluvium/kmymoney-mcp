# KMyMoney MCP Server

MCP server for [KMyMoney](https://kmymoney.org/) `.kmy` files. It runs over stdio and lets MCP clients query and mutate a gzipped XML KMyMoney file.

## Requirements

- Node.js 20 or newer.
- A KMyMoney `.kmy` file.
- Close KMyMoney before using write tools; KMyMoney does not coordinate with this server's lock file.

## Install

```bash
npm install -g kmymoney-mcp
```

Or run without installing globally:

```bash
npx -y kmymoney-mcp
```

## Configure

The server requires `KMYMONEY_FILE`.

`KMY_AUTOSAVE` is optional and defaults to enabled. Set it to `false`, `0`, `no`, or `off` to keep changes in memory until `kmy_save` is called. Set it to `true`, `1`, `yes`, or `on` to enable autosave explicitly.

Example MCP config:

```json
{
  "mcpServers": {
    "kmymoney": {
      "command": "npx",
      "args": ["-y", "kmymoney-mcp"],
      "env": {
        "KMYMONEY_FILE": "/absolute/path/to/your.kmy"
      }
    }
  }
}
```

For a local checkout:

```bash
npm install
npm run build
```

```json
{
  "command": "node",
  "args": ["/absolute/path/to/kmymoney-mcp/dist/index.js"],
  "env": {
    "KMYMONEY_FILE": "/absolute/path/to/your.kmy"
  }
}
```

## Tools

Read tools:

- File metadata and save/reload controls.
- Accounts, categories, transactions, payees, tags, institutions.
- Currencies, securities, prices, budgets.
- Account balances, net worth, spending/income by category, monthly cash flow.

Write tools:

- Add/update accounts.
- Add/update/delete transactions.
- Add/update/delete payees.
- Add/delete tags.

All mutation tools support `dry_run: true`.

## Safety

Writes use a sibling `.lock` file, a temporary file, atomic rename, and rolling backups named `.1~` through `.10~`. With autosave enabled, each successful mutation is saved immediately. With autosave disabled, call `kmy_save` to persist pending changes or `kmy_reload` to discard them and reload from disk.

## Development

```bash
npm run typecheck
npm test
npm run build
node tests/smoke.mjs
```

## License

MIT
