// The "stick to bottom while already there, offer a jump pill otherwise"
// scroll behavior (extracted from chatPanel.ts, decisions/00110 — workspace
// #29 sec.10 P5a). A thread only sticks to its own newest content while the
// viewer is already at (or near) the bottom; scrolled up reading history, new
// arrivals surface as a "↓ New messages" pill instead of yanking the view
// down. Shared by the AI chat panel and, going forward, the server chat
// thread (spec/server-chat/00-brief.md §6/§10 P5b).

/** How far from the thread's bottom (px) still counts as "at the bottom" —
 * the stick-to-bottom latch's hysteresis. */
const BOTTOM_STICK_THRESHOLD_PX = 48;

export interface ChatThreadScroll {
  /** True while the viewer is considered pinned to the bottom. */
  readonly stuck: boolean;
  /** Scrolls to the bottom immediately and hides the jump pill. */
  scrollToBottom(): void;
  /** Call right after the thread's content changes (e.g. a re-render): if the
   * viewer was already stuck to the bottom, keeps them there; otherwise, when
   * `revealPill` is true, shows the jump pill. `revealPill` is the caller's
   * call — e.g. the AI panel never reveals it for the owner's own messages.
   * While a `hold` is active a stuck viewer is NOT moved (the pill still shows
   * for `revealPill`), because something is being done at a fixed spot. */
  afterContentChange(revealPill: boolean): void;
  /** Keeps the thread exactly where it is until the returned release runs —
   * the Server chat's pen (spec/server-chat/07-live-drawing.md) holds it for
   * the length of one stroke, so a message arriving mid-stroke can never slide
   * the chat out from under the finger. Releasing moves nothing either; the
   * next content change re-sticks a stuck viewer as usual. Releasing twice is
   * harmless. */
  hold(): () => void;
  teardown(): void;
}

export function mountChatThreadScroll(thread: HTMLElement, jumpPill: HTMLElement): ChatThreadScroll {
  let stuck = true;
  let holds = 0;

  function scrollToBottom(): void {
    thread.scrollTop = thread.scrollHeight;
    stuck = true;
    jumpPill.hidden = true;
  }

  function onScroll(): void {
    const atBottom =
      thread.scrollTop + thread.clientHeight >= thread.scrollHeight - BOTTOM_STICK_THRESHOLD_PX;
    stuck = atBottom;
    if (atBottom) jumpPill.hidden = true;
  }
  thread.addEventListener("scroll", onScroll);

  function onJumpClick(): void {
    scrollToBottom();
  }
  jumpPill.addEventListener("click", onJumpClick);

  return {
    get stuck() {
      return stuck;
    },
    scrollToBottom,
    afterContentChange(revealPill: boolean): void {
      if (stuck && holds === 0) {
        thread.scrollTop = thread.scrollHeight;
      } else if (revealPill) {
        jumpPill.hidden = false;
      }
    },
    hold(): () => void {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
      };
    },
    teardown(): void {
      thread.removeEventListener("scroll", onScroll);
      jumpPill.removeEventListener("click", onJumpClick);
    },
  };
}
