import { describe, expect, it } from "vitest";
import { main } from "../src/index";

describe("admin-ui scaffold", () => {
  it("exports main without throwing", () => {
    expect(() => main()).not.toThrow();
  });
});
