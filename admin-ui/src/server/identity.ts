// Display name + device id (spec/server-chat/00-brief.md §10 P5b): a display
// name set once per browser/device (localStorage, changeable in settings)
// distinguishes participants — it is NOT tied to the CF Access identity that
// unlocked the chat. `deviceId` is this browser's own opaque tag, used only
// to exclude this device from its own push notifications (P3b) — never sent
// to another participant.

const NAME_KEY = "wx-srv-name";
const DEVICE_KEY = "wx-srv-device";
const MAX_NAME_LENGTH = 32;

export interface ServerIdentity {
  /** `null` before the name prompt has ever been completed on this device. */
  getName(): string | null;
  /** Trims and clamps to 1-32 chars; a blank result after trimming is a
   * no-op (the caller — the name prompt / settings sheet — validates first
   * and never calls this with nothing worth saving). */
  setName(name: string): void;
  /** Minted once per device and persisted; never rotates. */
  getDeviceId(): string;
  /** Case-insensitive match against this device's own saved name — the
   * "own message" side of the thread's left/right alignment. */
  isMine(sender: string): boolean;
}

export function createServerIdentity(win: Window = window): ServerIdentity {
  const storage = win.localStorage;

  function getName(): string | null {
    const raw = storage.getItem(NAME_KEY);
    return raw !== null && raw.trim() !== "" ? raw : null;
  }

  return {
    getName,
    setName(name: string): void {
      const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
      if (trimmed === "") return;
      storage.setItem(NAME_KEY, trimmed);
    },
    getDeviceId(): string {
      const existing = storage.getItem(DEVICE_KEY);
      if (existing !== null) return existing;
      const minted = win.crypto.randomUUID();
      storage.setItem(DEVICE_KEY, minted);
      return minted;
    },
    isMine(sender: string): boolean {
      const mine = getName();
      return mine !== null && mine.toLowerCase() === sender.toLowerCase();
    },
  };
}
