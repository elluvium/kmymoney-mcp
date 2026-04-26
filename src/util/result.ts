/**
 * Helpers to shape MCP tool results. Every handler returns `{ content: [...] }`
 * where the content is a single `text` block of JSON (nice for LLM consumption).
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function error(message: string): ToolResult & { isError: true } {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Wrap a tool handler so thrown errors surface as a tool-level error
 * (`isError: true`) instead of a transport-level JSON-RPC failure. This keeps
 * user-facing validation issues (unbalanced splits, unknown accounts, bad
 * dates) distinguishable from harness errors.
 */
export function safe<Args>(
  fn: (args: Args) => Promise<ToolResult> | ToolResult,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args) => {
    try {
      return await fn(args);
    } catch (e) {
      return error(e instanceof Error ? e.message : String(e));
    }
  };
}
