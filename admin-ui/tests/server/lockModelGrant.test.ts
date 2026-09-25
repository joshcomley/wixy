// The device-grant and background-switch additions to the lock state machine
// (spec/server-chat/03-permanent-unlock.md §1-§8): the two new states ("granting" and
// "shielded"), the `grantActive` input that silences idle and route-away from an open chat, and
// the pure policy functions the panel consults for the two "lock when I…" checkboxes. The
// pre-existing transitions are covered in lockModel.test.ts and must not have moved.

import { describe, expect, it } from "vitest";
import {
  classifyHide,
  DEFAULT_LOCK_SETTINGS,
  effectiveLockSettings,
  hiddenPolicy,
  NO_GRANT,
  pausesGrant,
  reduce,
  shieldOutcome,
  type HideCause,
  type LockContext,
  type LockEvent,
  type LockSettings,
  type LockState,
} from "../../src/server/lockModel";
import type { LockCause } from "../../src/server/types";

const NOW = 1_000_000;
const GRANT: LockContext = { grantActive: true };

function run(state: LockState, event: LockEvent, context?: LockContext) {
  return context === undefined ? reduce(state, event, NOW) : reduce(state, event, NOW, context);
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
  "screenLock",
];

/** The two automatic locks an active grant silences from an open chat. */
const QUIETED: readonly LockCause[] = ["idle", "routeAway"];
const NOT_QUIETED: readonly LockCause[] = ALL_CAUSES.filter((cause) => !QUIETED.includes(cause));

const GRANT_EVENTS: readonly LockEvent[] = [
  { type: "grantUnlock" },
  { type: "grantOk" },
  { type: "grantFailed" },
  { type: "shield" },
  { type: "shieldRestore" },
];

describe("NO_GRANT", () => {
  it("is the default context: no device grant", () => {
    expect(NO_GRANT).toEqual({ grantActive: false });
  });

  it("reduce() without a context behaves exactly as with NO_GRANT", () => {
    const chat: LockState = { kind: "chat" };
    for (const cause of ALL_CAUSES) {
      expect(run(chat, { type: "lock", cause })).toEqual(run(chat, { type: "lock", cause }, NO_GRANT));
    }
  });
});

describe("decoy + grantUnlock", () => {
  const decoy: LockState = { kind: "decoy" };

  it("with an active grant, a mount goes to 'granting' and shows nothing yet", () => {
    const result = run(decoy, { type: "grantUnlock" }, GRANT);
    expect(result.state).toEqual({ kind: "granting" });
    expect(result.effects).toEqual([]);
  });

  it("without an active grant, grantUnlock is ignored — a stray event can never open the chat", () => {
    for (const context of [undefined, NO_GRANT, { grantActive: false }]) {
      const result = run(decoy, { type: "grantUnlock" }, context);
      expect(result.state).toEqual(decoy);
      expect(result.effects).toEqual([]);
    }
  });

  it("the other new events do nothing on the decoy, grant or not", () => {
    for (const event of GRANT_EVENTS.filter((e) => e.type !== "grantUnlock")) {
      for (const context of [NO_GRANT, GRANT]) {
        const result = run(decoy, event, context);
        expect(result.state).toEqual(decoy);
        expect(result.effects).toEqual([]);
      }
    }
  });
});

describe("granting", () => {
  const granting: LockState = { kind: "granting" };

  it("grantOk opens the chat and starts the idle clock", () => {
    const result = run(granting, { type: "grantOk" }, GRANT);
    expect(result.state).toEqual({ kind: "chat" });
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("grantFailed falls back to the decoy and the PIN flow", () => {
    const result = run(granting, { type: "grantFailed" }, GRANT);
    expect(result.state).toEqual({ kind: "decoy" });
    expect(result.effects).toEqual([]);
  });

  it("every lock cause wins over a grant that is still answering", () => {
    for (const cause of ALL_CAUSES) {
      for (const context of [NO_GRANT, GRANT]) {
        const result = run(granting, { type: "lock", cause }, context);
        expect(result.state).toEqual({ kind: "decoy" });
        expect(result.effects).toEqual([]);
      }
    }
  });

  it("taps, gestures, activity and every other event do nothing while nothing is showing", () => {
    const strays: LockEvent[] = [
      { type: "tap" },
      { type: "multiTap" },
      { type: "tapAffordance" },
      { type: "submit" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: 1 },
      { type: "cancel" },
      { type: "activity" },
      { type: "fadeComplete" },
      { type: "grantUnlock" },
      { type: "shield" },
      { type: "shieldRestore" },
    ];
    for (const event of strays) {
      const result = run(granting, event, GRANT);
      expect(result.state).toEqual(granting);
      expect(result.effects).toEqual([]);
    }
  });
});

describe("chat with an active device grant", () => {
  const chat: LockState = { kind: "chat" };

  it("idle and route-away are ignored: the open chat stays open", () => {
    for (const cause of QUIETED) {
      const result = run(chat, { type: "lock", cause }, GRANT);
      expect(result.state).toEqual(chat);
      expect(result.effects).toEqual([]);
    }
  });

  it("the same two causes behave exactly as before when there is no grant", () => {
    expect(run(chat, { type: "lock", cause: "idle" }, NO_GRANT)).toEqual({
      state: { kind: "fading" },
      effects: ["startFadeTimer", "clearIdleTimer"],
    });
    expect(run(chat, { type: "lock", cause: "routeAway" }, NO_GRANT)).toEqual({
      state: { kind: "decoy" },
      effects: ["detachChat", "clearIdleTimer"],
    });
  });

  it("every other lock cause still locks instantly with a grant — including the two the driver decides (hidden, screenLock) and the ones it answers first (unauthorized, expired)", () => {
    for (const cause of NOT_QUIETED) {
      const result = run(chat, { type: "lock", cause }, GRANT);
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["detachChat", "clearIdleTimer"]);
    }
  });

  it("a multi-tap still locks instantly: it is a deliberate lock", () => {
    const result = run(chat, { type: "multiTap" }, GRANT);
    expect(result.state).toEqual({ kind: "decoy" });
    expect(result.effects).toEqual(["detachChat", "clearIdleTimer"]);
  });

  it("activity still restarts the idle clock (a grant only silences the lock it would cause)", () => {
    expect(run(chat, { type: "activity" }, GRANT)).toEqual({ state: chat, effects: ["resetIdleTimer"] });
  });
});

describe("chat + shield", () => {
  const chat: LockState = { kind: "chat" };

  it("puts the decoy up and detaches the chat, holding the session for the driver", () => {
    for (const context of [NO_GRANT, GRANT]) {
      const result = run(chat, { type: "shield" }, context);
      expect(result.state).toEqual({ kind: "shielded" });
      expect(result.effects).toEqual(["detachChat", "clearIdleTimer"]);
    }
  });

  it("only an open chat answers a shield: revealed, pin, verifying and fading ignore it", () => {
    const others: LockState[] = [
      { kind: "revealed" },
      { kind: "pin", error: null },
      { kind: "verifying" },
      { kind: "fading" },
    ];
    for (const state of others) {
      const result = run(state, { type: "shield" }, GRANT);
      expect(result.state).toEqual(state);
      expect(result.effects).toEqual([]);
    }
  });

  it("shieldRestore, grantOk and grantFailed do nothing to an open chat", () => {
    for (const event of [{ type: "shieldRestore" }, { type: "grantOk" }, { type: "grantFailed" }, { type: "grantUnlock" }] as const) {
      expect(run(chat, event, GRANT)).toEqual({ state: chat, effects: [] });
    }
  });
});

describe("fading with an active device grant", () => {
  const fading: LockState = { kind: "fading" };

  it("idle and route-away are ignored", () => {
    for (const cause of QUIETED) {
      const result = run(fading, { type: "lock", cause }, GRANT);
      expect(result.state).toEqual(fading);
      expect(result.effects).toEqual([]);
    }
  });

  it("every other cause locks instantly, cancelling the fade", () => {
    for (const cause of NOT_QUIETED) {
      const result = run(fading, { type: "lock", cause }, GRANT);
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["detachChat", "clearFadeTimer", "clearIdleTimer"]);
    }
  });

  it("without a grant every cause locks instantly, as before", () => {
    for (const cause of ALL_CAUSES) {
      const result = run(fading, { type: "lock", cause }, NO_GRANT);
      expect(result.state).toEqual({ kind: "decoy" });
      expect(result.effects).toEqual(["detachChat", "clearFadeTimer", "clearIdleTimer"]);
    }
  });

  it("a multi-tap mid-fade still locks instantly with or without a grant", () => {
    for (const context of [NO_GRANT, GRANT]) {
      expect(run(fading, { type: "multiTap" }, context)).toEqual({
        state: { kind: "decoy" },
        effects: ["detachChat", "clearFadeTimer", "clearIdleTimer"],
      });
    }
  });
});

describe("shielded", () => {
  const shielded: LockState = { kind: "shielded" };

  it("shieldRestore brings the chat back and starts a fresh idle clock", () => {
    const result = run(shielded, { type: "shieldRestore" }, GRANT);
    expect(result.state).toEqual({ kind: "chat" });
    expect(result.effects).toEqual(["resetIdleTimer"]);
  });

  it("every lock cause ends it on the decoy — even idle and route-away with a grant, because there is no open chat left to protect", () => {
    for (const cause of ALL_CAUSES) {
      for (const context of [NO_GRANT, GRANT]) {
        const result = run(shielded, { type: "lock", cause }, context);
        expect(result.state).toEqual({ kind: "decoy" });
        expect(result.effects).toEqual(["clearIdleTimer"]);
      }
    }
  });

  it("taps, gestures, activity and every other event do nothing during the shield", () => {
    const strays: LockEvent[] = [
      { type: "tap" },
      { type: "multiTap" },
      { type: "tapAffordance" },
      { type: "submit" },
      { type: "verifyOk" },
      { type: "verifyWrong", attemptsLeft: null },
      { type: "cancel" },
      { type: "activity" },
      { type: "fadeComplete" },
      { type: "grantUnlock" },
      { type: "grantOk" },
      { type: "grantFailed" },
      { type: "shield" },
    ];
    for (const event of strays) {
      const result = run(shielded, event, GRANT);
      expect(result.state).toEqual(shielded);
      expect(result.effects).toEqual([]);
    }
  });

  it("shieldRestore is answered ONLY by 'shielded' — no other state can be talked into opening the chat", () => {
    const others: LockState[] = [
      { kind: "decoy" },
      { kind: "revealed" },
      { kind: "pin", error: null },
      { kind: "verifying" },
      { kind: "granting" },
      { kind: "fading" },
    ];
    for (const state of others) {
      const result = run(state, { type: "shieldRestore" }, GRANT);
      expect(result.state).toEqual(state);
    }
  });
});

describe("the pre-unlock states ignore the new events", () => {
  const states: LockState[] = [
    { kind: "revealed" },
    { kind: "pin", error: null },
    { kind: "pin", error: { kind: "wrong", attemptsLeft: 3 } },
    { kind: "verifying" },
  ];

  it("revealed, pin and verifying never react to grantUnlock/grantOk/grantFailed/shield/shieldRestore", () => {
    for (const state of states) {
      for (const event of GRANT_EVENTS) {
        for (const context of [NO_GRANT, GRANT]) {
          const result = run(state, event, context);
          expect(result.state).toEqual(state);
          expect(result.effects).toEqual([]);
        }
      }
    }
  });

  it("idle and route-away still lock the decoy's own states even with a grant — the grant only smooths over an OPEN chat", () => {
    for (const state of states) {
      for (const cause of QUIETED) {
        expect(run(state, { type: "lock", cause }, GRANT).state).toEqual({ kind: "decoy" });
      }
    }
  });
});

describe("round trips", () => {
  it("mount with a grant: decoy -> granting -> chat -> panic -> decoy", () => {
    let state: LockState = { kind: "decoy" };
    state = run(state, { type: "grantUnlock" }, GRANT).state;
    expect(state).toEqual({ kind: "granting" });
    state = run(state, { type: "grantOk" }, GRANT).state;
    expect(state).toEqual({ kind: "chat" });
    state = run(state, { type: "lock", cause: "panic" }, GRANT).state;
    expect(state).toEqual({ kind: "decoy" });
  });

  it("a background switch that turns out harmless: chat -> shielded -> chat", () => {
    let state: LockState = { kind: "chat" };
    state = run(state, { type: "shield" }, GRANT).state;
    state = run(state, { type: "shieldRestore" }, GRANT).state;
    expect(state).toEqual({ kind: "chat" });
  });

  it("a background switch that stays locked: chat -> shielded -> decoy", () => {
    let state: LockState = { kind: "chat" };
    state = run(state, { type: "shield" }, GRANT).state;
    state = run(state, { type: "lock", cause: "hidden" }, GRANT).state;
    expect(state).toEqual({ kind: "decoy" });
  });

  it("a failed grant leaves a normal PIN flow: decoy -> granting -> decoy -> revealed", () => {
    let state: LockState = { kind: "decoy" };
    state = run(state, { type: "grantUnlock" }, GRANT).state;
    state = run(state, { type: "grantFailed" }, GRANT).state;
    state = run(state, { type: "tap" }, GRANT).state;
    expect(state).toEqual({ kind: "revealed" });
  });
});

describe("pausesGrant", () => {
  it("the deliberate locks and the checkbox-caused locks pause a grant", () => {
    for (const cause of ["panic", "multiTap", "escape", "hidden", "screenLock"] as const) {
      expect(pausesGrant(cause)).toBe(true);
    }
  });

  it("the locks a grant exists to smooth over never pause it", () => {
    for (const cause of ["idle", "routeAway", "unauthorized", "expired"] as const) {
      expect(pausesGrant(cause)).toBe(false);
    }
  });

  it("covers every cause exactly once (adding a cause forces a decision here)", () => {
    expect(ALL_CAUSES.filter(pausesGrant).sort()).toEqual(["escape", "hidden", "multiTap", "panic", "screenLock"]);
  });
});

const TAB_ON_SCREEN_ON: LockSettings = { lockOnTab: true, lockOnScreen: true };
const TAB_OFF_SCREEN_OFF: LockSettings = { lockOnTab: false, lockOnScreen: false };
const TAB_ON_SCREEN_OFF: LockSettings = { lockOnTab: true, lockOnScreen: false };
const TAB_OFF_SCREEN_ON: LockSettings = { lockOnTab: false, lockOnScreen: true };

describe("DEFAULT_LOCK_SETTINGS", () => {
  it("is both boxes ticked: today's fail-closed behaviour", () => {
    expect(DEFAULT_LOCK_SETTINGS).toEqual(TAB_ON_SCREEN_ON);
  });
});

describe("hiddenPolicy (§8 decision rule)", () => {
  it("both ticked: lock at once", () => {
    expect(hiddenPolicy(TAB_ON_SCREEN_ON)).toBe("lockNow");
  });

  it("both unticked: never lock", () => {
    expect(hiddenPolicy(TAB_OFF_SCREEN_OFF)).toBe("ignore");
  });

  it("the two differ, either way round: shield (lock at once and decide on return)", () => {
    expect(hiddenPolicy(TAB_ON_SCREEN_OFF)).toBe("shield");
    expect(hiddenPolicy(TAB_OFF_SCREEN_ON)).toBe("shield");
  });
});

describe("classifyHide", () => {
  it("a screen-lock event is positive evidence, proven device or not", () => {
    expect(classifyHide({ screenEvidence: true, deviceProven: true })).toBe("screenLock");
    expect(classifyHide({ screenEvidence: true, deviceProven: false })).toBe("screenLock");
  });

  it("no event on a device that has proven it reports them reads as a tab change", () => {
    expect(classifyHide({ screenEvidence: false, deviceProven: true })).toBe("tabChange");
  });

  it("no event on a device that has NOT proven it is ambiguous — silence is not proof of a tab switch", () => {
    expect(classifyHide({ screenEvidence: false, deviceProven: false })).toBe("ambiguous");
  });
});

describe("shieldOutcome (restore only on a KNOWN cause whose own box is unticked)", () => {
  const matrix: ReadonlyArray<readonly [string, LockSettings, HideCause, "restore" | "stayLocked"]> = [
    ["tab on / screen off", TAB_ON_SCREEN_OFF, "screenLock", "restore"],
    ["tab on / screen off", TAB_ON_SCREEN_OFF, "tabChange", "stayLocked"],
    ["tab on / screen off", TAB_ON_SCREEN_OFF, "ambiguous", "stayLocked"],
    ["tab off / screen on", TAB_OFF_SCREEN_ON, "screenLock", "stayLocked"],
    ["tab off / screen on", TAB_OFF_SCREEN_ON, "tabChange", "restore"],
    ["tab off / screen on", TAB_OFF_SCREEN_ON, "ambiguous", "stayLocked"],
    ["both on", TAB_ON_SCREEN_ON, "screenLock", "stayLocked"],
    ["both on", TAB_ON_SCREEN_ON, "tabChange", "stayLocked"],
    ["both on", TAB_ON_SCREEN_ON, "ambiguous", "stayLocked"],
    ["both off", TAB_OFF_SCREEN_OFF, "screenLock", "restore"],
    ["both off", TAB_OFF_SCREEN_OFF, "tabChange", "restore"],
    ["both off", TAB_OFF_SCREEN_OFF, "ambiguous", "stayLocked"],
  ];

  for (const [name, settings, cause, expected] of matrix) {
    it(`${name}, cause ${cause}: ${expected}`, () => {
      expect(shieldOutcome(cause, settings)).toBe(expected);
    });
  }

  it("an ambiguous cause stays locked under EVERY setting — the fail-open regression", () => {
    for (const settings of [TAB_ON_SCREEN_ON, TAB_OFF_SCREEN_OFF, TAB_ON_SCREEN_OFF, TAB_OFF_SCREEN_ON]) {
      expect(shieldOutcome("ambiguous", settings)).toBe("stayLocked");
    }
  });
});

describe("effectiveLockSettings", () => {
  const all = [TAB_ON_SCREEN_ON, TAB_OFF_SCREEN_OFF, TAB_ON_SCREEN_OFF, TAB_OFF_SCREEN_ON];

  it("when the browser can tell a screen lock from a tab switch, the stored settings are used as they are", () => {
    for (const stored of all) {
      expect(effectiveLockSettings(stored, true)).toEqual(stored);
    }
  });

  it("when it cannot, the two boxes follow each other: an agreed value stays as it is", () => {
    expect(effectiveLockSettings(TAB_ON_SCREEN_ON, false)).toEqual(TAB_ON_SCREEN_ON);
    expect(effectiveLockSettings(TAB_OFF_SCREEN_OFF, false)).toEqual(TAB_OFF_SCREEN_OFF);
  });

  it("when it cannot and the stored values disagree, it locks — losing the detector never turns a lock the owner asked for into no lock", () => {
    expect(effectiveLockSettings(TAB_ON_SCREEN_OFF, false)).toEqual(TAB_ON_SCREEN_ON);
    expect(effectiveLockSettings(TAB_OFF_SCREEN_ON, false)).toEqual(TAB_ON_SCREEN_ON);
  });

  it("the mirrored result is never 'differ' and so never asks for a shield", () => {
    for (const stored of all) {
      expect(hiddenPolicy(effectiveLockSettings(stored, false))).not.toBe("shield");
    }
  });
});
