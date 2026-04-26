import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { AstNode } from "./ast.js";
import { tagOf } from "./ast.js";

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  // trimValues MUST stay false — memos like " note " would otherwise round-trip
  // as "note" and we silently lose data. Inter-element indentation is stripped
  // separately in stripWhitespaceText.
  trimValues: false,
  processEntities: true,
  parseAttributeValue: false,
  parseTagValue: false,
} as const;

const BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  format: true,
  indentBy: " ",
  suppressEmptyNode: true,
  processEntities: true,
} as const;

const parser = new XMLParser(PARSER_OPTIONS);
const builder = new XMLBuilder(BUILDER_OPTIONS);

/**
 * Strip whitespace-only #text nodes that live between elements (indentation
 * captured by preserveOrder). We keep text nodes inside leaf elements — memo
 * text, etc. — those are not pure indentation.
 */
function stripWhitespaceText(nodes: AstNode[]): void {
  // A node list is "inter-element indentation" when it also contains real
  // element children. A #text node among other #text nodes (a leaf's mixed
  // content) is not safe to drop.
  const hasElement = nodes.some((n) => {
    const t = tagOf(n);
    return !!t && t !== "#text" && !t.startsWith("?");
  });

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    const tag = tagOf(node);
    if (tag && tag.startsWith("?")) continue; // leave ?xml PI alone
    if (tag === "#text" && hasElement) {
      const raw = (node as Record<string, unknown>)["#text"];
      if (raw == null || raw === "" || (typeof raw === "string" && /^\s*$/.test(raw))) {
        nodes.splice(i, 1);
        continue;
      }
    }
    const tagName = tag;
    if (!tagName) continue;
    const kids = (node as Record<string, unknown>)[tagName];
    if (Array.isArray(kids)) stripWhitespaceText(kids as AstNode[]);
  }
}

export function parseXml(text: string): AstNode[] {
  const ast = parser.parse(text) as AstNode[];
  stripWhitespaceText(ast);
  return ast;
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const DOCTYPE = "<!DOCTYPE KMYMONEY-FILE>";

/**
 * Serialize an AST to KMyMoney's expected on-disk format. Always emits a fresh
 * `<?xml ?>` declaration and `<!DOCTYPE KMYMONEY-FILE>` header regardless of
 * what the builder produces, so we can't silently drop either.
 */
export function serializeXml(ast: AstNode[]): string {
  let body = builder.build(ast) as string;
  // The builder re-emits any ?xml PI it finds in the AST. Strip it — we always
  // write our own canonical header so the DOCTYPE insertion is unconditional.
  body = body.replace(/^\s*<\?xml[^>]*\?>\r?\n?/, "");
  let out = `${XML_DECL}\n${DOCTYPE}\n${body}`;
  if (!out.endsWith("\n")) out += "\n";
  return out;
}
