import { describe, expect, it, vi } from "vitest";
import type { TranscribeAnswer } from "../src/server/api/messages";
import type { Attachment, AttachmentTranscript } from "../src/server/mediaRender";
import {
  differOnlyInTranscripts,
  patchTranscriptBlocks,
  refreshTranscriptBlocks,
  renderTranscriptBlock,
  type TranscriptionContext,
} from "../src/server/transcript";

const voice: Attachment = {
  id: "a".repeat(32),
  kind: "voice",
  status: "ready",
  width: null,
  height: null,
  durationS: 4,
  peaks: [0.1, 0.5],
  urls: { play: "/play?exp=1&sig=x" },
};

interface Harness {
  readonly ctx: TranscriptionContext;
  readonly request: ReturnType<typeof vi.fn<(id: string) => Promise<TranscribeAnswer>>>;
  readonly markUnavailable: ReturnType<typeof vi.fn>;
  readonly hidden: Set<string>;
  available: boolean;
}

function harness(answer: TranscribeAnswer | Promise<TranscribeAnswer> = { kind: "started", transcript: { status: "pending" } }): Harness {
  const hidden = new Set<string>();
  const state = { available: true };
  const request = vi.fn<(id: string) => Promise<TranscribeAnswer>>(() => Promise.resolve(answer));
  const markUnavailable = vi.fn(() => {
    state.available = false;
  });
  const ctx: TranscriptionContext = {
    available: () => state.available,
    request,
    markUnavailable,
    isHidden: (id) => hidden.has(id),
    setHidden: (id, value) => {
      if (value) hidden.add(id);
      else hidden.delete(id);
    },
  };
  return {
    ctx,
    request,
    markUnavailable,
    hidden,
    get available() {
      return state.available;
    },
    set available(value: boolean) {
      state.available = value;
    },
  };
}

function block(h: Harness, attachment: Attachment = voice): HTMLElement {
  return renderTranscriptBlock(attachment, h.ctx, document);
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("transcript block", () => {
  it("offers a Transcribe button on a voice note that has none yet", () => {
    const el = block(harness());
    expect(el.dataset["state"]).toBe("idle");
    expect(el.hidden).toBe(false);
    const button = el.querySelector<HTMLButtonElement>("button.wx-srv-transcript-start");
    expect(button?.textContent).toBe("Transcribe");
    expect(button?.getAttribute("aria-label")).toBe("Transcribe this voice note");
  });

  it("shows nothing at all while transcription is unavailable", () => {
    const h = harness();
    h.available = false;
    const el = block(h);
    expect(el.hidden).toBe(true);
    expect(el.children).toHaveLength(0);
    expect(el.dataset["state"]).toBe("none");
  });

  it("never asks the server until the button is clicked", () => {
    const h = harness();
    block(h);
    block(h, { ...voice, transcript: { status: "failed" } });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("shows a spinner at once on click, and a second click while it is pending does nothing", async () => {
    const h = harness();
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(voice.id);
    expect(el.dataset["state"]).toBe("pending");
    expect(el.querySelector(".wx-srv-transcript-spinner")).not.toBeNull();
    expect(el.querySelector("[role=status]")?.textContent).toBe("Transcribing…");
    expect(el.querySelector("button")).toBeNull();
    await settle();
    expect(el.dataset["state"]).toBe("pending"); // the server's 202 keeps the spinner up
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("the stream's update turns the spinner into the text, with a Hide button", async () => {
    const h = harness();
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    await settle();

    patchTranscriptBlocks(el.parentNode ?? wrap(el), [{ ...voice, transcript: { status: "done", text: "hello there" } }]);

    expect(el.dataset["state"]).toBe("done");
    expect(el.querySelector(".wx-srv-transcript-text")?.textContent).toBe("hello there");
    expect(el.querySelector(".wx-srv-transcript-toggle")?.textContent).toBe("Hide transcript");
    expect(el.querySelector(".wx-srv-transcript-spinner")).toBeNull();
  });

  it("a stored transcript answered with 200 shows straight away", async () => {
    const h = harness({ kind: "done", transcript: { status: "done", text: "already had it" } });
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    await settle();
    expect(el.querySelector(".wx-srv-transcript-text")?.textContent).toBe("already had it");
  });

  it("renders the text as plain text, never markup", () => {
    const el = block(harness(), { ...voice, transcript: { status: "done", text: "<img src=x onerror=alert(1)> & <b>hi</b>" } });
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector(".wx-srv-transcript-text")?.textContent).toBe("<img src=x onerror=alert(1)> & <b>hi</b>");
  });

  it("Hide and Show are a per-device choice that survives a repaint", () => {
    const h = harness();
    const el = block(h, { ...voice, transcript: { status: "done", text: "secret words" } });
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-toggle")!.click();
    expect(h.hidden.has(voice.id)).toBe(true);
    expect(el.dataset["state"]).toBe("hidden");
    expect(el.querySelector(".wx-srv-transcript-text")).toBeNull();
    expect(el.textContent).not.toContain("secret words");
    expect(el.querySelector(".wx-srv-transcript-toggle")?.textContent).toBe("Show transcript");

    refreshTranscriptBlocks(wrap(el)); // an unrelated repaint keeps it hidden
    expect(el.querySelector(".wx-srv-transcript-text")).toBeNull();

    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-toggle")!.click();
    expect(h.hidden.has(voice.id)).toBe(false);
    expect(el.querySelector(".wx-srv-transcript-text")?.textContent).toBe("secret words");
  });

  it("an empty transcript says nothing was picked up, with nothing to hide", () => {
    const el = block(harness(), { ...voice, transcript: { status: "done", text: "" } });
    expect(el.dataset["state"]).toBe("empty");
    expect(el.textContent).toBe("No speech was picked up.");
    expect(el.querySelector("button")).toBeNull();
  });

  it("a failed transcript shows a plain error with Retry, and Retry asks again", async () => {
    const h = harness();
    const el = block(h, { ...voice, transcript: { status: "failed" } });
    expect(el.dataset["state"]).toBe("failed");
    expect(el.querySelector(".wx-srv-transcript-error")?.textContent).toBe("Couldn't transcribe this voice note.");
    const retry = el.querySelector<HTMLButtonElement>(".wx-srv-transcript-retry")!;
    expect(retry.textContent).toBe("Retry");
    retry.click();
    expect(h.request).toHaveBeenCalledExactlyOnceWith(voice.id);
    expect(el.dataset["state"]).toBe("pending");
    await settle();
  });

  it("a failed transcript offers no Retry while transcription is unavailable", () => {
    const h = harness();
    h.available = false;
    const el = block(h, { ...voice, transcript: { status: "failed" } });
    expect(el.querySelector(".wx-srv-transcript-error")).not.toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });

  it("a finished transcript stays readable even when transcription is unavailable", () => {
    const h = harness();
    h.available = false;
    const el = block(h, { ...voice, transcript: { status: "done", text: "still here" } });
    expect(el.querySelector(".wx-srv-transcript-text")?.textContent).toBe("still here");
  });

  it.each<[string, TranscribeAnswer, string]>([
    ["unavailable", { kind: "unavailable" }, "Transcription isn't available right now."],
    ["rate limited", { kind: "rate_limited", retryAfterS: 12.2 }, "That's a lot of transcripts — try again in 13 seconds."],
    ["rate limited (one second)", { kind: "rate_limited", retryAfterS: 1 }, "That's a lot of transcripts — try again in 1 second."],
    ["gone", { kind: "gone" }, "This voice note is no longer available."],
    ["not ready", { kind: "not_ready" }, "This voice note is still being processed — try again in a moment."],
    ["failed", { kind: "failed" }, "Couldn't reach the server — try again."],
  ])("a %s answer shows a plain notice", async (_name, answer, message) => {
    const h = harness(answer);
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    await settle();
    expect(el.querySelector(".wx-srv-transcript-error")?.textContent).toBe(message);
  });

  it("an unavailable answer hides the control for every note", async () => {
    const h = harness({ kind: "unavailable" });
    const host = wrap(block(h));
    const other = renderTranscriptBlock({ ...voice, id: "b".repeat(32) }, h.ctx, document);
    host.appendChild(other);
    host.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    await settle();
    expect(h.markUnavailable).toHaveBeenCalledTimes(1);
    refreshTranscriptBlocks(host);
    expect(other.hidden).toBe(true);
    expect(other.querySelector("button")).toBeNull();
  });

  it("a notice clears when a real state arrives, and the button returns after a notice", async () => {
    const h = harness({ kind: "rate_limited", retryAfterS: 30 });
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    await settle();
    expect(el.dataset["state"]).toBe("error");
    expect(el.querySelector(".wx-srv-transcript-start")).not.toBeNull(); // try again later

    patchTranscriptBlocks(wrap(el), [{ ...voice, transcript: { status: "pending" } }]);
    expect(el.dataset["state"]).toBe("pending");
    expect(el.querySelector(".wx-srv-transcript-error")).toBeNull();
  });

  it.each<[string, AttachmentTranscript]>([
    ["failed", { status: "failed" }],
    ["done", { status: "done", text: "finished first" }],
  ])("a slow 202 cannot overwrite a %s state the stream already delivered", async (_name, arrived) => {
    let reply: (answer: TranscribeAnswer) => void = () => {};
    const h = harness(new Promise<TranscribeAnswer>((resolve) => (reply = resolve)));
    const host = wrap(block(h));
    const el = host.querySelector<HTMLElement>(".wx-srv-transcript")!;
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();

    // The job finished and its update reached us BEFORE the HTTP reply did...
    patchTranscriptBlocks(host, [{ ...voice, transcript: arrived }]);
    // ...and then the (now stale) "pending" reply lands.
    reply({ kind: "started", transcript: { status: "pending" } });
    await settle();

    expect(el.dataset["state"]).toBe(arrived.status);
    expect(el.querySelector(".wx-srv-transcript-spinner")).toBeNull();
  });

  it("a 202 with no newer stream update still shows the spinner", async () => {
    const h = harness({ kind: "started", transcript: { status: "pending" } });
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    await settle();
    expect(el.dataset["state"]).toBe("pending");
  });

  it("a stale 'never asked' update cannot undo a request in flight", () => {
    const h = harness(new Promise<TranscribeAnswer>(() => {}));
    const el = block(h);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    patchTranscriptBlocks(wrap(el), [{ ...voice, transcript: null }]);
    expect(el.dataset["state"]).toBe("pending");
  });

  it("repaints from the server: pending on the other device, then done, then back to idle if erased", () => {
    const h = harness();
    const host = wrap(block(h));
    const el = host.querySelector<HTMLElement>(".wx-srv-transcript")!;
    patchTranscriptBlocks(host, [{ ...voice, transcript: { status: "pending" } }]);
    expect(el.dataset["state"]).toBe("pending");
    patchTranscriptBlocks(host, [{ ...voice, transcript: { status: "done", text: "hi" } }]);
    expect(el.dataset["state"]).toBe("done");
    patchTranscriptBlocks(host, [{ ...voice, transcript: null }]);
    expect(el.dataset["state"]).toBe("idle");
  });

  it("only blocks whose attachment is in the update are touched", () => {
    const h = harness();
    const host = wrap(block(h));
    const other = renderTranscriptBlock({ ...voice, id: "c".repeat(32) }, h.ctx, document);
    host.appendChild(other);
    patchTranscriptBlocks(host, [{ ...voice, id: "c".repeat(32), transcript: { status: "done", text: "c note" } }]);
    expect(other.dataset["state"]).toBe("done");
    expect(host.querySelector<HTMLElement>(`[data-attachment-id="${voice.id}"]`)?.dataset["state"]).toBe("idle");
  });
});

describe("differOnlyInTranscripts", () => {
  const message = (attachment: Attachment, extra: Record<string, unknown> = {}) => ({
    seq: 1,
    text: "hi",
    attachments: [attachment],
    ...extra,
  });

  it("is true when only a transcript changed", () => {
    const before = message(voice);
    for (const transcript of [
      { status: "pending" },
      { status: "failed" },
      { status: "done", text: "words" },
    ] as const) {
      expect(differOnlyInTranscripts(before, message({ ...voice, transcript }))).toBe(true);
    }
    expect(
      differOnlyInTranscripts(
        message({ ...voice, transcript: { status: "pending" } }),
        message({ ...voice, transcript: { status: "done", text: "words" } }),
      ),
    ).toBe(true);
  });

  it.each<[string, () => ReturnType<typeof message>]>([
    ["a re-signed url", () => message({ ...voice, urls: { play: "/play?exp=2&sig=y" } })],
    ["the processing status", () => message({ ...voice, status: "processing" })],
    ["the duration", () => message({ ...voice, durationS: 9 })],
    ["the message text", () => message(voice, { text: "edited" })],
    ["an extra attachment", () => ({ ...message(voice), attachments: [voice, { ...voice, id: "d".repeat(32) }] })],
    ["another message field", () => message(voice, { reactions: [1] })],
  ])("is false when %s changed too", (_name, next) => {
    expect(differOnlyInTranscripts(message(voice), next())).toBe(false);
  });
});

function wrap(el: HTMLElement): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(el);
  return host;
}
