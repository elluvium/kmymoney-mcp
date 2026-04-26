/**
 * KMyMoney stores all monetary values as rational strings like "12345/100"
 * or "-60569/20". Using floating-point would accumulate drift. This module
 * provides exact arithmetic on reduced fractions of bigints.
 */

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

function reduce(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error("rational denominator is zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export const ZERO: Rational = { num: 0n, den: 1n };
export const ONE: Rational = { num: 1n, den: 1n };

export function fromString(s: string): Rational {
  if (typeof s !== "string") throw new Error(`rational expected string, got ${typeof s}`);
  const trimmed = s.trim();
  if (trimmed === "") return ZERO;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    // integer like "0" or "1"
    return reduce(BigInt(trimmed), 1n);
  }
  const num = BigInt(trimmed.slice(0, slash));
  const den = BigInt(trimmed.slice(slash + 1));
  return reduce(num, den);
}

export function toString(r: Rational): string {
  return `${r.num}/${r.den}`;
}

export function fromInt(n: number | bigint): Rational {
  return { num: BigInt(n), den: 1n };
}

export function add(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.num, a.den * b.den);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new Error("division by zero");
  return reduce(a.num * b.den, a.den * b.num);
}

export function neg(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}

export function abs(a: Rational): Rational {
  return a.num < 0n ? neg(a) : a;
}

export function eq(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

export function cmp(a: Rational, b: Rational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function isNeg(a: Rational): boolean {
  return a.num < 0n;
}

export function sum(values: Rational[]): Rational {
  return values.reduce(add, ZERO);
}

/**
 * Convert to a decimal string with the given scale, rounded half-to-even.
 * Used only for display / JSON output — never for arithmetic.
 */
export function toDecimal(r: Rational, scale: number): string {
  if (scale < 0 || !Number.isInteger(scale)) {
    throw new Error(`invalid scale: ${scale}`);
  }
  const neg = r.num < 0n;
  const num = neg ? -r.num : r.num;
  const den = r.den;
  const scaler = 10n ** BigInt(scale);
  const scaled = (num * scaler) / den;
  const remainder = (num * scaler) % den;
  // half-to-even rounding
  const twice = remainder * 2n;
  let rounded = scaled;
  if (twice > den || (twice === den && scaled % 2n === 1n)) {
    rounded = scaled + 1n;
  }
  const s = rounded.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? s : s.slice(0, -scale);
  const frac = scale === 0 ? "" : "." + s.slice(-scale);
  return (neg && rounded !== 0n ? "-" : "") + whole + frac;
}

/**
 * Convert a user-friendly decimal string like "12.34" or "-0.5" to a rational.
 * Accepts optional leading sign and optional fractional part.
 */
export function fromDecimal(s: string): Rational {
  const trimmed = s.trim();
  // Accept "+1.00", "-0.5", "1.", ".5", "100" — i.e. optional sign, at least
  // one digit on either side of an optional dot.
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new Error(`invalid decimal: ${s}`);
  }
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  if (frac === "") {
    return reduce(sign * BigInt(whole), 1n);
  }
  const den = 10n ** BigInt(frac.length);
  const num = sign * (BigInt(whole) * den + BigInt(frac));
  return reduce(num, den);
}
