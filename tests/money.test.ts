import { describe, it, expect } from "vitest";
import {
  fromString,
  toString,
  add,
  sub,
  mul,
  neg,
  eq,
  cmp,
  sum,
  toDecimal,
  fromDecimal,
  ZERO,
  isZero,
} from "../src/kmy/money.js";

describe("money rationals", () => {
  it("parses KMyMoney-style strings", () => {
    expect(toString(fromString("12345/100"))).toBe("2469/20");
    expect(toString(fromString("-60569/20"))).toBe("-60569/20");
    expect(toString(fromString("1/1"))).toBe("1/1");
    expect(toString(fromString("0/1"))).toBe("0/1");
    expect(toString(fromString(""))).toBe("0/1");
  });

  it("normalizes sign to numerator", () => {
    expect(toString(fromString("1/-2"))).toBe("-1/2");
  });

  it("arithmetic is exact", () => {
    const a = fromString("1/3");
    const b = fromString("1/6");
    expect(eq(add(a, b), fromString("1/2"))).toBe(true);
    expect(eq(sub(a, b), fromString("1/6"))).toBe(true);
    expect(eq(mul(a, b), fromString("1/18"))).toBe(true);
  });

  it("splits sum to zero in valid transactions", () => {
    const s = sum([fromString("60569/20"), fromString("-60569/20")]);
    expect(isZero(s)).toBe(true);
  });

  it("neg and cmp behave", () => {
    expect(eq(neg(fromString("3/4")), fromString("-3/4"))).toBe(true);
    expect(cmp(fromString("1/2"), fromString("3/4"))).toBe(-1);
    expect(cmp(fromString("1/1"), fromString("1/1"))).toBe(0);
    expect(cmp(fromString("1/1"), fromString("0/1"))).toBe(1);
  });

  it("toDecimal rounds half-to-even", () => {
    expect(toDecimal(fromString("12345/100"), 2)).toBe("123.45");
    expect(toDecimal(fromString("-60569/20"), 2)).toBe("-3028.45");
    expect(toDecimal(fromString("1/3"), 4)).toBe("0.3333");
    expect(toDecimal(ZERO, 2)).toBe("0.00");
    // banker's rounding: 2.5 → 2, 3.5 → 4
    expect(toDecimal(fromString("5/2"), 0)).toBe("2");
    expect(toDecimal(fromString("7/2"), 0)).toBe("4");
  });

  it("fromDecimal parses user input", () => {
    expect(toString(fromDecimal("12.34"))).toBe("617/50");
    expect(toString(fromDecimal("-0.5"))).toBe("-1/2");
    expect(toString(fromDecimal("100"))).toBe("100/1");
    expect(() => fromDecimal("abc")).toThrow();
  });
});
