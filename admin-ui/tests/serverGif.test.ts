import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPage, SendMessageResult } from "../src/server/api/messages";
import type { UploadAttachment } from "../src/server/upload";
import {
  FRY_GIF_URL,
  GifFetchError,
  MAX_GIF_BYTES,
  fetchGifFile,
  findGifLinks,
  isGifLink,
  removeGifLinks,
} from "../src/server/gifLink";
import type { ServerIdentity } from "../src/server/identity";
import { renderAttachments, type Attachment } from "../src/server/mediaRender";
import { mountServerThread } from "../src/server/thread";
import type { LockHooks, ServerSession } from "../src/server/types";

const { getHistory, getUsage, sendMessage, uploadServerAttachment } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getUsage: vi.fn(),
  sendMessage: vi.fn(),
  uploadServerAttachment: vi.fn(),
}));
vi.mock("../src/server/api/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/messages")>()),
  getHistory,
  getUsage,
  sendMessage,
}));
vi.mock("../src/server/api/uploads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/api/uploads")>()),
  uploadServerAttachment,
}));

const KLIPY = "https://static.klipy.com/ii/d7aec6f6f171607374b2065c836f92f4/9d/7d/2KTnFTI6.gif";
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]); // "GIF89a…"

function gifResponse(bytes: Uint8Array = GIF_BYTES, init: ResponseInit = { status: 200 }): Response {
  return new Response(new Uint8Array(bytes).buffer, init);
}

describe("GIF links", () => {
  it("recognises https .gif links on the keyboard GIF hosts only", () => {
    expect(isGifLink(KLIPY)).toBe(true);
    expect(isGifLink("https://media.tenor.com/abc/rick.gif")).toBe(true);
    expect(isGifLink("https://media1.tenor.com/m/abc/x.GIF")).toBe(true);
    expect(isGifLink("https://i.giphy.com/media/abc/giphy.gif")).toBe(true);
    expect(isGifLink("https://media.giphy.com/media/abc/giphy.gif?cid=1")).toBe(true);

    expect(isGifLink("http://static.klipy.com/a.gif")).toBe(false);
    expect(isGifLink("https://evilklipy.com/a.gif")).toBe(false);
    expect(isGifLink("https://klipy.com.evil.example/a.gif")).toBe(false);
    expect(isGifLink("https://example.com/a.gif")).toBe(false);
    expect(isGifLink("https://media.tenor.com/abc/rick.mp4")).toBe(false);
    expect(isGifLink("https://u:p@media.tenor.com/abc/rick.gif")).toBe(false);
    expect(isGifLink("not a url")).toBe(false);
  });

  it("finds each link with its position", () => {
    const text = `lol ${KLIPY} and https://example.com/x.gif`;
    expect(findGifLinks(text)).toEqual([{ url: KLIPY, start: 4, end: 4 + KLIPY.length }]);
  });

  it("removes a link with one neighbouring space and empties whitespace-only text", () => {
    expect(removeGifLinks(`${KLIPY} `, findGifLinks(`${KLIPY} `))).toEqual({ text: "", caret: 0 });
    const text = `lol ${KLIPY} wow`;
    expect(removeGifLinks(text, findGifLinks(text))).toEqual({ text: "lol wow", caret: 4 });
    const trailing = `lol ${KLIPY}`;
    expect(removeGifLinks(trailing, findGifLinks(trailing))).toEqual({ text: "lol", caret: 3 });
  });
});

describe("fetchGifFile", () => {
  it("returns an image/gif File named after the link, without cookies or referrer", async () => {
    const fetchImpl = vi.fn(async () => gifResponse());
    const file = await fetchGifFile(KLIPY, new AbortController().signal, fetchImpl);
    expect(file.type).toBe("image/gif");
    expect(file.name).toBe("2KTnFTI6.gif");
    expect(file.size).toBe(GIF_BYTES.length);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
  });

  it("sends same-origin credentials for the bundled Fry GIF", async () => {
    const fetchImpl = vi.fn(async () => gifResponse());
    const file = await fetchGifFile(FRY_GIF_URL, new AbortController().signal, fetchImpl);
    expect(file.name).toBe("fry-squint.gif");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FRY_GIF_URL);
    expect(init.credentials).toBe("same-origin");
  });

  it("rejects bytes that are not a GIF, a failed response, and an oversized GIF", async () => {
    const signal = new AbortController().signal;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await expect(fetchGifFile(KLIPY, signal, async () => gifResponse(png))).rejects.toThrow("isn't a GIF");
    await expect(fetchGifFile(KLIPY, signal, async () => gifResponse(GIF_BYTES, { status: 404 }))).rejects.toBeInstanceOf(GifFetchError);
    await expect(
      fetchGifFile(KLIPY, signal, async () =>
        gifResponse(GIF_BYTES, { status: 200, headers: { "content-length": String(MAX_GIF_BYTES + 1) } }),
      ),
    ).rejects.toThrow("too big");
    await expect(fetchGifFile(KLIPY, signal, async () => {
      throw new TypeError("network");
    })).rejects.toThrow("Couldn't download that GIF.");
  });
});

describe("animated GIF bubbles", () => {
  const gif: Attachment = {
    id: "g1",
    kind: "photo",
    status: "ready",
    width: 640,
    height: 468,
    durationS: null,
    peaks: null,
    urls: { thumb: "/thumb", full: "/full" },
    animated: true,
  };

  it("plays the full GIF in the bubble with a GIF badge", () => {
    const openLightbox = vi.fn();
    const root = renderAttachments([gif], { hooks: { suspend: vi.fn(() => vi.fn()) }, openLightbox });
    const button = root.querySelector<HTMLButtonElement>(".wx-srv-photo-thumb")!;
    expect(button.querySelector("img")?.getAttribute("src")).toBe("/full");
    expect(button.classList.contains("wx-srv-photo-animated")).toBe(true);
    expect(button.querySelector(".wx-srv-gif-badge")?.textContent).toBe("GIF");
    expect(button.getAttribute("aria-label")).toBe("Open attached GIF");
    button.click();
    expect(openLightbox).toHaveBeenCalledWith("/full", "Attached GIF");
  });

  it("keeps the still thumbnail for an ordinary photo", () => {
    const root = renderAttachments([{ ...gif, animated: false }], { hooks: { suspend: vi.fn(() => vi.fn()) } });
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/thumb");
    expect(root.querySelector(".wx-srv-gif-badge")).toBeNull();
  });
});

// -- The thread: keyboard GIF links and the Fry item ----------------------------------------

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };

function identity(): ServerIdentity {
  return {
    getName: () => "Josh",
    setName: vi.fn(),
    getDeviceId: () => "device-1234",
    isMine: (sender: string) => sender.toLowerCase() === "josh",
  };
}

function hooks(): LockHooks {
  return {
    suspend: vi.fn(() => () => {}),
    lockNow: vi.fn(),
    adoptBoundSession: vi.fn(),
    getBoundGrantId: vi.fn(() => null),
  };
}

let uuid = 0;
function win(): Window {
  return {
    crypto: { randomUUID: () => `uuid-${(uuid += 1)}` },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    navigator: window.navigator,
  } as unknown as Window;
}

function uploaded(id: string): UploadAttachment {
  return { id, kind: "photo", status: "processing", width: null, height: null, durationS: null, peaks: null, urls: {} };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(fetchImpl: typeof fetch) {
  getHistory.mockResolvedValue({ messages: [], hasMore: false, cursor: 0 } satisfies HistoryPage);
  const view = mountServerThread({ identity: identity(), hooks: hooks(), win: win(), onSettings: vi.fn(), fetch: fetchImpl });
  document.body.appendChild(view.element);
  await view.attach(SESSION);
  await settle();
  return view;
}

function typeIntoComposer(view: { element: HTMLElement }, text: string): HTMLTextAreaElement {
  const textarea = view.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input")!;
  textarea.value = text;
  textarea.dispatchEvent(new Event("input"));
  return textarea;
}

beforeEach(() => {
  getHistory.mockReset();
  getUsage.mockReset().mockResolvedValue({ mediaAvailable: true, usedBytes: 0, quotaBytes: 10, freeBytes: 10, erasurePending: false });
  sendMessage.mockReset();
  uploadServerAttachment.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("server chat GIF attaching", () => {
  it("turns a keyboard GIF link into an attached GIF and sends it as an attachment", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    uploadServerAttachment.mockResolvedValue(uploaded("gif-attachment"));
    sendMessage.mockResolvedValue({ ok: false, kind: "unavailable" } as unknown as SendMessageResult);
    const view = await mount(fetchImpl as unknown as typeof fetch);

    const textarea = typeIntoComposer(view, `${KLIPY} `);
    expect(textarea.value).toBe("");
    expect(fetchImpl).toHaveBeenCalledWith(KLIPY, expect.objectContaining({ credentials: "omit" }));
    const pending = view.element.querySelector(".wx-chat-attachment-chip-pending");
    expect(pending?.textContent).toContain("GIF");
    const sendButton = view.element.querySelector<HTMLButtonElement>(".wx-chat-send-button")!;
    expect(sendButton.disabled).toBe(true);

    resolveFetch(gifResponse());
    await settle();

    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    const [file, kind] = uploadServerAttachment.mock.calls[0] as [File, string];
    expect(file.type).toBe("image/gif");
    expect(kind).toBe("photo");
    expect(view.element.querySelector(".wx-chat-attachment-chip-pending")).toBeNull();
    expect(view.element.querySelector(".wx-chat-attachment-thumb")).not.toBeNull();
    expect(sendButton.disabled).toBe(false);

    sendButton.click();
    await settle();
    const [, body] = sendMessage.mock.calls[0] as [ServerSession, { text: string | null; attachmentIds: string[] }];
    expect(body.attachmentIds).toEqual(["gif-attachment"]);
    view.teardown();
  });

  it("keeps the rest of the message text when a GIF link is inserted into it", async () => {
    const fetchImpl = vi.fn(async () => gifResponse());
    uploadServerAttachment.mockResolvedValue(uploaded("gif-attachment"));
    const view = await mount(fetchImpl as unknown as typeof fetch);
    const textarea = typeIntoComposer(view, `look at this ${KLIPY}`);
    expect(textarea.value).toBe("look at this");
    await settle();
    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    view.teardown();
  });

  it("puts the link back and says why when the GIF cannot be fetched, without retrying it", async () => {
    const fetchImpl = vi.fn(async () => gifResponse(GIF_BYTES, { status: 404 }));
    const view = await mount(fetchImpl as unknown as typeof fetch);
    const textarea = typeIntoComposer(view, KLIPY);
    await settle();

    expect(textarea.value).toBe(KLIPY);
    expect(view.element.querySelector(".wx-chat-composer-error")?.textContent).toBe(
      "Couldn't download that GIF. The link was left in your message instead.",
    );
    expect(uploadServerAttachment).not.toHaveBeenCalled();

    typeIntoComposer(view, `${KLIPY} ok`);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    view.teardown();
  });

  it("waits for an open keyboard composition to end before taking the link", async () => {
    const fetchImpl = vi.fn(async () => gifResponse());
    uploadServerAttachment.mockResolvedValue(uploaded("gif-attachment"));
    const view = await mount(fetchImpl as unknown as typeof fetch);
    const textarea = view.element.querySelector<HTMLTextAreaElement>(".wx-chat-composer-input")!;
    textarea.value = KLIPY;
    const composing = new Event("input");
    Object.defineProperty(composing, "isComposing", { value: true });
    textarea.dispatchEvent(composing);
    expect(textarea.value).toBe(KLIPY);
    expect(fetchImpl).not.toHaveBeenCalled();

    textarea.dispatchEvent(new Event("compositionend"));
    expect(textarea.value).toBe("");
    await settle();
    expect(uploadServerAttachment).toHaveBeenCalledTimes(1);
    view.teardown();
  });

  it("leaves ordinary links alone", async () => {
    const fetchImpl = vi.fn(async () => gifResponse());
    const view = await mount(fetchImpl as unknown as typeof fetch);
    const textarea = typeIntoComposer(view, "see https://example.com/page");
    expect(textarea.value).toBe("see https://example.com/page");
    expect(fetchImpl).not.toHaveBeenCalled();
    view.teardown();
  });

  it("the ✕ on a GIF still downloading cancels it", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const view = await mount(fetchImpl as unknown as typeof fetch);
    typeIntoComposer(view, KLIPY);
    view.element.querySelector<HTMLButtonElement>(".wx-chat-attachment-chip-pending .wx-chat-attachment-remove")!.click();
    expect(signal?.aborted).toBe(true);
    expect(view.element.querySelector(".wx-chat-attachment-chip-pending")).toBeNull();
    expect(view.element.querySelector<HTMLElement>(".wx-chat-attachment-row")!.hidden).toBe(true);
    view.teardown();
  });

  it("the More menu's Fry item attaches the bundled Fry GIF", async () => {
    const fetchImpl = vi.fn(async () => gifResponse());
    uploadServerAttachment.mockResolvedValue(uploaded("fry-attachment"));
    const view = await mount(fetchImpl as unknown as typeof fetch);

    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    const fry = view.element.querySelector<HTMLButtonElement>(".wx-srv-more-fry")!;
    expect(fry.querySelector(".wx-srv-more-item-title")?.textContent).toBe("Fry");
    expect(fry.querySelector(".wx-srv-more-item-hint")?.textContent).toBe("Hmmmmmm");
    fry.click();
    expect(view.element.querySelector<HTMLElement>(".wx-srv-more-menu")!.hidden).toBe(true);
    await settle();

    expect(fetchImpl).toHaveBeenCalledWith(FRY_GIF_URL, expect.objectContaining({ credentials: "same-origin" }));
    const [file, kind] = uploadServerAttachment.mock.calls[0] as [File, string];
    expect(file.name).toBe("fry-squint.gif");
    expect(file.type).toBe("image/gif");
    expect(kind).toBe("photo");
    view.teardown();
  });

  it("says so when the Fry GIF cannot be loaded", async () => {
    const fetchImpl = vi.fn(async () => gifResponse(GIF_BYTES, { status: 500 }));
    const view = await mount(fetchImpl as unknown as typeof fetch);
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-button")!.click();
    view.element.querySelector<HTMLButtonElement>(".wx-srv-more-fry")!.click();
    await settle();
    expect(view.element.querySelector(".wx-chat-composer-error")?.textContent).toBe("Couldn't attach the Fry GIF. Try again.");
    expect(uploadServerAttachment).not.toHaveBeenCalled();
    view.teardown();
  });
});
