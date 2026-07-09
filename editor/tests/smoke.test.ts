import { describe, expect, it } from "vitest";
import { main } from "../src/index";

// `main()` now runs automatically at module load (index.ts calls it at the top
// level, so the bundled IIFE self-starts once injected into the preview iframe) —
// importing the module already exercises it once; calling it again here would just
// double-initialize the overlay (a second set of document listeners), not add
// coverage. The real behavior is covered by overlay.test.ts.
describe("editor entrypoint", () => {
  it("exports main and importing it does not throw", () => {
    expect(typeof main).toBe("function");
  });
});
