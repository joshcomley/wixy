import { describe, expect, it } from "vitest";
import { senderHue } from "../../src/server/senderHue.js";

describe("senderHue", () => {
  it("is stable per name and ignores case and edge spaces", () => {
    expect(senderHue("Mamdani")).toBe(senderHue("mamdani "));
    expect(senderHue("Mamdani")).toBe(senderHue("Mamdani"));
  });
  it("separates the two names from the report", () => {
    expect(senderHue("Mamdani")).not.toBe(senderHue("Kamalalaland"));
  });
  it("stays in range", () => {
    for (const n of ["", "a", "Zed", "Ünï"]) {
      const h = senderHue(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
