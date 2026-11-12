import { describe, expect, it } from "vitest";
import { encodeFrame } from "../../src/server/call/protocol";
import {
  decodeLiveFrame,
  encodeLiveFrame,
  normalizeId,
  parseServerMessage,
} from "../../src/server/liveVoice/protocol";

const ID = "0123456789abcdef0123456789abcdef";
const pcm = () => new Uint8Array(960).fill(7).buffer;

describe("live-voice server messages (spec/server-chat/07 §6.2)", () => {
  it("parses ready and ping", () => {
    expect(parseServerMessage('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseServerMessage('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("parses a state message with its peaks", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "state", attachmentId: ID, state: "paused", durationMs: 4200, peaksFrom: 2, peaks: [0, 128, 255],
    }))).toEqual({ type: "state", attachmentId: ID, state: "paused", durationMs: 4200, peaksFrom: 2, peaks: [0, 128, 255] });
  });

  it("parses eof and errors (with or without an attachment)", () => {
    expect(parseServerMessage(JSON.stringify({ type: "eof", attachmentId: ID, sampleIndex: 4800 })))
      .toEqual({ type: "eof", attachmentId: ID, sampleIndex: 4800 });
    expect(parseServerMessage(JSON.stringify({ type: "error", attachmentId: ID, code: "too_many_listeners" })))
      .toEqual({ type: "error", attachmentId: ID, code: "too_many_listeners" });
    expect(parseServerMessage(JSON.stringify({ type: "error", code: "bad_request" })))
      .toEqual({ type: "error", attachmentId: null, code: "bad_request" });
  });

  it.each([
    "not json",
    "[]",
    '{"type":"nope"}',
    '{"type":"state","attachmentId":"a","state":"weird","durationMs":1,"peaksFrom":0,"peaks":[]}',
    '{"type":"state","attachmentId":"a","state":"recording","durationMs":-1,"peaksFrom":0,"peaks":[]}',
    '{"type":"state","attachmentId":"a","state":"recording","durationMs":1,"peaksFrom":0,"peaks":[256]}',
    '{"type":"state","attachmentId":"a","state":"recording","durationMs":1,"peaksFrom":0,"peaks":["x"]}',
    '{"type":"state","attachmentId":"a","state":"recording","durationMs":1,"peaksFrom":0.5,"peaks":[]}',
    '{"type":"eof","attachmentId":"a"}',
    '{"type":"error","code":"mystery"}',
  ])("never trusts the malformed message %s", (text) => {
    expect(parseServerMessage(text)).toBeNull();
  });

  it("refuses an oversized text frame", () => {
    expect(parseServerMessage(`{"type":"ping","pad":"${"x".repeat(300_000)}"}`)).toBeNull();
  });
});

describe("live-voice audio frames (byte 1 = 2)", () => {
  it("round-trips the attachment id, sequence, sample index and 480 samples", () => {
    const frame = decodeLiveFrame(encodeLiveFrame(ID, 3, 480 * 7, pcm()));
    expect(frame.attachmentId).toBe(ID);
    expect(frame.sequence).toBe(3);
    expect(frame.sampleIndex).toBe(3360);
    expect(frame.pcm.byteLength).toBe(960);
    expect(new Uint8Array(frame.pcm)[0]).toBe(7);
  });

  it("is the call's 1008-byte header with byte 1 = 2", () => {
    const packet = encodeLiveFrame(ID, 0, 0, pcm());
    const view = new DataView(packet);
    expect(packet.byteLength).toBe(1008);
    expect(view.getUint8(0)).toBe(1);
    expect(view.getUint8(1)).toBe(2);
    expect(view.getUint16(2)).toBe(0);
    expect(view.getUint32(32)).toBe(0);
    expect(view.getUint32(36)).toBe(0);
    expect(view.getBigUint64(40)).toBe(0n);
  });

  it("rejects a call frame (byte 1 = 1), a wrong size and a sample index that is not a frame boundary", () => {
    expect(() => decodeLiveFrame(encodeFrame(ID, 0, 1, pcm()))).toThrow();
    expect(() => decodeLiveFrame(new ArrayBuffer(100))).toThrow();
    const odd = encodeLiveFrame(ID, 0, 0, pcm());
    new DataView(odd).setBigUint64(24, 5n);
    expect(() => decodeLiveFrame(odd)).toThrow();
    const stray = encodeLiveFrame(ID, 0, 0, pcm());
    new DataView(stray).setUint32(36, 9);
    expect(() => decodeLiveFrame(stray)).toThrow();
  });

  it("normalises ids", () => {
    expect(normalizeId("01234567-89AB-cdef-0123-456789abcdef")).toBe(ID);
  });
});
