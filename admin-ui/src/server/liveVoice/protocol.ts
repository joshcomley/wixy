/**
 * Wire format of the live-voice listener socket (spec/server-chat/07-live-voice-notes.md §6.2).
 *
 * Text frames are strict JSON; the one binary frame is the call's 1008-byte audio frame
 * (`call/protocol.ts`) with byte 1 = 2. Parsing is defensive: a malformed or unknown message is
 * never trusted and never throws past `parseServerMessage`'s caller, which simply drops it.
 */

export const LIVE_VOICE_PROTOCOL = "wixy-live-voice-v1";
export const LIVE_VOICE_PATH = "/api/admin/server/live-voice/ws";

export const FRAME_SAMPLES = 480;
export const FRAME_BYTES = 1008;
export const SAMPLE_RATE = 24_000;
/** One frame is 20 ms of audio. */
export const FRAME_MS = 20;

/** Credit granted straight after `play`. */
export const INITIAL_CREDIT = 50;
/** Largest `frames` the server accepts in one `credit` message. */
export const MAX_CREDIT_PER_MESSAGE = 500;
/** Audio the client holds (decoded and queued, or granted and in flight) at most: 2 s. */
export const MAX_BUFFER_FRAMES = 100;
/** A top-up is only sent once at most this many frames of credit remain outstanding... */
export const TOPUP_BELOW_FRAMES = 25;
/** ...and only if at least this much can be granted, so credit messages stay few. */
export const MIN_GRANT_FRAMES = 10;

/** Longest text frame accepted: a four-hour note's peaks are 14 400 small integers (~60 KB). */
export const MAX_TEXT_BYTES = 256 * 1024;

export type PlayFrom = "start" | "live" | number;
export type LiveStreamState = "recording" | "paused" | "ended";
export type LiveVoiceErrorCode = "not_found" | "forbidden" | "not_live" | "too_many_listeners" | "bad_request";

export type ServerMessage =
  | { readonly type: "ready" }
  | { readonly type: "ping" }
  | {
      readonly type: "state";
      readonly attachmentId: string;
      readonly state: LiveStreamState;
      readonly durationMs: number;
      readonly peaksFrom: number;
      readonly peaks: readonly number[];
    }
  | { readonly type: "eof"; readonly attachmentId: string; readonly sampleIndex: number }
  | { readonly type: "error"; readonly attachmentId: string | null; readonly code: LiveVoiceErrorCode };

export interface LiveFrame {
  /** Lower-case hex, 32 characters. */
  readonly attachmentId: string;
  /** Per-`play` sequence, from 0. */
  readonly sequence: number;
  /** Absolute sample index within the note (a multiple of 480). */
  readonly sampleIndex: number;
  readonly pcm: ArrayBuffer;
}

/** Ids are compared as 32 lower-case hex characters, whatever punctuation they arrive with. */
export function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

const ERROR_CODES: readonly string[] = ["not_found", "forbidden", "not_live", "too_many_listeners", "bad_request"];
const STATES: readonly string[] = ["recording", "paused", "ended"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Returns the message, or `null` for anything that is not a well-formed message of a known type. */
export function parseServerMessage(text: string): ServerMessage | null {
  if (text.length > MAX_TEXT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw["type"] !== "string") return null;
  switch (raw["type"]) {
    case "ready":
      return { type: "ready" };
    case "ping":
      return { type: "ping" };
    case "state": {
      const id = raw["attachmentId"];
      const state = raw["state"];
      const peaks = raw["peaks"];
      if (typeof id !== "string" || id === "" || typeof state !== "string" || !STATES.includes(state)) return null;
      if (!isCount(raw["durationMs"]) || !isCount(raw["peaksFrom"]) || !Array.isArray(peaks)) return null;
      const clean: number[] = [];
      for (const value of peaks as unknown[]) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255) return null;
        clean.push(Math.round(value));
      }
      return {
        type: "state",
        attachmentId: id,
        state: state as LiveStreamState,
        durationMs: raw["durationMs"],
        peaksFrom: raw["peaksFrom"],
        peaks: clean,
      };
    }
    case "eof": {
      const id = raw["attachmentId"];
      if (typeof id !== "string" || id === "" || !isCount(raw["sampleIndex"])) return null;
      return { type: "eof", attachmentId: id, sampleIndex: raw["sampleIndex"] };
    }
    case "error": {
      const code = raw["code"];
      const id = raw["attachmentId"];
      if (typeof code !== "string" || !ERROR_CODES.includes(code)) return null;
      if (id !== undefined && typeof id !== "string") return null;
      return { type: "error", attachmentId: id ?? null, code: code as LiveVoiceErrorCode };
    }
    default:
      return null;
  }
}

/** Decode the call's frame as live voice (byte 1 = 2). Throws on anything else. */
export function decodeLiveFrame(packet: ArrayBuffer): LiveFrame {
  if (packet.byteLength !== FRAME_BYTES) throw new Error("Invalid audio size");
  const view = new DataView(packet);
  if (view.getUint8(0) !== 1 || view.getUint8(1) !== 2 || view.getUint16(2) !== 0
    || view.getUint32(32) !== 0 || view.getUint32(36) !== 0 || view.getBigUint64(40) !== 0n) {
    throw new Error("Invalid audio header");
  }
  const sample = view.getBigUint64(24);
  if (sample > BigInt(Number.MAX_SAFE_INTEGER) || sample % BigInt(FRAME_SAMPLES) !== 0n) {
    throw new Error("Invalid audio position");
  }
  const attachmentId = Array.from(new Uint8Array(packet, 4, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return { attachmentId, sequence: view.getUint32(20), sampleIndex: Number(sample), pcm: packet.slice(48) };
}

/** Test helper and reference encoder for the server's frame (the client never sends audio). */
export function encodeLiveFrame(attachmentId: string, sequence: number, sampleIndex: number, pcm: ArrayBuffer): ArrayBuffer {
  const id = normalizeId(attachmentId);
  if (!/^[a-f0-9]{32}$/.test(id) || pcm.byteLength !== 960) throw new Error("Invalid audio frame");
  const packet = new ArrayBuffer(FRAME_BYTES);
  const view = new DataView(packet);
  view.setUint8(0, 1);
  view.setUint8(1, 2);
  for (let i = 0; i < 16; i++) view.setUint8(4 + i, parseInt(id.slice(i * 2, i * 2 + 2), 16));
  view.setUint32(20, sequence);
  view.setBigUint64(24, BigInt(sampleIndex));
  new Uint8Array(packet, 48).set(new Uint8Array(pcm));
  return packet;
}
