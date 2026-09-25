// The Idle Detection wrapper (spec/server-chat/03-permanent-unlock.md §8). It only REPORTS what
// the browser says — never decides — so these tests pin its contract: permission is read
// without prompting, the detector starts only when permission is already granted, `screenState
// = "locked"` (and nothing else) fires the callback, and a lost permission, a failed start or
// a stop each end it cleanly, including a stop that lands in the middle of a slow start.

import { describe, expect, it, vi } from "vitest";
import { IDLE_DETECTOR_THRESHOLD_MS } from "../../src/server/constants";
import { createScreenWatcher } from "../../src/server/screenWatcher";

type PermissionValue = "granted" | "denied" | "prompt";

class FakePermissionStatus extends EventTarget {
  state: PermissionValue;
  constructor(state: PermissionValue) {
    super();
    this.state = state;
  }
  set(state: PermissionValue): void {
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface StartCall {
  readonly threshold: number;
  readonly signal: AbortSignal | undefined;
}

class FakeIdleDetector extends EventTarget {
  static instances: FakeIdleDetector[] = [];
  static requestPermission = vi.fn<() => Promise<"granted" | "denied">>();
  static startBehaviour: () => Promise<void> = () => Promise.resolve();

  screenState: "locked" | "unlocked" | null = null;
  readonly startCalls: StartCall[] = [];

  constructor() {
    super();
    FakeIdleDetector.instances.push(this);
  }

  start(options: { threshold: number; signal?: AbortSignal }): Promise<void> {
    this.startCalls.push({ threshold: options.threshold, signal: options.signal });
    return FakeIdleDetector.startBehaviour();
  }

  report(state: "locked" | "unlocked" | null): void {
    this.screenState = state;
    this.dispatchEvent(new Event("change"));
  }
}

interface FakeEnvironment {
  readonly win: Window;
  readonly query: ReturnType<typeof vi.fn>;
  readonly permission: FakePermissionStatus | null;
}

function environment(options: {
  readonly detector?: boolean;
  readonly permissions?: "absent" | "throws" | PermissionValue | Deferred<FakePermissionStatus>;
}): FakeEnvironment {
  FakeIdleDetector.instances = [];
  FakeIdleDetector.requestPermission = vi.fn<() => Promise<"granted" | "denied">>(() => Promise.resolve("granted"));
  FakeIdleDetector.startBehaviour = () => Promise.resolve();

  const mode = options.permissions ?? "granted";
  const permission = typeof mode === "string" && mode !== "absent" && mode !== "throws" ? new FakePermissionStatus(mode) : null;
  const query = vi.fn((_descriptor: { name: string }): Promise<FakePermissionStatus> => {
    if (mode === "throws") return Promise.reject(new Error("unsupported permission name"));
    if (permission !== null) return Promise.resolve(permission);
    if (typeof mode === "object") return mode.promise;
    return Promise.reject(new Error("unreachable"));
  });
  const navigator = mode === "absent" ? {} : { permissions: { query } };
  const win = Object.assign(new EventTarget(), {
    navigator,
    ...(options.detector === false ? {} : { IdleDetector: FakeIdleDetector }),
  }) as unknown as Window;
  return { win, query, permission };
}

function lastDetector(): FakeIdleDetector {
  const detector = FakeIdleDetector.instances.at(-1);
  if (detector === undefined) throw new Error("no detector was constructed");
  return detector;
}

describe("a browser without an IdleDetector", () => {
  it("reports unsupported everywhere and never touches the permission API", async () => {
    const { win, query } = environment({ detector: false });
    const watcher = createScreenWatcher(win);
    expect(watcher.supported).toBe(false);
    expect(watcher.running).toBe(false);
    expect(await watcher.status()).toBe("unsupported");
    expect(await watcher.requestPermission()).toBe("unsupported");
    expect(await watcher.start(vi.fn(), vi.fn())).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(FakeIdleDetector.instances).toHaveLength(0);
    watcher.stop();
  });

  it("treats a non-function IdleDetector property as absent", async () => {
    const win = Object.assign(new EventTarget(), { navigator: {}, IdleDetector: {} }) as unknown as Window;
    const watcher = createScreenWatcher(win);
    expect(watcher.supported).toBe(false);
    expect(await watcher.status()).toBe("unsupported");
  });
});

describe("status", () => {
  it.each<PermissionValue>(["granted", "denied", "prompt"])("reports %s without prompting", async (state) => {
    const { win, query } = environment({ permissions: state });
    const watcher = createScreenWatcher(win);
    expect(watcher.supported).toBe(true);
    expect(await watcher.status()).toBe(state);
    expect(query).toHaveBeenCalledWith({ name: "idle-detection" });
    expect(FakeIdleDetector.requestPermission).not.toHaveBeenCalled();
  });

  it("says 'prompt' when the browser has no permissions.query at all", async () => {
    const watcher = createScreenWatcher(environment({ permissions: "absent" }).win);
    expect(await watcher.status()).toBe("prompt");
  });

  it("says 'prompt' when permissions.query does not know the idle-detection name", async () => {
    const watcher = createScreenWatcher(environment({ permissions: "throws" }).win);
    expect(await watcher.status()).toBe("prompt");
  });
});

describe("requestPermission", () => {
  it("returns granted when the browser grants it", async () => {
    const { win } = environment({ permissions: "prompt" });
    const watcher = createScreenWatcher(win);
    expect(await watcher.requestPermission()).toBe("granted");
    expect(FakeIdleDetector.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("returns denied when the browser denies it", async () => {
    const { win } = environment({ permissions: "prompt" });
    FakeIdleDetector.requestPermission = vi.fn(() => Promise.resolve("denied" as const));
    expect(await createScreenWatcher(win).requestPermission()).toBe("denied");
  });

  it("calls the browser API synchronously, so the tap that asked still counts as a user gesture", () => {
    const { win } = environment({ permissions: "prompt" });
    const watcher = createScreenWatcher(win);
    void watcher.requestPermission();
    expect(FakeIdleDetector.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown request as denied", async () => {
    const { win } = environment({ permissions: "prompt" });
    FakeIdleDetector.requestPermission = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    expect(await createScreenWatcher(win).requestPermission()).toBe("denied");
  });
});

describe("start", () => {
  it.each<PermissionValue>(["prompt", "denied"])(
    "does NOT start when permission is %s — it never prompts on its own",
    async (state) => {
      const { win } = environment({ permissions: state });
      const watcher = createScreenWatcher(win);
      expect(await watcher.start(vi.fn(), vi.fn())).toBe(false);
      expect(watcher.running).toBe(false);
      expect(FakeIdleDetector.instances).toHaveLength(0);
      expect(FakeIdleDetector.requestPermission).not.toHaveBeenCalled();
    },
  );

  it("does not start when the permission API is missing or throws", async () => {
    for (const permissions of ["absent", "throws"] as const) {
      const { win } = environment({ permissions });
      const watcher = createScreenWatcher(win);
      expect(await watcher.start(vi.fn(), vi.fn())).toBe(false);
      expect(FakeIdleDetector.instances).toHaveLength(0);
    }
  });

  it("starts with the 60-second threshold and an abort signal once permission is granted", async () => {
    const { win } = environment({ permissions: "granted" });
    const watcher = createScreenWatcher(win);
    expect(await watcher.start(vi.fn(), vi.fn())).toBe(true);
    expect(watcher.running).toBe(true);
    const call = lastDetector().startCalls[0];
    expect(call?.threshold).toBe(IDLE_DETECTOR_THRESHOLD_MS);
    expect(IDLE_DETECTOR_THRESHOLD_MS).toBe(60_000);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.signal?.aborted).toBe(false);
    watcher.stop();
  });

  it("fires onScreenLocked for 'locked' and for nothing else", async () => {
    const { win } = environment({ permissions: "granted" });
    const onScreenLocked = vi.fn();
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);
    await watcher.start(onScreenLocked, onLost);
    const detector = lastDetector();

    detector.report("unlocked");
    detector.report(null);
    expect(onScreenLocked).not.toHaveBeenCalled();

    detector.report("locked");
    expect(onScreenLocked).toHaveBeenCalledTimes(1);
    detector.report("unlocked");
    detector.report("locked");
    expect(onScreenLocked).toHaveBeenCalledTimes(2);
    expect(onLost).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("stays running when the permission event fires but the state is still granted", async () => {
    const { win, permission } = environment({ permissions: "granted" });
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);
    await watcher.start(vi.fn(), onLost);
    permission?.dispatchEvent(new Event("change"));
    expect(onLost).not.toHaveBeenCalled();
    expect(watcher.running).toBe(true);
    watcher.stop();
  });

  it("stops and reports lost when the permission is revoked, and ignores later events", async () => {
    const { win, permission } = environment({ permissions: "granted" });
    const onScreenLocked = vi.fn();
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);
    await watcher.start(onScreenLocked, onLost);
    const detector = lastDetector();
    const signal = detector.startCalls[0]?.signal;

    permission?.set("denied");

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(watcher.running).toBe(false);
    expect(signal?.aborted).toBe(true);
    detector.report("locked");
    expect(onScreenLocked).not.toHaveBeenCalled();
    // The revoked permission's listener is gone: a second change reports nothing more.
    permission?.set("prompt");
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("reports lost — and is not running — when start() rejects", async () => {
    const { win } = environment({ permissions: "granted" });
    FakeIdleDetector.startBehaviour = () => Promise.reject(new Error("NotAllowedError"));
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);
    expect(await watcher.start(vi.fn(), onLost)).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(watcher.running).toBe(false);
    expect(lastDetector().startCalls[0]?.signal?.aborted).toBe(true);
  });

  it("can be started again after a failure", async () => {
    const { win } = environment({ permissions: "granted" });
    const watcher = createScreenWatcher(win);
    FakeIdleDetector.startBehaviour = () => Promise.reject(new Error("boom"));
    expect(await watcher.start(vi.fn(), vi.fn())).toBe(false);
    FakeIdleDetector.startBehaviour = () => Promise.resolve();
    expect(await watcher.start(vi.fn(), vi.fn())).toBe(true);
    expect(watcher.running).toBe(true);
    watcher.stop();
  });

  it("restarting replaces the old detector: its signal aborts and its events go nowhere", async () => {
    const { win } = environment({ permissions: "granted" });
    const first = vi.fn();
    const second = vi.fn();
    const watcher = createScreenWatcher(win);
    await watcher.start(first, vi.fn());
    const oldDetector = lastDetector();
    await watcher.start(second, vi.fn());
    const newDetector = lastDetector();

    expect(newDetector).not.toBe(oldDetector);
    expect(oldDetector.startCalls[0]?.signal?.aborted).toBe(true);
    oldDetector.report("locked");
    expect(first).not.toHaveBeenCalled();
    newDetector.report("locked");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    watcher.stop();
  });
});

describe("stop", () => {
  it("ends a running watcher: not running, signal aborted, later events ignored", async () => {
    const { win, permission } = environment({ permissions: "granted" });
    const onScreenLocked = vi.fn();
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);
    await watcher.start(onScreenLocked, onLost);
    const detector = lastDetector();

    watcher.stop();

    expect(watcher.running).toBe(false);
    expect(detector.startCalls[0]?.signal?.aborted).toBe(true);
    detector.report("locked");
    expect(onScreenLocked).not.toHaveBeenCalled();
    // A deliberate stop is not a loss: revoking the permission afterwards reports nothing.
    permission?.set("denied");
    expect(onLost).not.toHaveBeenCalled();
  });

  it("is harmless when nothing is running, and when called twice", async () => {
    const { win } = environment({ permissions: "granted" });
    const watcher = createScreenWatcher(win);
    expect(() => {
      watcher.stop();
      watcher.stop();
    }).not.toThrow();
    await watcher.start(vi.fn(), vi.fn());
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
    expect(watcher.running).toBe(false);
  });

  it("a stop that lands while the detector is still starting keeps it stopped", async () => {
    const { win } = environment({ permissions: "granted" });
    const slow = deferred<void>();
    FakeIdleDetector.startBehaviour = () => slow.promise;
    const onScreenLocked = vi.fn();
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);

    const started = watcher.start(onScreenLocked, onLost);
    await settle();
    expect(FakeIdleDetector.instances).toHaveLength(1);
    watcher.stop();
    slow.resolve();

    expect(await started).toBe(false);
    expect(watcher.running).toBe(false);
    lastDetector().report("locked");
    expect(onScreenLocked).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("a start() that fails AFTER a stop reports nothing", async () => {
    const { win } = environment({ permissions: "granted" });
    const slow = deferred<void>();
    FakeIdleDetector.startBehaviour = () => slow.promise;
    const onLost = vi.fn();
    const watcher = createScreenWatcher(win);

    const started = watcher.start(vi.fn(), onLost);
    await settle();
    watcher.stop();
    slow.reject(new Error("aborted"));

    expect(await started).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    expect(watcher.running).toBe(false);
  });

  it("a stop that lands while the permission is still being read never creates a detector", async () => {
    const pending = deferred<FakePermissionStatus>();
    const { win } = environment({ permissions: pending });
    const watcher = createScreenWatcher(win);

    const started = watcher.start(vi.fn(), vi.fn());
    await settle();
    watcher.stop();
    pending.resolve(new FakePermissionStatus("granted"));

    expect(await started).toBe(false);
    expect(FakeIdleDetector.instances).toHaveLength(0);
    expect(watcher.running).toBe(false);
  });

  it("an older start superseded by a newer one does not resurrect itself", async () => {
    const pending = deferred<FakePermissionStatus>();
    const env = environment({ permissions: pending });
    const watcher = createScreenWatcher(env.win);
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const first = watcher.start(firstCallback, vi.fn());
    await settle();
    const second = watcher.start(secondCallback, vi.fn());
    await settle();
    pending.resolve(new FakePermissionStatus("granted"));

    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(FakeIdleDetector.instances).toHaveLength(1);
    lastDetector().report("locked");
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});
