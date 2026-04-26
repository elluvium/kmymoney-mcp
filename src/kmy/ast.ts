/**
 * Helpers for navigating and mutating the preserve-order AST produced by
 * fast-xml-parser. Every AST node is `{ [tagName]: AstNode[], ":@"?: { [attr]: string } }`.
 * For the `?xml` processing instruction and text nodes the `[tagName]` key is
 * `?xml` or `#text` respectively.
 */

export type AstAttrs = Record<string, string>;

export interface AstNode {
  [key: string]: unknown;
  ":@"?: AstAttrs;
}

export type AstChildren = AstNode[];

const ATTR_PREFIX = "@_";

/** Return the element tag name of a node (ignoring attrs / text keys). */
export function tagOf(node: AstNode): string | null {
  for (const k of Object.keys(node)) {
    if (k !== ":@") return k;
  }
  return null;
}

/** Return children array of a node (empty array if self-closing). */
export function childrenOf(node: AstNode): AstChildren {
  const tag = tagOf(node);
  if (!tag) return [];
  const v = node[tag];
  return Array.isArray(v) ? (v as AstChildren) : [];
}

/** Find the first child element with the given tag name. */
export function findChild(node: AstNode, tag: string): AstNode | null {
  for (const child of childrenOf(node)) {
    if (tagOf(child) === tag) return child;
  }
  return null;
}

/** Return all child elements with the given tag name. */
export function findChildren(node: AstNode, tag: string): AstNode[] {
  return childrenOf(node).filter((c) => tagOf(c) === tag);
}

/** Get an attribute value (without the "@_" prefix). Returns "" if absent. */
export function attr(node: AstNode, name: string): string {
  return node[":@"]?.[ATTR_PREFIX + name] ?? "";
}

/** Set an attribute value. Creates the ":@" bag if missing. */
export function setAttr(node: AstNode, name: string, value: string): void {
  if (!node[":@"]) node[":@"] = {};
  node[":@"]![ATTR_PREFIX + name] = value;
}

/** Return all attributes as a plain object without the "@_" prefix. */
export function allAttrs(node: AstNode): AstAttrs {
  const bag = node[":@"];
  if (!bag) return {};
  const out: AstAttrs = {};
  for (const [k, v] of Object.entries(bag)) {
    if (k.startsWith(ATTR_PREFIX)) out[k.slice(ATTR_PREFIX.length)] = v;
  }
  return out;
}

/** Create a new element node. */
export function makeNode(
  tag: string,
  attrs: AstAttrs = {},
  children: AstChildren = [],
): AstNode {
  const node: AstNode = { [tag]: children };
  const a: AstAttrs = {};
  for (const [k, v] of Object.entries(attrs)) a[ATTR_PREFIX + k] = v;
  if (Object.keys(a).length > 0) node[":@"] = a;
  return node;
}

/** Read KEYVALUEPAIRS child into a { key → value } map. */
export function readKeyValues(parent: AstNode): Record<string, string> {
  const kvp = findChild(parent, "KEYVALUEPAIRS");
  if (!kvp) return {};
  const out: Record<string, string> = {};
  for (const pair of findChildren(kvp, "PAIR")) {
    out[attr(pair, "key")] = attr(pair, "value");
  }
  return out;
}

/** Replace KEYVALUEPAIRS child with the entries from `values`. */
export function writeKeyValues(parent: AstNode, values: Record<string, string>): void {
  const kids = childrenOf(parent);
  const idx = kids.findIndex((c) => tagOf(c) === "KEYVALUEPAIRS");
  const pairs = Object.entries(values).map(([k, v]) =>
    makeNode("PAIR", { value: v, key: k }, []),
  );
  if (pairs.length === 0) {
    if (idx !== -1) kids.splice(idx, 1);
    return;
  }
  const kvp = makeNode("KEYVALUEPAIRS", {}, pairs);
  if (idx === -1) kids.push(kvp);
  else kids[idx] = kvp;
}

/** Locate the KMYMONEY-FILE root node inside the top-level AST array. */
export function findRoot(ast: AstNode[]): AstNode {
  for (const n of ast) {
    if (tagOf(n) === "KMYMONEY-FILE") return n;
  }
  throw new Error("KMYMONEY-FILE root element not found");
}

/** Locate a named top-level section (PAYEES, ACCOUNTS, …). Creates it if missing. */
export function ensureSection(root: AstNode, tag: string): AstNode {
  let section = findChild(root, tag);
  if (!section) {
    section = makeNode(tag, { count: "0" }, []);
    childrenOf(root).push(section);
  }
  return section;
}
