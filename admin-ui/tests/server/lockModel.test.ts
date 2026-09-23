// 100% branch coverage of the lock state machine (spec/server-chat/00-brief.md
// §6) is the explicit bar for this file (module DM brief) — every switch
// `case`/`default` and every nested `if` across every one of the six states
// is exercised at least once below, plus exact `state`/`effects` assertions
// (not just "a branch ran") since R2/R3/R6/R7 fidelity is what actually
// matters here.

import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reduce, type LockEvent, type LockState } from "../../src/server/lockModel";
import type { LockCause } from "../../src/server/types";

const NOW = 1_000_000;

function run(state: LockState, event: LockEvent) {
  return reduce(state, event, NOW);
}

const ALL_CAUSES: readonly LockCause[] = [
  "idle",
  "panic",
  "multiTap",
  "escape",
  "hidden",
  "routeAway",
  "unauthorized",
  "expired",
];

describe("INITIAL_STATE", () => {
  it("is the decoy", () => {
    expect(INITIAL_STATE).toEqual({ kind: "decoy" });
  });
});

describe("decoy", () => {
  const decoy: LockState = { kind: "decoy" };

  it("R2 v1.3 (decision #974): a single tap reveals the affordance and (re)starts the idle timer", () => {
    const result = run(decoy, { type: "tap" });
    expect(result.state).toEqual({ kind: "revealed" });
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("R2 v1.3: multiTap has NO meaning on the decoy any more — it's a no-op, not a reveal", () => {
    const result = run(decoy, { type: "multiTap" });
    expect(result.state).toEqual(decoy);
    expect(result.effects).toEqual([]);
  });

  it("is a no-op for every lock cause — already locked", () => {
    for (const cause of ALL_CAUSES) {
      const result = run(decoy, { type: "lock", cause });
      expect(result.state).toEqual(decoy);
      expect(result.effects).toEqual([]);
    }
  });

  it("is a no-op for every other stray event", () => {
    const strayEvents: LockEvent[] = [
      { type: "tapAffordance" },
      { type: "submit" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: null },
      { type: "verifyLockedOut", retryAfterS: 1 },
      { type: "verifyUnavailable" },
      { type: "cancel" },
      { type: "activity" },
      { type: "fadeComplete" },
    ];
    for (const event of strayEvents) {
      const result = run(decoy, event);
      expect(result.state).toEqual(decoy);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("revealed", () => {
  const revealed: LockState = { kind: "revealed" };

  it("tapAffordance opens the pin pad with no error, resets the idle timer, and focuses it", () => {
    const result = run(revealed, { type: "tapAffordance" });
    expect(result.state).toEqual({ kind: "pin", error: null });
    expect(result.effects).toEqual(["resetIdleTimer", "focusPin"]);
  });

  it("activity resets the idle timer without changing state", () => {
    const result = run(revealed, { type: "activity" });
    expect(result.state).toEqual(revealed);
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("another single tap while already revealed just resets the idle timer", () => {
    const result = run(revealed, { type: "tap" });
    expect(result.state).toEqual(revealed);
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("a multiTap while revealed also has no meaning — just resets the idle timer, same as any activity", () => {
    const result = run(revealed, { type: "multiTap" });
    expect(result.state).toEqual(revealed);
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("every lock cause (including idle) lands directly on the decoy — no fade here", () => {
    for (const cause of ALL_CAUSES) {
      const result = run(revealed, { type: "lock", cause });
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["clearIdleTimer"]);
    }
  });

  it("is a no-op for every other stray event", () => {
    const strayEvents: LockEvent[] = [
      { type: "submit" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: null },
      { type: "verifyLockedOut", retryAfterS: 1 },
      { type: "verifyUnavailable" },
      { type: "cancel" },
      { type: "fadeComplete" },
    ];
    for (const event of strayEvents) {
      const result = run(revealed, event);
      expect(result.state).toEqual(revealed);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("pin", () => {
  const pinNoError: LockState = { kind: "pin", error: null };
  const pinWithError: LockState = {
    kind: "pin",
    error: { kind: "wrong", attemptsLeft: 2 },
  };

  it("submit moves to verifying and clears the idle timer", () => {
    const result = run(pinNoError, { type: "submit" });
    expect(result.state).toEqual({ kind: "verifying" });
    expect(result.effects).toEqual(["clearIdleTimer"]);
  });

  it("cancel returns to the decoy — nothing was ever unlocked", () => {
    const result = run(pinWithError, { type: "cancel" });
    expect(result.state).toEqual({ kind: "decoy" });
    expect(result.effects).toEqual(["clearIdleTimer"]);
  });

  it("activity resets the idle timer without changing state (typing the PIN keeps it alive)", () => {
    const result = run(pinWithError, { type: "activity" });
    expect(result.state).toEqual(pinWithError);
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("every lock cause (Escape included) lands on the decoy — R2's cancel/Esc/idle unification", () => {
    for (const cause of ALL_CAUSES) {
      const result = run(pinWithError, { type: "lock", cause });
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["clearIdleTimer"]);
    }
  });

  it("is a no-op for every other stray event", () => {
    const strayEvents: LockEvent[] = [
      { type: "tap" },
      { type: "tapAffordance" },
      { type: "multiTap" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: null },
      { type: "verifyLockedOut", retryAfterS: 1 },
      { type: "verifyUnavailable" },
      { type: "fadeComplete" },
    ];
    for (const event of strayEvents) {
      const result = run(pinNoError, event);
      expect(result.state).toEqual(pinNoError);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("verifying", () => {
  const verifying: LockState = { kind: "verifying" };

  it("verifyOk unlocks into chat and starts the idle timer", () => {
    const result = run(verifying, { type: "verifyOk" });
    expect(result.state).toEqual({ kind: "chat" });
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("verifyWrong returns to pin carrying attemptsLeft, resets idle, refocuses", () => {
    const result = run(verifying, { type: "verifyWrong", attemptsLeft: 3 });
    expect(result.state).toEqual({ kind: "pin", error: { kind: "wrong", attemptsLeft: 3 } });
    expect(result.effects).toEqual(["resetIdleTimer", "focusPin"]);
  });

  it("verifyWrong with a null attemptsLeft (cmd didn't report it) is carried through as null", () => {
    const result = run(verifying, { type: "verifyWrong", attemptsLeft: null });
    expect(result.state).toEqual({ kind: "pin", error: { kind: "wrong", attemptsLeft: null } });
  });

  it("verifyLockedOut returns to pin carrying retryAfterS, resets idle, refocuses", () => {
    const result = run(verifying, { type: "verifyLockedOut", retryAfterS: 42 });
    expect(result.state).toEqual({ kind: "pin", error: { kind: "lockedOut", retryAfterS: 42 } });
    expect(result.effects).toEqual(["resetIdleTimer", "focusPin"]);
  });

  it("verifyUnavailable returns to pin with the unavailable error, resets idle, refocuses", () => {
    const result = run(verifying, { type: "verifyUnavailable" });
    expect(result.state).toEqual({ kind: "pin", error: { kind: "unavailable" } });
    expect(result.effects).toEqual(["resetIdleTimer", "focusPin"]);
  });

  it("every lock cause cuts a pending verify straight to the decoy with no effects", () => {
    for (const cause of ALL_CAUSES) {
      const result = run(verifying, { type: "lock", cause });
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual([]);
    }
  });

  it("is a no-op for every other stray event", () => {
    const strayEvents: LockEvent[] = [
      { type: "tap" },
      { type: "tapAffordance" },
      { type: "submit" },
      { type: "multiTap" },
      { type: "cancel" },
      { type: "activity" },
      { type: "fadeComplete" },
    ];
    for (const event of strayEvents) {
      const result = run(verifying, event);
      expect(result.state).toEqual(verifying);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("chat", () => {
  const chat: LockState = { kind: "chat" };

  it("activity resets the idle timer without changing state", () => {
    const result = run(chat, { type: "activity" });
    expect(result.state).toEqual(chat);
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("R3: a multi-tap inside the chat view locks instantly and detaches the chat subtree", () => {
    const result = run(chat, { type: "multiTap" });
    expect(result.state).toEqual({ kind: "decoy" });
    expect(result.effects).toEqual(["detachChat", "clearIdleTimer"]);
  });

  it("lock(idle) is the ONE non-instant cause: it fades first instead of detaching immediately", () => {
    const result = run(chat, { type: "lock", cause: "idle" });
    expect(result.state).toEqual({ kind: "fading" });
    expect(result.effects).toEqual(["startFadeTimer", "clearIdleTimer"]);
  });

  it("every OTHER lock cause locks instantly and detaches the chat subtree", () => {
    const instantCauses = ALL_CAUSES.filter((c) => c !== "idle");
    expect(instantCauses).toHaveLength(7);
    for (const cause of instantCauses) {
      const result = run(chat, { type: "lock", cause });
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["detachChat", "clearIdleTimer"]);
    }
  });

  it("is a no-op for every other stray event", () => {
    const strayEvents: LockEvent[] = [
      { type: "tap" },
      { type: "tapAffordance" },
      { type: "submit" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: null },
      { type: "verifyLockedOut", retryAfterS: 1 },
      { type: "verifyUnavailable" },
      { type: "cancel" },
      { type: "fadeComplete" },
    ];
    for (const event of strayEvents) {
      const result = run(chat, event);
      expect(result.state).toEqual(chat);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("fading", () => {
  const fading: LockState = { kind: "fading" };

  it("R7: any activity during the fade cancels it and restores the chat, with a fresh idle timer", () => {
    const result = run(fading, { type: "activity" });
    expect(result.state).toEqual({ kind: "chat" });
    expect(result.effects).toEqual(["clearFadeTimer", "resetIdleTimer"]);
  });

  it("fadeComplete finishes the fade onto the decoy and detaches the chat subtree", () => {
    const result = run(fading, { type: "fadeComplete" });
    expect(result.state).toEqual({ kind: "decoy" });
    expect(result.effects).toEqual(["detachChat", "clearIdleTimer"]);
  });

  it("a multiTap mid-fade locks instantly regardless (defensive — see lockModel's own note)", () => {
    const result = run(fading, { type: "multiTap" });
    expect(result.state).toEqual({ kind: "decoy" });
    expect(result.effects).toEqual(["detachChat", "clearFadeTimer", "clearIdleTimer"]);
  });

  it("every lock cause mid-fade locks instantly, cancelling the fade and detaching", () => {
    for (const cause of ALL_CAUSES) {
      const result = run(fading, { type: "lock", cause });
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["detachChat", "clearFadeTimer", "clearIdleTimer"]);
    }
  });

  it("is a no-op for every other stray event", () => {
    const strayEvents: LockEvent[] = [
      { type: "tap" },
      { type: "tapAffordance" },
      { type: "submit" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: null },
      { type: "verifyLockedOut", retryAfterS: 1 },
      { type: "verifyUnavailable" },
      { type: "cancel" },
    ];
    for (const event of strayEvents) {
      const result = run(fading, event);
      expect(result.state).toEqual(fading);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("a full round trip (decoy -> ... -> chat -> ... -> decoy)", () => {
  it("tap, tapAffordance, submit, verifyOk, idle-lock (fade), fadeComplete returns to a clean decoy", () => {
    let state: LockState = INITIAL_STATE;
    state = run(state, { type: "tap" }).state;
    expect(state).toEqual({ kind: "revealed" });
    state = run(state, { type: "tapAffordance" }).state;
    expect(state).toEqual({ kind: "pin", error: null });
    state = run(state, { type: "submit" }).state;
    expect(state).toEqual({ kind: "verifying" });
    state = run(state, { type: "verifyOk" }).state;
    expect(state).toEqual({ kind: "chat" });
    state = run(state, { type: "lock", cause: "idle" }).state;
    expect(state).toEqual({ kind: "fading" });
    state = run(state, { type: "fadeComplete" }).state;
    expect(state).toEqual({ kind: "decoy" });
  });

  it("a wrong PIN keeps you on the pad with the error surfaced, not bounced back to decoy", () => {
    let state: LockState = { kind: "pin", error: null };
    state = run(state, { type: "submit" }).state;
    state = run(state, { type: "verifyWrong", attemptsLeft: 4 }).state;
    expect(state).toEqual({ kind: "pin", error: { kind: "wrong", attemptsLeft: 4 } });
  });
});
