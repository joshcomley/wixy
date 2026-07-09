import { describe, expect, it } from "vitest";
import { buildFontsUrl } from "../src/googleFonts";

// These cases mirror `builder/tests/test_theme.py`'s `TestGenerateFontsUrl` exactly
// (same inputs, same expected substrings) — proving this TS port and the Python
// original agree, not just that each independently looks reasonable.
describe("buildFontsUrl", () => {
  it("joins a family's weights on the wght axis", () => {
    const url = buildFontsUrl({
      sans: { family: "Jost", weights: ["300", "400"], italics: false },
    });
    expect(url.startsWith("https://fonts.googleapis.com/css2?")).toBe(true);
    expect(url).toContain("family=Jost:wght@300;400");
  });

  it("italics uses the ital,wght axis with 0,W and 1,W pairs", () => {
    const url = buildFontsUrl({
      serif: { family: "Cormorant Garamond", weights: ["400", "600"], italics: true },
    });
    expect(url).toContain("family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600");
  });

  it("joins multiple families with & and ends in &display=swap", () => {
    const url = buildFontsUrl({
      serif: { family: "A Font", weights: ["400"], italics: false },
      sans: { family: "B Font", weights: ["400"], italics: false },
    });
    expect((url.match(/family=/g) ?? []).length).toBe(2);
    expect(url.endsWith("&display=swap")).toBe(true);
  });

  it("a role with no weights degrades to a bare family param", () => {
    const url = buildFontsUrl({
      script: { family: "Pinyon Script", weights: [], italics: false },
    });
    expect(url).toContain("family=Pinyon+Script&display=swap");
  });

  it("dedupes repeated weights while sorting numerically", () => {
    const url = buildFontsUrl({
      sans: { family: "Jost", weights: ["400", "300", "400"], italics: false },
    });
    expect(url).toContain("family=Jost:wght@300;400");
  });

  it("non-numeric weight strings sort before numeric ones (key 0)", () => {
    const url = buildFontsUrl({
      sans: { family: "Jost", weights: ["regular", "300"], italics: false },
    });
    expect(url).toContain("family=Jost:wght@regular;300");
  });
});
