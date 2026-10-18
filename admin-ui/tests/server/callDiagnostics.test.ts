import { expect, it, vi } from "vitest";
import { createCallDiagnostics } from "../../src/server/call/diagnostics";

it("bounds and clears one-attempt diagnostics without exception messages or arbitrary state", () => {
  const diagnostics = createCallDiagnostics(window);
  diagnostics.record({ step: "setup-failed", state: "secret-user-and-token",
    error: new DOMException("secret-message-and-audio", "NotAllowedError"), code: 4401 });
  expect(diagnostics.text()).toContain("NotAllowedError");
  expect(diagnostics.text()).not.toContain("secret-");
  for (let i = 0; i < 1000; i++) diagnostics.record({ step: "context-state", state: "running" });
  expect((JSON.parse(diagnostics.text()) as { events: unknown[] }).events).toHaveLength(32);
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    diagnostics.printOnce();
    diagnostics.printOnce();
    expect(log).toHaveBeenCalledTimes(1);
    diagnostics.reset();
    expect((JSON.parse(diagnostics.text()) as { events: unknown[] }).events).toHaveLength(0);
  } finally { log.mockRestore(); }
});

it("does not throw when a console sink rejects the diagnostic", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("sink failure"); });
  try {
    const diagnostics = createCallDiagnostics(window);
    expect(() => diagnostics.printOnce()).not.toThrow();
    diagnostics.printOnce();
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});
