import { describe, expect, it } from "vitest";
import { themeVarsFromTheme } from "../src/themeVars";

// Mirrors `builder/tests/test_theme.py`'s `TestGenerateThemeCss::
// test_emits_color_vars_shadow_and_fonts` exactly.
describe("themeVarsFromTheme", () => {
  it("maps colors, shadow, and fonts to CSS custom property values", () => {
    const vars = themeVarsFromTheme({
      colors: { cream: "#F1E8D9", coffee: "#3E312A" },
      shadow: "0 1px 2px black",
      fonts: {
        serif: { family: "Cormorant Garamond", weights: ["400"], italics: false },
        sans: { family: "Jost", weights: ["400"], italics: false },
      },
    });
    expect(vars["--cream"]).toBe("#F1E8D9");
    expect(vars["--coffee"]).toBe("#3E312A");
    expect(vars["--shadow"]).toBe("0 1px 2px black");
    expect(vars["--font-serif"]).toBe("'Cormorant Garamond',serif");
    expect(vars["--font-sans"]).toBe("'Jost',system-ui,sans-serif");
  });

  it("a role outside the generic-fallback map gets no fallback suffix", () => {
    const vars = themeVarsFromTheme({
      colors: {},
      shadow: "",
      fonts: { display: { family: "Custom Family", weights: [], italics: false } },
    });
    expect(vars["--font-display"]).toBe("'Custom Family'");
  });
});
