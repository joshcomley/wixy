import { describe, expect, it, vi } from "vitest";
import { parseTranscript as parseTranscriptForTest } from "../src/server/api/messages";
import type { TranscribeAnswer } from "../src/server/api/messages";
import type { Attachment, AttachmentTranscript } from "../src/server/mediaRender";
import {
  isTranscribableVoice,
  patchTranscriptBlocks,
  renderTranscriptBlock,
  type TranscriptionContext,
} from "../src/server/transcript";

// A live voice note's transcript (spec/server-chat/07 §3, §6.3): finished sentences, then a
// greyed provisional tail rewritten on every pass, then the normal stored transcript.

const live: Attachment = {
  id: "d".repeat(32), kind: "voice", status: "live", liveState: "recording",
  width: null, height: null, durationS: 0, peaks: [], urls: {},
};

function context(answer: TranscribeAnswer = { kind: "started", transcript: { status: "pending" } }) {
  const hidden = new Set<string>();
  const request = vi.fn(() => Promise.resolve(answer));
  const ctx: TranscriptionContext = {
    available: () => true,
    request,
    markUnavailable: vi.fn(),
    isHidden: (id) => hidden.has(id),
    setHidden: (id, value) => { if (value) hidden.add(id); else hidden.delete(id); },
  };
  return { ctx, request };
}

const text = (el: HTMLElement, selector: string) => el.querySelector(selector)?.textContent ?? null;

describe("transcribing a live voice note", () => {
  it("offers Transcribe on a live note, like a finished one, and asks the server when tapped", async () => {
    const { ctx, request } = context();
    const el = renderTranscriptBlock(live, ctx, document);
    expect(el.dataset["state"]).toBe("idle");
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-start")!.click();
    expect(request).toHaveBeenCalledWith(live.id);
    await Promise.resolve();
    expect(el.dataset["state"]).toBe("pending");
  });

  it("shows the finalised text normally and the unfinished tail greyed", () => {
    const { ctx } = context();
    const el = renderTranscriptBlock({ ...live, transcript: { status: "live", text: "Hello there.", tail: "how are" } }, ctx, document);
    expect(el.dataset["state"]).toBe("live");
    expect(text(el, ".wx-srv-transcript-final")).toBe("Hello there.");
    expect(text(el, ".wx-srv-transcript-tail")).toBe("how are");
    expect(el.querySelector(".wx-srv-transcript-text")?.textContent).toBe("Hello there. how are");
  });

  it("rewrites the tail on every update (and may take it back to nothing), in place", () => {
    const { ctx } = context();
    const el = renderTranscriptBlock(live, ctx, document);
    document.body.appendChild(el);
    const update = (transcript: AttachmentTranscript) => patchTranscriptBlocks(document.body, [{ ...live, transcript }]);
    update({ status: "live", text: "", tail: "uh hello" });
    expect(text(el, ".wx-srv-transcript-tail")).toBe("uh hello");
    expect(el.querySelector(".wx-srv-transcript-final")).toBeNull();
    update({ status: "live", text: "Hello.", tail: "how are you" });
    expect(text(el, ".wx-srv-transcript-final")).toBe("Hello.");
    expect(text(el, ".wx-srv-transcript-tail")).toBe("how are you");
    // the engine decided a sentence ended earlier: the tail is rewritten shorter
    update({ status: "live", text: "Hello. How are you?", tail: "I am" });
    expect(text(el, ".wx-srv-transcript-final")).toBe("Hello. How are you?");
    expect(text(el, ".wx-srv-transcript-tail")).toBe("I am");
    update({ status: "live", text: "Hello. How are you?", tail: "" });
    expect(el.querySelector(".wx-srv-transcript-tail")).toBeNull();
    el.remove();
  });

  it("says it is listening before any words arrive", () => {
    const { ctx } = context();
    const el = renderTranscriptBlock({ ...live, transcript: { status: "live", text: "", tail: "" } }, ctx, document);
    expect(el.textContent).toContain("Listening…");
  });

  it("is replaced by the normal done transcript after Stop", () => {
    const { ctx } = context();
    const el = renderTranscriptBlock({ ...live, transcript: { status: "live", text: "Hi.", tail: "there" } }, ctx, document);
    document.body.appendChild(el);
    patchTranscriptBlocks(document.body, [{ ...live, status: "ready", transcript: { status: "done", text: "Hi there." } }]);
    expect(el.dataset["state"]).toBe("done");
    expect(text(el, ".wx-srv-transcript-text")).toBe("Hi there.");
    expect(el.querySelector(".wx-srv-transcript-tail")).toBeNull();
    expect(el.querySelector(".wx-srv-transcript-retranscribe")).not.toBeNull();
    el.remove();
  });

  it("Hide and Show work on a live transcript", () => {
    const { ctx } = context();
    const el = renderTranscriptBlock({ ...live, transcript: { status: "live", text: "Hi.", tail: "" } }, ctx, document);
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-toggle")!.click();
    expect(el.dataset["state"]).toBe("hidden");
    expect(el.querySelector(".wx-srv-transcript-text")).toBeNull();
    el.querySelector<HTMLButtonElement>(".wx-srv-transcript-toggle")!.click();
    expect(text(el, ".wx-srv-transcript-final")).toBe("Hi.");
  });

  it("sets the words as text, never markup", () => {
    const { ctx } = context();
    const el = renderTranscriptBlock({ ...live, transcript: { status: "live", text: "<b>x</b>", tail: "<i>y</i>" } }, ctx, document);
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("i")).toBeNull();
    expect(text(el, ".wx-srv-transcript-final")).toBe("<b>x</b>");
  });
});

describe("which voice notes carry the Transcribe control", () => {
  it("a live note, a ready note, and a stopped note still showing its live transcript; not a plain processing note", () => {
    expect(isTranscribableVoice(live)).toBe(true);
    expect(isTranscribableVoice({ ...live, status: "ready" })).toBe(true);
    expect(isTranscribableVoice({ ...live, status: "processing", transcript: { status: "live", text: "a", tail: "" } })).toBe(true);
    expect(isTranscribableVoice({ ...live, status: "processing" })).toBe(false);
    expect(isTranscribableVoice({ ...live, status: "failed" })).toBe(false);
    expect(isTranscribableVoice({ ...live, kind: "photo" })).toBe(false);
  });
});

describe("the live transcript on the wire", () => {
  it("is read from a transcribe answer", () => {
    expect(parseTranscriptForTest({ status: "live", text: "a", tail: "b" })).toEqual({ status: "live", text: "a", tail: "b" });
    expect(parseTranscriptForTest({ status: "live", text: "a" })).toEqual({ status: "live", text: "a", tail: "" });
    expect(parseTranscriptForTest({ status: "live", tail: "b" })).toBeNull();
  });
});
