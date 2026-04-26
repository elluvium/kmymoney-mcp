import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires KMYMONEY_FILE", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/KMYMONEY_FILE/);
  });

  it("defaults autosave=true when unset", () => {
    expect(loadConfig({ KMYMONEY_FILE: "/tmp/x.kmy" }).autosave).toBe(true);
  });

  it("accepts recognized on/off values", () => {
    for (const v of ["true", "1", "YES", "On"]) {
      expect(loadConfig({ KMYMONEY_FILE: "/tmp/x.kmy", KMY_AUTOSAVE: v }).autosave).toBe(true);
    }
    for (const v of ["false", "0", "no", "OFF"]) {
      expect(loadConfig({ KMYMONEY_FILE: "/tmp/x.kmy", KMY_AUTOSAVE: v }).autosave).toBe(false);
    }
  });

  it("rejects garbage values instead of silently enabling", () => {
    expect(() =>
      loadConfig({ KMYMONEY_FILE: "/tmp/x.kmy", KMY_AUTOSAVE: "maybe" }),
    ).toThrow(/KMY_AUTOSAVE/);
  });
});
