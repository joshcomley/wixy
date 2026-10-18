/** One attempt's technical trace, in memory only: no content, identity or connection IDs. */
const STEPS = [
  "confirm", "answer", "outgoing", "incoming", "preparing", "ready", "connected", "remote-ended",
  "context-created", "activation-ready", "loading-worklet", "requesting-microphone", "microphone-ready",
  "resuming-capture", "graph-ready", "setup-failed", "context-state", "render-stalled", "stopped",
  "audio-failed", "socket-closed", "socket-error", "setup-timeout", "main-thread-stalled",
  "connection-slow", "connection-timeout", "protocol-error",
] as const;
export type CallDiagnosticStep = typeof STEPS[number];
export interface AudioDiagnostic {
  step: CallDiagnosticStep;
  state?: string;
  error?: unknown;
  code?: number;
  sampleRate?: number;
}
const STATES = ["running", "suspended", "interrupted", "closed"];
const ERRORS = ["NotAllowedError", "NotFoundError", "NotReadableError", "AbortError", "InvalidStateError",
  "NotSupportedError", "SecurityError", "TypeError"];

export function safeAudioError(error: unknown): string {
  try {
    const name = error instanceof Error || error instanceof DOMException ? error.name : "Error";
    return ERRORS.includes(name) ? name : "Error";
  } catch { return "Error"; }
}

export function createCallDiagnostics(win: Window) {
  let started = win.performance.now();
  let events: { ms: number; step: CallDiagnosticStep; state?: string; error?: string; code?: number; sampleRate?: number }[] = [];
  let printed = false;
  return {
    reset(): void { started = win.performance.now(); events = []; printed = false; },
    record(event: AudioDiagnostic): void {
      if (!STEPS.includes(event.step)) return;
      const entry: typeof events[number] = { ms: Math.max(0, Math.round(win.performance.now() - started)), step: event.step };
      if (event.state !== undefined) entry.state = STATES.includes(event.state) ? event.state : "unknown";
      if (event.error !== undefined) entry.error = safeAudioError(event.error);
      if (Number.isInteger(event.code) && event.code !== undefined && event.code >= 0 && event.code <= 4999) entry.code = event.code;
      if (event.sampleRate !== undefined && Number.isFinite(event.sampleRate) && event.sampleRate > 0 && event.sampleRate <= 384000) {
        entry.sampleRate = event.sampleRate;
      }
      events.push(entry);
      if (events.length > 32) events.shift();
    },
    text(): string {
      // Extract only browser/OS version numbers, never the full UA or the page URL.
      const ua = win.navigator?.userAgent ?? "";
      const browser = /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "desktop";
      const version = ua.match(/(?:Version|Chrome)\/([\d.]{1,20})/)?.[1] ?? "unknown";
      const ios = ua.match(/OS ([\d_]{1,20})/)?.[1] ?? null;
      return JSON.stringify({ diagnostic: "call-setup-v1", browser, version, ios, events }, null, 2);
    },
    printOnce(): void {
      if (printed) return;
      printed = true;
      try { console.info("Wixy call diagnostics", this.text()); } catch { /* Diagnostics never own call teardown. */ }
    },
  };
}
