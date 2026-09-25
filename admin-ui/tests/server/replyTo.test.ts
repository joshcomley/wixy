// Round 2 ruling item 10 (spec/server-chat/04-round2-rulings.md, ITEM 10 —
// REPLY TO A MESSAGE) §(3)'s REQUIRED drift guard: `replyToFromMessage`
// (here) and the server's `reply_to_json`
// (wixy_server/tests/test_livechat_reply_to_driftguard.py) are asserted
// against the SAME shared JSON fixture
// (spec/server-chat/fixtures/reply-to-cases.json), so the two independent
// reply-quote builders can never silently drift apart.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Attachment, AttachmentKind, Message } from "../../src/server/api/messages";
import { formatReplyQuoteMediaLabel, renderReplyQuoteContent, replyToFromMessage } from "../../src/server/replyTo";

interface FixtureAttachment {
  readonly kind: AttachmentKind;
  readonly status: "ready" | "processing" | "failed";
  readonly durationS: number | null;
}

interface FixtureCase {
  readonly name: string;
  readonly target: {
    readonly sender: string;
    readonly text: string | null;
    readonly attachments: readonly FixtureAttachment[];
  };
  readonly expected: {
    readonly sender: string;
    readonly text: string | null;
    readonly truncated: boolean;
    readonly media: {
      readonly kind: AttachmentKind | "mixed";
      readonly count: number;
      readonly durationS: number | null;
      readonly thumbUrlPresent: boolean;
    } | null;
  };
}

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "spec",
  "server-chat",
  "fixtures",
  "reply-to-cases.json",
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { cases: readonly FixtureCase[] };

function attachmentFromFixture(index: number, entry: FixtureAttachment): Attachment {
  const renditionUrl = "https://example.invalid/media/thumb";
  const hasThumbOrPoster = entry.status === "ready" && (entry.kind === "photo" || entry.kind === "video");
  return {
    id: `attachment-${index}`,
    kind: entry.kind,
    status: entry.status,
    width: null,
    height: null,
    durationS: entry.durationS,
    peaks: null,
    urls: hasThumbOrPoster
      ? entry.kind === "photo"
        ? { thumb: renditionUrl }
        : { poster: renditionUrl }
      : {},
  };
}

function messageFromFixtureTarget(target: FixtureCase["target"]): Message {
  return {
    seq: 1,
    clientId: "fixture-client-id",
    sender: target.sender,
    text: target.text,
    attachments: target.attachments.map((a, i) => attachmentFromFixture(i, a)),
    createdAt: 0,
    replyTo: null,
  };
}

describe("replyToFromMessage — shared drift-guard fixture", () => {
  for (const testCase of fixture.cases) {
    it(`matches the server's reply_to_json for case "${testCase.name}"`, () => {
      const message = messageFromFixtureTarget(testCase.target);
      const result = replyToFromMessage(message);

      expect(result.sender).toBe(testCase.expected.sender);
      expect(result.text).toBe(testCase.expected.text);
      expect(result.truncated).toBe(testCase.expected.truncated);

      if (testCase.expected.media === null) {
        expect(result.media).toBeNull();
        return;
      }
      expect(result.media).not.toBeNull();
      expect(result.media?.kind).toBe(testCase.expected.media.kind);
      expect(result.media?.count).toBe(testCase.expected.media.count);
      expect(result.media?.durationS).toBe(testCase.expected.media.durationS);
      expect(result.media?.thumbUrl !== null).toBe(testCase.expected.media.thumbUrlPresent);
    });
  }

  it("has at least the required case shapes (guards the fixture itself)", () => {
    const names = new Set(fixture.cases.map((c) => c.name));
    const requiredSubstrings = [
      "text-under-300",
      "text-exactly-300",
      "emoji-astride-boundary",
      "single",
      "multiple",
      "mixed",
      "processing",
      "voice-note-duration",
    ];
    for (const substring of requiredSubstrings) {
      expect([...names].some((n) => n.includes(substring)), `missing a ${substring} case`).toBe(true);
    }
  });
});

describe("replyToFromMessage — code-point-safe truncation", () => {
  it("never splits a surrogate pair, unlike a naive UTF-16 slice", () => {
    // 299 'a's then a single-codepoint, 2-UTF-16-unit emoji sitting exactly
    // at the 300th codepoint, then more text — the boundary fixture case's
    // own construction, re-asserted directly against the UTF-16 hazard.
    const text = `${"a".repeat(299)}\u{1F389}${"b".repeat(5)}`;
    const naiveSlice = text.slice(0, 300);
    // A naive UTF-16-unit slice cuts inside the surrogate pair here — proving
    // this case actually exercises the hazard `Array.from(...).slice(...)` guards against.
    expect(naiveSlice.endsWith("\u{1F389}")).toBe(false);

    const message: Message = {
      seq: 1,
      clientId: "c",
      sender: "Josh",
      text,
      attachments: [],
      createdAt: 0,
      replyTo: null,
    };
    const result = replyToFromMessage(message);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${"a".repeat(299)}\u{1F389}`);
    expect(Array.from(result.text ?? "").length).toBe(300);
  });
});

describe("formatReplyQuoteMediaLabel", () => {
  it.each([
    [{ kind: "photo", count: 1, durationS: null, thumbUrl: null }, "Photo"],
    [{ kind: "video", count: 1, durationS: null, thumbUrl: null }, "Video"],
    [{ kind: "voice", count: 1, durationS: 42, thumbUrl: null }, "Voice note · 0:42"],
    [{ kind: "photo", count: 3, durationS: null, thumbUrl: null }, "3 photos"],
    [{ kind: "video", count: 2, durationS: null, thumbUrl: null }, "2 videos"],
    [{ kind: "voice", count: 2, durationS: null, thumbUrl: null }, "2 voice notes"],
    [{ kind: "mixed", count: 4, durationS: null, thumbUrl: null }, "4 attachments"],
  ] as const)("formats %o as %s", (media, expected) => {
    expect(formatReplyQuoteMediaLabel(media)).toBe(expected);
  });
});

describe("renderReplyQuoteContent", () => {
  it("shows 'You' when the quoted sender is the viewer's own name", () => {
    const el = renderReplyQuoteContent(
      { seq: 1, sender: "Josh", text: "hi", truncated: false, media: null },
      { isMine: (sender) => sender === "Josh" },
    );
    expect(el.querySelector(".wx-srv-quote-sender")?.textContent).toBe("You");
  });

  it("shows the sender's own name when the quote isn't the viewer's own", () => {
    const el = renderReplyQuoteContent(
      { seq: 1, sender: "Purdi", text: "hi", truncated: false, media: null },
      { isMine: (sender) => sender === "Josh" },
    );
    expect(el.querySelector(".wx-srv-quote-sender")?.textContent).toBe("Purdi");
  });

  it("appends an ellipsis to a truncated snippet", () => {
    const el = renderReplyQuoteContent(
      { seq: 1, sender: "Josh", text: "cut short", truncated: true, media: null },
      { isMine: () => false },
    );
    expect(el.querySelector(".wx-srv-quote-text")?.textContent).toBe("cut short…");
  });

  it("renders a thumbnail image when the media has a thumbUrl, never a text label alongside it", () => {
    const el = renderReplyQuoteContent(
      {
        seq: 1,
        sender: "Josh",
        text: null,
        truncated: false,
        media: { kind: "photo", count: 1, durationS: null, thumbUrl: "https://example.invalid/thumb" },
      },
      { isMine: () => false },
    );
    const thumb = el.querySelector<HTMLImageElement>(".wx-srv-quote-thumb");
    expect(thumb?.src).toBe("https://example.invalid/thumb");
    expect(el.querySelector(".wx-srv-quote-media-label")).toBeNull();
  });

  it("renders a text label instead of a thumbnail when there is no thumbUrl", () => {
    const el = renderReplyQuoteContent(
      {
        seq: 1,
        sender: "Josh",
        text: null,
        truncated: false,
        media: { kind: "voice", count: 1, durationS: 5, thumbUrl: null },
      },
      { isMine: () => false },
    );
    expect(el.querySelector(".wx-srv-quote-thumb")).toBeNull();
    expect(el.querySelector(".wx-srv-quote-media-label")?.textContent).toBe("Voice note · 0:05");
  });
});
