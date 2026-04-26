import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseXml, serializeXml } from "../src/kmy/parser.js";
import { tagOf, childrenOf, findRoot } from "../src/kmy/ast.js";

function decompress(path: string): string {
  return gunzipSync(readFileSync(path)).toString("utf8");
}

describe("XML parser/serializer round-trip", () => {
  const original = decompress("data/bgt.kmy");

  it("parses and lists expected top-level sections with counts", () => {
    const ast = parseXml(original);
    const root = findRoot(ast);
    const counts: Record<string, number> = {};
    for (const child of childrenOf(root)) {
      const tag = tagOf(child);
      if (!tag) continue;
      const kids = childrenOf(child);
      counts[tag] = kids.length;
    }
    expect(counts.INSTITUTIONS).toBe(6);
    expect(counts.PAYEES).toBe(17);
    expect(counts.TAGS).toBe(1);
    expect(counts.ACCOUNTS).toBe(115);
    expect(counts.TRANSACTIONS).toBe(1197);
    expect(counts.SECURITIES).toBe(4);
    expect(counts.CURRENCIES).toBe(4);
    expect(counts.PRICES).toBe(9);
    expect(counts.BUDGETS).toBe(1);
  });

  it("is idempotent: parse → serialize → parse yields identical counts", () => {
    const ast1 = parseXml(original);
    const xml = serializeXml(ast1);
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml.includes("<!DOCTYPE KMYMONEY-FILE>")).toBe(true);

    const ast2 = parseXml(xml);
    const root1 = findRoot(ast1);
    const root2 = findRoot(ast2);

    const gather = (root: ReturnType<typeof findRoot>) => {
      const out: Record<string, number> = {};
      for (const c of childrenOf(root)) {
        const t = tagOf(c);
        if (!t) continue;
        out[t] = childrenOf(c).length;
      }
      return out;
    };
    expect(gather(root2)).toEqual(gather(root1));
  });

  it("preserves the original byte length within a small tolerance", () => {
    const ast = parseXml(original);
    const xml = serializeXml(ast);
    // Small delta expected (trailing newline, minor whitespace). Should not be > 0.5%.
    const ratio = Math.abs(xml.length - original.length) / original.length;
    expect(ratio).toBeLessThan(0.005);
  });

  it("preserves memo attribute values with leading/trailing whitespace", () => {
    const input = [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<!DOCTYPE KMYMONEY-FILE>",
      '<KMYMONEY-FILE><TRANSACTIONS><TRANSACTION id="T1" memo=" note with spaces " /></TRANSACTIONS></KMYMONEY-FILE>',
    ].join("\n");
    const ast = parseXml(input);
    const out = serializeXml(ast);
    expect(out).toContain('memo=" note with spaces "');
  });

  it("always emits DOCTYPE, even if the input had no <?xml ?> PI", () => {
    const input = '<KMYMONEY-FILE><FOO id="x"/></KMYMONEY-FILE>';
    const ast = parseXml(input);
    const out = serializeXml(ast);
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain("<!DOCTYPE KMYMONEY-FILE>");
  });
});
