#!/usr/bin/env node
/**
 * End-to-end smoke test: spawn the built server with stdio, handshake, list
 * tools, then call a few. Print results. Used for manual verification — not
 * part of the vitest suite.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await fs.mkdtemp(join(tmpdir(), "kmy-smoke-"));
const filePath = join(dir, "smoke.kmy");
await fs.copyFile("data/bgt.kmy", filePath);

const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, KMYMONEY_FILE: filePath, KMY_AUTOSAVE: "false" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await send("tools/list", {});
  console.log("TOOLS:", tools.result.tools.map((t) => t.name).join(", "));

  const info = await send("tools/call", { name: "kmy_file_info", arguments: {} });
  console.log("FILE INFO:");
  console.log(info.result.content[0].text);

  const nw = await send("tools/call", {
    name: "net_worth",
    arguments: { asOf: "2026-02-28", baseCurrency: "UAH" },
  });
  console.log("\nNET WORTH (UAH as of 2026-02-28):");
  console.log(nw.result.content[0].text);

  const spend = await send("tools/call", {
    name: "spending_by_category",
    arguments: { dateFrom: "2025-01-01", dateTo: "2025-12-31", top: 5 },
  });
  console.log("\nTOP 5 SPENDING CATEGORIES 2025:");
  console.log(spend.result.content[0].text);

  const dryAdd = await send("tools/call", {
    name: "add_payee",
    arguments: { name: "Smoke Test Payee", dry_run: true },
  });
  console.log("\nDRY-RUN add_payee:");
  console.log(dryAdd.result.content[0].text);
} finally {
  child.stdin.end();
  await once(child, "exit");
  await fs.rm(dir, { recursive: true, force: true });
}
