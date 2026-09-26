// FROZEN interfaces (spec/server-chat/00-brief.md §6) — P4 owns this file;
// P3, P5 and P6 import from it to build concurrently against a fixed shape.
// Do not change a member here without going back through the Architect
// (`ask-architect`) — every other parcel's code depends on these staying
// exactly as specified.

/** The unlock token handed back by `POST /unlock` (§5.1) — lives only in JS
 * memory for the lifetime of one unlock (R4: never persisted to
 * localStorage/sessionStorage/cookies/URLs). */
export interface ServerSession {
  readonly token: string;
  readonly expiresAt: number;
}

/** R7 — the four reasons the idle timer pauses instead of counting down.
 * `suspend()` (see `LockHooks` below) is idempotent per reason and returns a
 * release function; the idle timer restarts fresh (a full idle period — see
 * `idleTimeoutMs`) the moment the LAST active suspension for a given reason
 * ends. */
export type SuspendReason = "recording" | "micPermission" | "filePicker" | "mediaPlaying" | "viewOnce";

/** R6 — every distinct trigger that can force an instant lock (all eight of
 * R6's bullets except "a page reload", which needs no cause: unlock state is
 * never persisted, so a reload always starts fresh at the decoy — unless the
 * device has "Keep this device unlocked" on, in which case the panel mints a
 * fresh token from its device grant, `deviceGrant.ts`).
 *
 * `screenLock` (spec/server-chat/03-permanent-unlock.md §8) is the screen
 * being locked, reported by the Idle Detection API. `idleAway` is the idle period having run out
 * while the page was in the background: an INSTANT lock (no fade — nobody is watching, and a
 * touch on return must not be able to cancel it). */
export type LockCause =
  | "idle"
  | "panic"
  | "multiTap"
  | "escape"
  | "hidden"
  | "routeAway"
  | "unauthorized"
  | "expired"
  | "screenLock"
  | "idleAway"
  /** §9 (audit F4 ruling): the owner turned "Keep this device unlocked" off from the
   * settings sheet. Deliberate, like `panic`/`multiTap`/`escape`, but the grant behind it
   * is being fully revoked and cleared right here (`turnKeepOff`), not merely paused — so
   * it is intentionally absent from `pausesGrant`'s list. */
  | "grantOff";

/** The callback surface `panel.ts` hands to the mounted `ServerChatView` (and
 * anything it in turn mounts — uploader, recorder, media renderer) so those
 * modules can pause the idle timer around their own async gaps and force an
 * instant lock (e.g. the chat view's own panic ✕, or a 401 from `serverFetch`
 * turned into `lockNow("unauthorized")`). */
export interface LockHooks {
  /** Pauses the idle timer for `reason`. Idempotent: calling it again for a
   * reason already active is a harmless no-op that returns its own release
   * (releasing either just un-suspends once every holder has released).
   * Returns a release function — the idle timer restarts with a fresh full
   * idle period (the device's configured duration) once the last active
   * suspension ends (R7). */
  suspend(reason: SuspendReason): () => void;
  /** Forces an instant lock for `cause`, from any state. A no-op if already
   * locked. */
  lockNow(cause: LockCause): void;
  /** §9 (audit F4 ruling): adopt a freshly BOUND session — the token `POST /device-grants`
   * itself returns on a successful enrolment — with no visible change, exactly like a silent
   * renewal (`ServerChatView.attach` may be called again while attached). `grantId` names the
   * exact grant `session` is bound to (F7 fix — never inferred from storage). Without this the
   * live session stays whatever it was before enrolling (often an unbound PIN token), so
   * "Sign out other devices" called moments later would see an unbound caller and spare
   * nothing — the newly-created grant included. A no-op once the panel has been torn down. */
  adoptBoundSession(session: ServerSession, grantId: string): void;
  /** §9 (audit F4 ruling, F7 fix): the grant id the LIVE session is currently bound to, or
   * null for a plain PIN session — including one whose bound exchange is still pending or has
   * failed. Used by "Sign out other devices" (§9.7) to decide whether THIS device's own local
   * grant keys survive the call: the server only spares the caller's grant when the caller's
   * own token is bound to it, so the client must keep local state consistent with that same
   * test rather than assuming "I have a grant" means "the server just spared it". */
  getBoundGrantId(): string | null;
}

/** The server-chat HTTP API surface, assembled from each area's own client
 * module (`server/api/messages.ts`, `uploads.ts`, `push.ts`, … as those
 * parcels land — see spec/server-chat/00-brief.md §5). Deliberately left
 * open here: this file only fixes the SHAPE `createServerChatView` receives
 * it through, not its members — nothing in this parcel constructs or calls
 * one. `POST /unlock` is NOT a member: it runs before a `ServerSession`
 * exists and lives in `server/api/unlock.ts` as its own function instead. */
export interface ServerApi {
  readonly [futureMember: string]: unknown;
}

/** The mounted chat view (P5, `server/chatView.ts`). `panel.ts` owns its
 * lifecycle across lock/unlock cycles: `attach`/`detach` run on every
 * unlock/lock within one page visit (the instance — and its draft text,
 * in-flight uploads, staged recording — survives in memory); `dispose` runs
 * exactly once, when the panel itself is torn down (routing away from
 * `/admin/server` for good). */
export interface ServerChatView {
  readonly element: HTMLElement;
  /** The panel has just inserted `element` into the document (unlocked) —
   * load history / resume the live stream.
   *
   * The panel may also call this AGAIN, without a `detach` between, with a
   * renewed session (a device grant re-minting the token before it expires,
   * 03-permanent-unlock.md §4): the view must adopt the new token, reopen its
   * stream from where it left off, and refresh any signed media URLs, without
   * showing any change. (`thread.ts`'s retry button already relies on the
   * thread half of that being safe.) */
  attach(session: ServerSession): void;
  /** The panel calls this BEFORE removing `element` from the document
   * (locking): abort the stream, pause media, exit fullscreen, discard any
   * in-progress recording, close the lightbox and any open sheets. Draft
   * text and in-flight uploads must survive this call in memory — they
   * resume on the next `attach`. */
  detach(): void;
  /** Panel teardown (leaving `/admin/server` for good): also abort any
   * in-flight uploads — nothing about this view is coming back. */
  dispose(): void;
}

/** The factory `panel.ts` calls once, the first time the lock state machine
 * reaches "chat" — the returned view is kept alive (never re-created) across
 * subsequent lock/unlock cycles within the same panel mount, see
 * `ServerChatView` above. */
export type CreateServerChatView = (deps: {
  api: ServerApi;
  hooks: LockHooks;
  win: Window;
  session: () => ServerSession | null;
}) => ServerChatView;
