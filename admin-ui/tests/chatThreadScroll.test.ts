import { describe, expect, it } from "vitest";
import { mountChatThreadScroll } from "../src/chatThreadScroll";

/** jsdom never does real layout — scrollHeight/clientHeight always read 0,
 * which would make "at the bottom" trivially true for every test. Override
 * them per-element so the 48px hysteresis math is actually exercised. */
function metrics(el: HTMLElement, values: { scrollTop?: number; scrollHeight: number; clientHeight: number }): void {
  if (values.scrollTop !== undefined) {
    Object.defineProperty(el, "scrollTop", { value: values.scrollTop, configurable: true, writable: true });
  }
  Object.defineProperty(el, "scrollHeight", { value: values.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: values.clientHeight, configurable: true });
}

function makeThread(): { thread: HTMLDivElement; jumpPill: HTMLButtonElement } {
  const thread = document.createElement("div");
  const jumpPill = document.createElement("button");
  jumpPill.hidden = true;
  return { thread, jumpPill };
}

describe("mountChatThreadScroll", () => {
  it("starts stuck to the bottom", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    expect(scroll.stuck).toBe(true);
    scroll.teardown();
  });

  it("a scroll event within the 48px threshold stays stuck; beyond it unsticks", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);

    metrics(thread, { scrollTop: 900, scrollHeight: 1000, clientHeight: 60 }); // 900+60=960 >= 1000-48=952
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(true);

    metrics(thread, { scrollTop: 400, scrollHeight: 1000, clientHeight: 60 }); // 400+60=460 < 952
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(false);
    scroll.teardown();
  });

  it("scrolling back to the bottom re-sticks and hides the pill", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    metrics(thread, { scrollTop: 0, scrollHeight: 1000, clientHeight: 60 });
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(false);

    jumpPill.hidden = false; // simulate the pill having been revealed
    metrics(thread, { scrollTop: 950, scrollHeight: 1000, clientHeight: 60 });
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(true);
    expect(jumpPill.hidden).toBe(true);
    scroll.teardown();
  });

  it("afterContentChange re-sticks to the new bottom while stuck", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    metrics(thread, { scrollHeight: 500, clientHeight: 60 });

    scroll.afterContentChange(false);
    expect(thread.scrollTop).toBe(500);
    scroll.teardown();
  });

  it("afterContentChange reveals the pill only when not stuck AND revealPill is true", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    metrics(thread, { scrollTop: 0, scrollHeight: 1000, clientHeight: 60 });
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(false);

    scroll.afterContentChange(false);
    expect(jumpPill.hidden).toBe(true);

    scroll.afterContentChange(true);
    expect(jumpPill.hidden).toBe(false);
    scroll.teardown();
  });

  it("scrollToBottom forces stuck true and hides the pill regardless of prior state", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    metrics(thread, { scrollTop: 0, scrollHeight: 800, clientHeight: 60 });
    thread.dispatchEvent(new Event("scroll"));
    jumpPill.hidden = false;
    expect(scroll.stuck).toBe(false);

    scroll.scrollToBottom();
    expect(scroll.stuck).toBe(true);
    expect(jumpPill.hidden).toBe(true);
    expect(thread.scrollTop).toBe(800);
    scroll.teardown();
  });

  it("clicking the jump pill scrolls to the bottom", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    metrics(thread, { scrollTop: 0, scrollHeight: 1200, clientHeight: 60 });
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(false);

    jumpPill.dispatchEvent(new Event("click"));
    expect(scroll.stuck).toBe(true);
    expect(jumpPill.hidden).toBe(true);
    expect(thread.scrollTop).toBe(1200);
    scroll.teardown();
  });

  it("teardown removes the scroll and click listeners", () => {
    const { thread, jumpPill } = makeThread();
    const scroll = mountChatThreadScroll(thread, jumpPill);
    scroll.teardown();

    metrics(thread, { scrollTop: 0, scrollHeight: 1000, clientHeight: 60 });
    thread.dispatchEvent(new Event("scroll"));
    expect(scroll.stuck).toBe(true); // unchanged -- the listener no longer fires

    jumpPill.dispatchEvent(new Event("click"));
    expect(thread.scrollTop).toBe(0); // unchanged -- the listener no longer fires
  });
});
