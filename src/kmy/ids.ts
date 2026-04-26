/**
 * Each KMyMoney entity kind has a prefixed, zero-padded numeric ID:
 *   - A######              account (standard roots like "AStd::Asset" are excluded)
 *   - I######              institution
 *   - P######              payee
 *   - G######              tag
 *   - E######              security
 *   - B######              budget
 *   - R######              report
 *   - T##################  transaction (18 digits — always handled as BigInt)
 *   - S####                split (local to a transaction)
 */

export const ID_FORMATS = {
  account: { prefix: "A", width: 6 },
  institution: { prefix: "I", width: 6 },
  payee: { prefix: "P", width: 6 },
  tag: { prefix: "G", width: 6 },
  security: { prefix: "E", width: 6 },
  budget: { prefix: "B", width: 6 },
  report: { prefix: "R", width: 6 },
  transaction: { prefix: "T", width: 18 },
  split: { prefix: "S", width: 4 },
  costCenter: { prefix: "C", width: 6 },
} as const;

export type IdKind = keyof typeof ID_FORMATS;

/** Format a numeric id with the right prefix/width for its kind. */
export function formatId(kind: IdKind, n: number | bigint): string {
  const { prefix, width } = ID_FORMATS[kind];
  return prefix + n.toString().padStart(width, "0");
}

/**
 * Extract the numeric part of an ID string as a bigint. Returns null for
 * unrecognized formats (e.g. "AStd::Asset" standard-root accounts). BigInt is
 * used uniformly so 18-digit transaction IDs do not lose precision past 2^53.
 */
export function parseId(kind: IdKind, id: string): bigint | null {
  const { prefix, width } = ID_FORMATS[kind];
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  // Accept the canonical width AND anything wider that is still pure digits —
  // lets an overflow ID like "S10000" be recognized as the legitimate next
  // number instead of silently falling back to 0 and colliding.
  if (rest.length < width || !/^\d+$/.test(rest)) return null;
  return BigInt(rest);
}

/** Generator that yields the next free id given a set of existing ids. */
export function makeIdGenerator(kind: IdKind, existing: Iterable<string>): () => string {
  let max = 0n;
  for (const id of existing) {
    const n = parseId(kind, id);
    if (n != null && n > max) max = n;
  }
  return () => {
    max += 1n;
    return formatId(kind, max);
  };
}
