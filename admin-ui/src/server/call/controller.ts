import type { LockHooks, ServerSession } from "../types";
import { CallAudio } from "./audio";
import { CALL_PROTOCOL, decodeFrame, encodeFrame, LEASE_MS } from "./protocol";

export interface CallAudioHandle {
  prepare(): Promise<void>;
  start(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  lease(): number;
  play(pcm: ArrayBuffer, sequence: number, until: number): void;
}
export interface CallDeps {
  win: Window;
  hooks: Pick<LockHooks, "suspend" | "lockNow">;
  isMicBusy: () => boolean;
  onBusy: (busy: boolean) => void;
  socketFactory?: (url: string, protocol: string) => WebSocket;
  audioFactory?: (capture: (pcm: ArrayBuffer) => void, admitted: (sequence: number) => void,
    failed: () => void) => CallAudioHandle;
}

/** One attachment's presence and one explicit call attempt; never auto-resumes audio. */
export function createCallController(deps: CallDeps) {
  const { win, hooks } = deps;
  const element = win.document.createElement("div");
  element.className = "wx-srv-call";
  element.hidden = true;
  const status = win.document.createElement("span");
  status.setAttribute("role", "status");
  const targets = win.document.createElement("select");
  targets.setAttribute("aria-label", "Person to call");
  targets.dataset["srvGestureBoundary"] = "";
  const callButton = button("Call", () => {
    if (!socket || socket.readyState !== 1) { if (session) open(session, label); return; }
    if (!targets.value || deps.isMicBusy() || callId) return;
    if (!activateAudio()) return;
    deps.onBusy(true);
    pendingInvite = true;
    if (!send({ type: "invite", requestId: crypto.randomUUID(), targetConnectionId: targets.value })) {
      end("Calls unavailable");
      return;
    }
    callButton.disabled = true;
  });
  const acceptButton = button("Answer", () => {
    if (!callId || state !== "incoming" || deps.isMicBusy()) return;
    if (!activateAudio()) return;
    deps.onBusy(true);
    send({ type: "accept", callId });
    acceptButton.disabled = true;
  });
  const endButton = button("End call", () => { end("Call ended"); });
  const muteButton = button("Mute", () => {
    if (state !== "connected" || !callId) return;
    muted = !muted;
    audio?.setMuted(muted);
    send({ type: "mute", callId, muted });
    muteButton.textContent = muted ? "Unmute" : "Mute";
    muteButton.setAttribute("aria-pressed", String(muted));
  });
  element.append(status, targets, callButton, acceptButton, muteButton, endButton);

  let session: ServerSession | null = null;
  let label = "Device";
  let socket: WebSocket | null = null;
  let socketEpoch = 0;
  let callEpoch = 0;
  let callId: string | null = null;
  let state = "idle";
  let audio: CallAudioHandle | null = null;
  let releaseCall: (() => void) | null = null;
  let releasePermission: (() => void) | null = null;
  let timer: number | null = null;
  let lastPulse = win.performance.now();
  let lastMessage = lastPulse;
  let sequence = 0;
  let captureLease = 0;
  let captureLeaseAt = 0;
  let playoutId = 0;
  let leases = new Map<number, { at: number; until: number }>();
  let muted = false;
  let backlogAt: number | null = null;
  let deadline = 0;
  let pendingInvite = false;
  let callUntil = 0;

  function button(text: string, action: () => void): HTMLButtonElement {
    const result = win.document.createElement("button");
    result.type = "button";
    result.textContent = text;
    result.addEventListener("click", action);
    return result;
  }
  function render(): void {
    const inCall = callId !== null;
    targets.hidden = inCall;
    callButton.hidden = inCall;
    callButton.disabled = pendingInvite || (socket?.readyState === 1 && targets.options.length === 0);
    acceptButton.hidden = state !== "incoming";
    acceptButton.disabled = deps.isMicBusy();
    muteButton.hidden = state !== "connected";
    endButton.hidden = !inCall;
    endButton.textContent = state === "incoming" ? "Decline" : state === "outgoing" ? "Cancel call" : "End call";
  }
  function send(message: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 8192) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function teardownCall(message: string): void {
    callEpoch++;
    audio?.stop();
    audio = null;
    releasePermission?.();
    releasePermission = null;
    releaseCall?.();
    releaseCall = null;
    callId = null;
    pendingInvite = false;
    callUntil = 0;
    state = "idle";
    muted = false;
    captureLease = 0;
    sequence = 0;
    playoutId = 0;
    leases.clear();
    deps.onBusy(false);
    status.textContent = message;
    muteButton.textContent = "Mute";
    render();
  }
  function end(message: string): void {
    const endedId = callId;
    const wasPending = pendingInvite;
    const action = state === "incoming" ? "decline" : "end";
    teardownCall(message); // Stop locally before best-effort network activity.
    if (endedId) send({ type: action, callId: endedId });
    else if (wasPending) disconnect();
  }
  function activateAudio(): boolean {
    if (deps.isMicBusy()) return false;
    const attemptEpoch = ++callEpoch;
    try {
      audio = (deps.audioFactory ?? ((capture, ack, fail) => new CallAudio(capture, ack, fail)))(
        (pcm) => {
          if (attemptEpoch !== callEpoch) return;
          if (state !== "connected" || !callId || muted || !socket || socket.readyState !== 1) return;
          const now = win.performance.now();
          if (now - lastPulse > LEASE_MS) { end("Call interrupted"); return; }
          if (!captureLease || now - captureLeaseAt > LEASE_MS) return;
          if (socket.bufferedAmount > 8192) {
            backlogAt ??= now;
            if (now - backlogAt > 250) end("Connection too slow");
            return;
          }
          backlogAt = null;
          socket.send(encodeFrame(callId, sequence++, captureLease, pcm));
        },
        (seq) => { if (attemptEpoch === callEpoch && state === "connected" && callId) send({ type: "ack", callId, sequence: seq }); },
        () => { if (attemptEpoch === callEpoch) end("Audio unavailable"); },
      );
      return true;
    } catch { teardownCall("Calls unavailable in this browser"); return false; }
  }
  function pulse(): void {
    if (state === "incoming") acceptButton.disabled = deps.isMicBusy();
    const now = win.performance.now();
    const stale = now - lastPulse > LEASE_MS;
    lastPulse = now;
    if (callUntil && now >= callUntil) { end("Call timed out"); return; }
    if (now - lastMessage > 6000 || Date.now() / 1000 >= deadline) {
      disconnect();
      status.textContent = "Calls disconnected. Reconnect to try again.";
      return;
    }
    if (state === "connected" && callId && audio) {
      if (stale) { end("Call interrupted"); return; }
      const id = ++playoutId;
      leases.set(id, { at: now + LEASE_MS, until: audio.lease() });
      for (const [key, lease] of leases) if (lease.at <= now) leases.delete(key);
      if (leases.size > 4) leases.delete(leases.keys().next().value as number);
      send({ type: "lease", callId, lease: id });
    }
  }
  async function prepare(id: string): Promise<void> {
    if (id !== callId || !audio || deps.isMicBusy()) { end("Audio unavailable"); return; }
    const epoch = callEpoch;
    const attempt = audio;
    state = "preparing";
    callUntil = win.performance.now() + 20_000;
    status.textContent = "Connecting audio…";
    deps.onBusy(true);
    for (const media of element.parentElement?.querySelectorAll<HTMLMediaElement>("audio,video") ?? []) media.pause();
    releasePermission = hooks.suspend("micPermission");
    render();
    try {
      await attempt.prepare();
      if (epoch !== callEpoch || attempt !== audio || callId !== id) return;
      releasePermission?.();
      releasePermission = null;
      send({ type: "ready", callId: id });
    } catch {
      if (epoch === callEpoch && attempt === audio) end("Microphone unavailable. Check browser permissions.");
    }
  }
  function receive(data: unknown): void {
    lastMessage = win.performance.now();
    if (data instanceof ArrayBuffer) {
      if (state !== "connected" || !callId || !audio) return;
      const frame = decodeFrame(data);
      const lease = leases.get(frame.lease);
      if (frame.callId === callId && lease && lease.at > win.performance.now()) {
        audio.play(frame.pcm, frame.sequence, lease.until);
      }
      return;
    }
    if (typeof data !== "string" || data.length > 4096) throw new Error("Invalid call message");
    const m: Record<string, unknown> = JSON.parse(data) as Record<string, unknown>;
    if (m["type"] === "ping") { send({ type: "pong" }); return; }
    if (m["type"] === "welcome") {
      if (typeof m["deadline"] !== "number") throw new Error("Invalid deadline");
      deadline = Math.min(m["deadline"], session?.expiresAt ?? 0);
      status.textContent = "Voice calls";
      callButton.textContent = "Call";
    } else if (m["type"] === "presence" && Array.isArray(m["peers"])) {
      const selected = targets.value;
      targets.replaceChildren();
      for (const candidate of m["peers"].slice(0, 8) as Record<string, unknown>[]) {
        if (candidate["available"] !== true || typeof candidate["id"] !== "string" || typeof candidate["label"] !== "string") continue;
        const option = win.document.createElement("option");
        option.value = candidate["id"];
        option.textContent = `${candidate["label"].slice(0, 32)} · ${option.value.slice(0, 4)}`;
        targets.appendChild(option);
      }
      if (Array.from(targets.options).some((o) => o.value === selected)) targets.value = selected;
    } else if (m["type"] === "incoming" || m["type"] === "outgoing") {
      if (callId || typeof m["callId"] !== "string") throw new Error("Invalid invite");
      callId = m["callId"];
      pendingInvite = false;
      state = m["type"];
      callUntil = win.performance.now() + 30_000;
      status.textContent = state === "incoming" ? `Incoming call from ${String(m["peer"]).slice(0, 32)}` : "Calling…";
    } else if (m["type"] === "unavailable") {
      teardownCall("That person is unavailable");
    } else if (m["callId"] !== callId || !callId) {
      return; // Late terminal/readiness messages cannot revive a canceled attempt.
    } else if (m["type"] === "prepare" && (state === "outgoing" || state === "incoming")) {
      void prepare(callId);
    } else if (m["type"] === "connected" && state === "preparing" && audio) {
      state = "connected";
      callUntil = win.performance.now() + 7_200_000;
      audio.start();
      releaseCall = hooks.suspend("voiceCall");
      status.textContent = "On a voice call";
      pulse();
    } else if (m["type"] === "capture" && typeof m["lease"] === "number") {
      captureLease = m["lease"];
      captureLeaseAt = win.performance.now();
    } else if (m["type"] === "ended") {
      teardownCall("Call ended");
    }
    render();
  }
  function disconnect(): void {
    socketEpoch++;
    teardownCall("");
    const old = socket;
    socket = null;
    if (timer !== null) win.clearInterval(timer);
    timer = null;
    if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; old.close(1000); }
  }
  function open(next: ServerSession, name: string): void {
    disconnect();
    session = next;
    label = name;
    const epoch = socketEpoch;
    const url = new URL("/api/admin/server/calls/ws", win.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try { socket = (deps.socketFactory ?? ((u, p) => new WebSocket(u, p)))(url.href, CALL_PROTOCOL); }
    catch { status.textContent = "Calls unavailable"; return; }
    socket.binaryType = "arraybuffer";
    deadline = next.expiresAt;
    lastMessage = lastPulse = win.performance.now();
    status.textContent = "Connecting calls…";
    socket.onopen = () => {
      if (epoch !== socketEpoch) return;
      send({ type: "auth", v: 1, token: next.token, label: name.slice(0, 32) || "Device" });
    };
    socket.onmessage = (event) => {
      if (epoch !== socketEpoch) return;
      try {
        if (state === "connected" && win.performance.now() - lastPulse > LEASE_MS) end("Call interrupted");
        receive(event.data);
      } catch { disconnect(); status.textContent = "Calls disconnected"; }
    };
    socket.onclose = (event) => {
      if (epoch !== socketEpoch) return;
      disconnect();
      status.textContent = "Calls disconnected. Reconnect to try again.";
      callButton.textContent = "Reconnect calls";
      if (event.code === 4401) hooks.lockNow("unauthorized");
    };
    socket.onerror = () => { if (epoch === socketEpoch) { disconnect(); status.textContent = "Calls unavailable"; } };
    timer = win.setInterval(pulse, 100);
    render();
  }
  function pagehide(): void { detach(); }
  win.addEventListener("pagehide", pagehide);
  function detach(): void { disconnect(); session = null; element.hidden = true; }
  return {
    element,
    attach(next: ServerSession, name: string): void {
      element.hidden = false;
      if (session?.token === next.token && socket) return;
      open(next, name);
    },
    detach,
    dispose(): void { detach(); win.removeEventListener("pagehide", pagehide); },
  };
}
