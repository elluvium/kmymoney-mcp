import { describe, it, expect } from "vitest";
import { formatId, parseId, makeIdGenerator } from "../src/kmy/ids.js";

describe("id generator", () => {
  it("formats to canonical width", () => {
    expect(formatId("split", 1)).toBe("S0001");
    expect(formatId("transaction", 42n)).toBe("T000000000000000042");
  });

  it("parses canonical ids", () => {
    expect(parseId("split", "S0001")).toBe(1n);
    expect(parseId("payee", "P000042")).toBe(42n);
  });

  it("accepts overflow-width ids past canonical padding", () => {
    // S10000 is 5 digits after "S" (canonical width is 4). Previously returned
    // null, which caused makeIdGenerator to restart from 0 and collide.
    expect(parseId("split", "S10000")).toBe(10000n);
    expect(parseId("split", "S999999")).toBe(999999n);
  });

  it("rejects malformed ids", () => {
    expect(parseId("split", "S00a1")).toBeNull();
    expect(parseId("split", "X0001")).toBeNull();
    expect(parseId("split", "S1")).toBeNull(); // too short
    expect(parseId("split", "AStd::Asset")).toBeNull();
  });

  it("makeIdGenerator yields the next id after the max seen", () => {
    const gen = makeIdGenerator("split", ["S0001", "S0003", "S10000"]);
    expect(gen()).toBe("S10001");
    expect(gen()).toBe("S10002");
  });
});
