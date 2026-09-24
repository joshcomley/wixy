import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerChatView } from "../src/server/chatView";
import { ServerLockedError } from "../src/server/api/http";
import type { ServerIdentity } from "../src/server/identity";
import type { ServerSettingsSheetView } from "../src/server/settingsSheet";
import type { ServerStreamEvent, ServerStreamHandle } from "../src/server/stream";
import type { ServerThreadView } from "../src/server/thread";
import type { LockCause, LockHooks, ServerSession } from "../src/server/types";

const { createServerIdentity, mountServerSettingsSheet, mountServerThread, openServerStream } = vi.hoisted(() => ({
  createServerIdentity: vi.fn(),
  mountServerSettingsSheet: vi.fn(),
  mountServerThread: vi.fn(),
  openServerStream: vi.fn(),
}));

vi.mock("../src/server/identity", () => ({ createServerIdentity }));
vi.mock("../src/server/settingsSheet", () => ({ mountServerSettingsSheet }));
vi.mock("../src/server/thread", () => ({ mountServerThread }));
vi.mock("../src/server/stream", () => ({ openServerStream }));

const SESSION_ONE: ServerSession = { token: "one", expiresAt: 9_999_999_999 };
const SESSION_TWO: ServerSession = { token: "two", expiresAt: 9_999_999_999 };

interface OpenedStream {
  handle: ServerStreamHandle;
  onEvent: (event: ServerStreamEvent) => void;
}

function createHarness(attach: (session: ServerSession) => Promise<number | null>): {
  view: ReturnType<typeof createServerChatView>;
  thread: ServerThreadView;
  streams: OpenedStream[];
  lockNow: ReturnType<typeof vi.fn<(cause: LockCause) => void>>;
} {
  const identity: ServerIdentity = {
    getName: () => "Alex",
    setName: vi.fn(),
    getDeviceId: () => "device",
    isMine: () => false,
  };
  createServerIdentity.mockReturnValue(identity);

  const thread = {
    element: document.createElement("div"),
    attach: vi.fn(attach),
    detach: vi.fn(),
    handleStreamEvent: vi.fn(),
    wipe: vi.fn(async () => false),
    refreshNameChip: vi.fn(),
    teardown: vi.fn(),
  } as unknown as ServerThreadView;
  mountServerThread.mockReturnValue(thread);

  const settingsSheet: ServerSettingsSheetView = {
    element: document.createElement("div"),
    pushSlot: document.createElement("div"),
    open: vi.fn(),
    close: vi.fn(),
    teardown: vi.fn(),
  };
  mountServerSettingsSheet.mockReturnValue(settingsSheet);

  const streams: OpenedStream[] = [];
  openServerStream.mockImplementation((_session, _cursor, onEvent) => {
    const handle: ServerStreamHandle = { getCursor: vi.fn(() => 7), close: vi.fn() };
    streams.push({ handle, onEvent });
    return handle;
  });

  const lockNow = vi.fn<(cause: LockCause) => void>();
  const hooks: LockHooks = { suspend: vi.fn(() => () => {}), lockNow };
  const view = createServerChatView({ api: {}, hooks, win: window, session: () => null });
  lockNow.mockImplementation(() => view.detach());
  return { view, thread, streams, lockNow };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createServerChatView stream lifecycle", () => {
  beforeEach(() => {
    createServerIdentity.mockReset();
    mountServerSettingsSheet.mockReset();
    mountServerThread.mockReset();
    openServerStream.mockReset();
  });

  it.each(["panic", "idle", "hidden"] as const)(
    "does not open a stream if the view detaches for %s while attach is pending",
    async (cause) => {
      const resolveAttaches: Array<(cursor: number) => void> = [];
      const harness = createHarness(() => new Promise((resolve) => { resolveAttaches.push(resolve); }));
      harness.view.attach(SESSION_ONE);

      harness.lockNow(cause);
      resolveAttaches[0]?.(4);
      await flush();

      expect(openServerStream).not.toHaveBeenCalled();
      harness.view.attach(SESSION_TWO);
      resolveAttaches[1]?.(5);
      await flush();
      expect(openServerStream).toHaveBeenCalledOnce();
      expect(harness.streams).toHaveLength(1);
      harness.view.dispose();
    },
  );

  it("ignores a late locked event from a stream belonging to the previous unlock", async () => {
    const harness = createHarness(async () => 0);
    harness.view.attach(SESSION_ONE);
    await flush();
    expect(harness.streams).toHaveLength(1);
    harness.view.detach();
    expect(harness.streams[0]?.handle.close).toHaveBeenCalledOnce();

    harness.view.attach(SESSION_TWO);
    await flush();
    expect(harness.streams).toHaveLength(2);
    harness.streams[0]?.onEvent({ type: "locked" });
    expect(harness.lockNow).not.toHaveBeenCalled();
    harness.view.dispose();
  });

  it("ignores a late unauthorized attach failure from a previous unlock", async () => {
    const resolvers = new Map<string, (cursor: number) => void>();
    const rejectors = new Map<string, (error: unknown) => void>();
    const harness = createHarness((session) => new Promise((resolve, reject) => {
      resolvers.set(session.token, resolve);
      rejectors.set(session.token, reject);
    }));
    harness.view.attach(SESSION_ONE);
    harness.view.detach();
    harness.view.attach(SESSION_TWO);
    resolvers.get(SESSION_TWO.token)?.(5);
    await flush();
    rejectors.get(SESSION_ONE.token)?.(new ServerLockedError());
    await flush();

    expect(harness.lockNow).not.toHaveBeenCalled();
    expect(openServerStream).toHaveBeenCalledOnce();
    harness.view.dispose();
  });
});
