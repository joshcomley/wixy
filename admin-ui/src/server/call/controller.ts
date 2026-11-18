import type { LiveSuspension, LockHooks, ServerSession } from "../types";
import { CallAudio } from "./audio";
import { type AudioDiagnostic, createCallDiagnostics, safeAudioError } from "./diagnostics";
import { CALL_PROTOCOL, decodeFrame, encodeFrame, LEASE_MS } from "./protocol";

export interface CallAudioHandle {
  prepare(): Promise<void>;
  start(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  pulse(): void;
  captureLease(lease: number): void;
  play(pcm: ArrayBuffer, sequence: number, until: number): void;
}
export interface CallDeps {
  win: Window;
  hooks: Pick<LockHooks, "suspendLive" | "activityCount" | "lockNow">;
  isMicBusy: () => boolean;
  onBusy: (busy: boolean) => void;
  /** The call controls need the screen: a call is ringing, being set up, connected, or has a failure notice
   * to read. The thread keeps its header (where these controls live) visible in a game tab while true. */
  onLive?: (live: boolean) => void;
  socketFactory?: (url: string, protocol: string) => WebSocket;
  audioFactory?: (capture: (pcm: ArrayBuffer, lease: number) => void, admitted: (sequence: number) => void,
    failed: () => void, leaseReady: (until: number, remainingMs: number) => void,
    diagnostic: (event: AudioDiagnostic) => void) => CallAudioHandle;
}

const MAX_HELD_UNANSWERED_RINGS = 2;

/** Each controller's Call-button reason element gets its own id (aria-describedby). */
let reasonIds = 0;

/** One attachment's presence and one explicit call attempt; never auto-resumes audio. */
export function createCallController(deps: CallDeps) {
  const { win, hooks } = deps;
  const element = win.document.createElement("div");
  element.className = "wx-srv-call";
  element.hidden = true;
  const status = win.document.createElement("span");
  status.className = "wx-srv-call-status";
  status.setAttribute("role", "status");
  const diagnostics = createCallDiagnostics(win);
  const notice = win.document.createElement("div");
  notice.className = "wx-srv-call-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const noticeText = win.document.createElement("p");
  const copyDetails = win.document.createElement("button");
  copyDetails.type = "button";
  copyDetails.textContent = "Copy call details";
  const details = win.document.createElement("pre");
  details.hidden = true;
  let noticeEpoch = 0;
  copyDetails.addEventListener("click", () => {
    const text = diagnostics.text();
    const epoch = noticeEpoch;
    void (async () => {
      try {
        if (!win.navigator.clipboard) throw new Error("clipboard unavailable");
        await win.navigator.clipboard.writeText(text);
        if (epoch === noticeEpoch) copyDetails.textContent = "Copied";
      } catch { if (epoch === noticeEpoch) { details.textContent = text; details.hidden = false; } }
    })();
  });
  const dismissDetails = win.document.createElement("button");
  dismissDetails.type = "button";
  dismissDetails.textContent = "Dismiss call details";
  dismissDetails.addEventListener("click", clearFailure);
  notice.append(noticeText, copyDetails, dismissDetails, details);
  const callButton = button("Call", () => {
    if (!socket || socket.readyState !== 1) { if (session) open(session, label); return; }
    if (deps.isMicBusy() || callId || outgoingRequest !== null) return;
    dialog.hidden = false;
    renderChoices();
    render();
    choices.querySelector<HTMLInputElement>("input:checked")?.focus();
  });
  const dialog = win.document.createElement("div");
  callButton.dataset["srvGestureBoundary"] = "";
  dialog.className = "wx-srv-call-dialog";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Start a call");
  dialog.dataset["srvGestureBoundary"] = "";
  const heading = win.document.createElement("strong");
  heading.textContent = "Call this device?";
  const choices = win.document.createElement("div");
  choices.className = "wx-srv-call-choices";
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", "Person to call");
  const cancel = win.document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeDialog);
  const confirm = win.document.createElement("button");
  confirm.type = "button";
  confirm.className = "wx-srv-call-confirm";
  confirm.textContent = "Call";
  confirm.setAttribute("aria-label", "Confirm call");
  confirm.addEventListener("click", () => {
    if (dialog.hidden || !socket || socket.readyState !== 1 || !availablePeers.some((peer) => peer.id === selectedTarget)
      || deps.isMicBusy() || callId || outgoingRequest !== null) return;
    diagnostics.reset();
    diagnostics.record({ step: "confirm" });
    clearFailure();
    dialog.hidden = true;
    if (!activateAudio()) return;
    deps.onBusy(true);
    holdCall(); // Pause the idle countdown from the moment the invite goes out (Inv 55).
    outgoingRequest = crypto.randomUUID();
    if (!send({ type: "invite", requestId: outgoingRequest, targetConnectionId: selectedTarget })) {
      end("The call couldn't be sent. Please try again.", true);
      return;
    }
    render();
  });
  const actions = win.document.createElement("div");
  actions.className = "wx-srv-call-dialog-actions";
  actions.append(cancel, confirm);
  dialog.append(heading, choices, actions);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDialog();
  });
  const acceptButton = button("Answer", () => {
    if (!callId || state !== "incoming" || answerPending || deps.isMicBusy()) return;
    diagnostics.reset();
    diagnostics.record({ step: "answer" });
    clearFailure();
    if (!activateAudio()) return;
    holdCall(); // Answering is user activity: pause idle from here even if the ring itself was not held.
    answerPending = true;
    deps.onBusy(true);
    if (!send({ type: "accept", callId })) { end("The call couldn't be answered. Please try again.", true); return; }
    acceptButton.disabled = true;
  });
  const endButton = button("End call", () => { end("Call ended"); });
  const muteButton = button("Mute", () => {
    if (state !== "connected" || !callId) return;
    muted = !muted;
    audio?.setMuted(muted);
    send({ type: "mute", callId, muted });
    labelButton(muteButton, muted ? "Unmute" : "Mute", muted ? "mic-off" : "mic");
    muteButton.setAttribute("aria-pressed", String(muted));
  });
  // Why Call is disabled, when it is: the button's description for a screen reader, and its title.
  const callReason = win.document.createElement("span");
  callReason.className = "wx-srv-call-reason";
  callReason.id = `wx-srv-call-reason-${++reasonIds}`;
  element.append(status, callButton, callReason, acceptButton, muteButton, endButton, dialog, notice);

  let session: ServerSession | null = null;
  let label = "Device";
  let socket: WebSocket | null = null;
  let socketEpoch = 0;
  let callEpoch = 0;
  let callId: string | null = null;
  let state = "idle";
  let audio: CallAudioHandle | null = null;
  let releaseCall: LiveSuspension | null = null;
  let releasePermission: LiveSuspension | null = null;
  // Consecutive incoming rings that ended unanswered with no activity on this device in between.
  let unansweredRings = 0;
  let unansweredAt = 0;
  let timer: number | null = null;
  let lastPulse = win.performance.now();
  let lastMessage = lastPulse;
  let sequence = 0;
  let playoutId = 0;
  let leases = new Map<number, { at: number; until: number }>();
  let muted = false;
  let backlogAt: number | null = null;
  let deadline = 0;
  // The one unanswered invite this tab sent; busy replies are matched to it.
  let outgoingRequest: string | null = null;
  let answerPending = false;
  let selectedTarget: string | null = null;
  let availablePeers: { id: string; label: string }[] = [];
  let callUntil = 0;

  /** The one `voiceCall` idle pause for this call attempt: taken when an invite is sent or an incoming
   * call is shown, kept through ringing, connecting and connected, released only by `teardownCall`
   * (every end, failure, socket loss, detach). The server bounds the attempt (30 s ring, 20 s setup). */
  function holdCall(): void { releaseCall ??= hooks.suspendLive("voiceCall"); }
  /** A ring nobody answered (ended by the caller, the server or the ring timeout): remembered so a
   * peer re-inviting in a loop cannot keep the idle pause alive on an unattended device. */
  function noteUnansweredRing(): void {
    if (state !== "incoming") return;
    unansweredRings++;
    unansweredAt = hooks.activityCount();
  }
  function clearFailure(): void {
    noticeEpoch++;
    noticeText.textContent = "";
    notice.hidden = true;
    details.hidden = true;
    details.textContent = "";
    copyDetails.textContent = "Copy call details";
  }
  function showFailure(message: string): void {
    noticeText.textContent = message;
    notice.hidden = false;
    diagnostics.printOnce();
  }
  function remoteEnd(reason: unknown): void {
    const wasConnected = state === "connected";
    diagnostics.record({ step: "remote-ended" });
    noteUnansweredRing();
    teardownCall("Call ended");
    if (reason === "audio_unavailable") showFailure(wasConnected
      ? "The other device couldn't continue the call. Please try again."
      : "The other device couldn't connect the call. Please try again, or ask it to check its call details.");
    else if (reason === "timeout") showFailure("Call setup timed out. Please try again.");
    else if (reason === "connection_slow") showFailure("The connection couldn't keep up, so the call stopped.");
    else if (reason === "disconnected" || reason === "unavailable") showFailure("The other device disconnected from the call.");
  }

  function closeDialog(): void {
    dialog.hidden = true;
    render();
    if (!element.hidden) callButton.focus();
  }
  function renderChoices(): void {
    choices.replaceChildren();
    for (const peer of availablePeers) {
      const row = win.document.createElement("label");
      const radio = win.document.createElement("input");
      radio.type = "radio";
      radio.name = "voice-call-device";
      radio.value = peer.id;
      radio.checked = peer.id === selectedTarget;
      radio.addEventListener("change", () => { selectedTarget = radio.value; render(); });
      row.append(radio, win.document.createTextNode(peer.label));
      choices.append(row);
    }
    if (availablePeers.length === 0) choices.textContent = "No other devices are available.";
  }

  function button(text: string, action: () => void): HTMLButtonElement {
    const result = win.document.createElement("button");
    result.type = "button";
    labelButton(result, text, text === "Mute" ? "mic" : text === "End call" ? "end" : "phone");
    result.addEventListener("click", action);
    return result;
  }
  function labelButton(target: HTMLButtonElement, text: string, icon: "phone" | "end" | "mic" | "mic-off"): void {
    if (target.getAttribute("aria-label") === text && target.dataset["callAction"] === icon) return;
    const svg = win.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const paths = {
      phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z",
      end: "M3 15v3h4v-4m10 0v4h4v-3c0-5-18-5-18 0 M8 13a12 12 0 0 1 8 0",
      mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8",
      "mic-off": "m2 2 20 20 M9 9v3a3 3 0 0 0 5.1 2.1 M15 9V5a3 3 0 0 0-5.7-1.3 M5 10v2a7 7 0 0 0 12 4.9 M19 10v2 M12 19v3 M8 22h8",
    };
    const path = win.document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[icon]);
    svg.append(path);
    const caption = win.document.createElement("span");
    caption.className = "wx-srv-call-caption";
    caption.textContent = text;
    target.replaceChildren(svg, caption);
    target.title = text;
    target.setAttribute("aria-label", text);
    target.dataset["callAction"] = icon;
  }
  function render(): void {
    element.dataset["state"] = state;
    const inCall = callId !== null;
    notice.hidden = !noticeText.textContent || !dialog.hidden || inCall;
    if (inCall || outgoingRequest !== null) dialog.hidden = true;
    callButton.setAttribute("aria-expanded", String(!dialog.hidden));
    callButton.setAttribute("aria-haspopup", "dialog");
    callButton.hidden = inCall;
    const targetAvailable = availablePeers.some((peer) => peer.id === selectedTarget);
    const reason =
      outgoingRequest !== null
        ? "Your call is starting…"
        : socket?.readyState !== 1
          ? ""
          : availablePeers.length === 0
            ? "No other device is online right now"
            : deps.isMicBusy()
              ? "The microphone is in use"
              : "";
    callButton.disabled = reason !== "";
    callReason.textContent = reason;
    if (reason === "") callButton.removeAttribute("aria-describedby");
    else callButton.setAttribute("aria-describedby", callReason.id);
    callButton.title = reason === "" ? (callButton.getAttribute("aria-label") ?? "") : reason;
    confirm.disabled = !targetAvailable || socket?.readyState !== 1 || deps.isMicBusy() || outgoingRequest !== null;
    acceptButton.hidden = state !== "incoming";
    acceptButton.disabled = answerPending || deps.isMicBusy();
    muteButton.hidden = state !== "connected";
    endButton.hidden = !inCall;
    labelButton(endButton, state === "incoming" ? "Decline" : state === "outgoing" ? "Cancel call" : "End call", "end");
    deps.onLive?.(state !== "idle" || outgoingRequest !== null || !dialog.hidden || !notice.hidden);
  }
  function send(message: Record<string, unknown>): boolean {
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 8192) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function teardownCall(message: string): void {
    clearFailure();
    dialog.hidden = true;
    callEpoch++;
    audio?.stop();
    audio = null;
    releasePermission?.release();
    releasePermission = null;
    releaseCall?.release();
    releaseCall = null;
    callId = null;
    outgoingRequest = null;
    answerPending = false;
    callUntil = 0;
    state = "idle";
    muted = false;
    sequence = 0;
    playoutId = 0;
    leases.clear();
    deps.onBusy(false);
    status.textContent = message;
    labelButton(muteButton, "Mute", "mic");
    muteButton.setAttribute("aria-pressed", "false");
    render();
  }
  function end(message: string, failure = false): void {
    const endedId = callId;
    const wasPending = outgoingRequest !== null;
    const action = failure ? "failed" : state === "incoming" ? "decline" : "end";
    teardownCall(message); // Stop locally before best-effort network activity.
    if (endedId) send({ type: action, callId: endedId });
    else if (wasPending) disconnect();
    if (failure) showFailure(message);
  }
  function activateAudio(): boolean {
    if (deps.isMicBusy()) return false;
    const attemptEpoch = ++callEpoch;
    const old = audio;
    audio = null;
    old?.stop(); // Invalidate old callbacks before touching the old graph.
    try {
      audio = (deps.audioFactory ?? ((capture, ack, fail, ready, diagnostic) => new CallAudio(capture, ack, fail, ready, diagnostic)))(
        (pcm, lease) => {
          if (attemptEpoch !== callEpoch) return;
          if (state !== "connected" || !callId || muted || !socket || socket.readyState !== 1) return;
          const now = win.performance.now();
          if (now - lastPulse > LEASE_MS) {
            diagnostics.record({ step: "main-thread-stalled" });
            end("The browser paused, so the call stopped. Please try again.", true);
            return;
          }
          if (socket.bufferedAmount > 8192) {
            backlogAt ??= now;
            if (now - backlogAt > 250) {
              diagnostics.record({ step: "connection-slow" });
              end("The connection couldn't keep up, so the call stopped.", true);
            }
            return;
          }
          backlogAt = null;
          socket.send(encodeFrame(callId, sequence++, lease, pcm));
        },
        (seq) => { if (attemptEpoch === callEpoch && state === "connected" && callId) send({ type: "ack", callId, sequence: seq }); },
        () => {
          if (attemptEpoch === callEpoch) {
            diagnostics.record({ step: "audio-failed" });
            end("Audio stopped. Please check microphone permission and try again.", true);
          }
        },
        (until, remainingMs) => {
          // A receiver playout lease is issued only after the graph proved it rendered.
          if (attemptEpoch !== callEpoch || state !== "connected" || !callId) return;
          if (!(remainingMs > 0 && remainingMs <= LEASE_MS)) {
            diagnostics.record({ step: "render-stalled" });
            end("Audio playback didn't start in time. Please try again.", true);
            return;
          }
          const now = win.performance.now();
          const id = ++playoutId;
          leases.set(id, { at: now + remainingMs, until });
          for (const [key, lease] of leases) if (lease.at <= now) leases.delete(key);
          if (leases.size > 4) leases.delete(leases.keys().next().value as number);
          if (!send({ type: "lease", callId, lease: id })) {
            diagnostics.record({ step: "connection-slow" });
            end("The connection couldn't keep up, so the call stopped.", true);
          }
        },
        (event) => { if (attemptEpoch === callEpoch) diagnostics.record(event); },
      );
      return true;
    } catch (error) {
      diagnostics.record({ step: "setup-failed", error });
      end("This browser couldn't start call audio. Check microphone permission and try again.", true);
      return false;
    }
  }
  function pulse(): void {
    render(); // Recorder ownership can change without a presence event.
    const now = win.performance.now();
    const stale = now - lastPulse > LEASE_MS;
    lastPulse = now;
    if (callUntil && now >= callUntil) {
      noteUnansweredRing();
      diagnostics.record({ step: "setup-timeout" });
      end("Call timed out. Please try again.", true);
      return;
    }
    if (now - lastMessage > 6000 || Date.now() / 1000 >= deadline) {
      connectionFailure({ step: "connection-timeout" }, "The call connection timed out. Tap the phone icon to reconnect.");
      status.textContent = "Calls disconnected. Reconnect to try again.";
      return;
    }
    // Heartbeat for the idle-lock pause: a page frozen mid-call stops this tick, which is how the
    // panel knows the hold is stranded rather than live (Inv 55).
    releaseCall?.touch();
    releasePermission?.touch();
    if (state === "connected" && callId && audio) {
      if (stale) {
        diagnostics.record({ step: "main-thread-stalled" });
        end("The browser paused, so the call stopped. Please try again.", true);
        return;
      }
      audio.pulse();
    }
  }
  async function prepare(id: string): Promise<void> {
    if (id !== callId || !audio || deps.isMicBusy()) { end("The microphone is unavailable or already in use.", true); return; }
    const epoch = callEpoch;
    const attempt = audio;
    state = "preparing";
    diagnostics.record({ step: "preparing" });
    callUntil = win.performance.now() + 20_000;
    status.textContent = "Connecting audio…";
    deps.onBusy(true);
    for (const media of element.parentElement?.querySelectorAll<HTMLMediaElement>("audio,video") ?? []) media.pause();
    releasePermission = hooks.suspendLive("micPermission");
    render();
    try {
      await attempt.prepare();
      if (epoch !== callEpoch || attempt !== audio || callId !== id) return;
      releasePermission?.release();
      releasePermission = null;
      diagnostics.record({ step: "ready" });
      send({ type: "ready", callId: id });
    } catch (error) {
      if (epoch === callEpoch && attempt === audio) {
        diagnostics.record({ step: "setup-failed", error });
        const denied = safeAudioError(error) === "NotAllowedError";
        end(denied ? "Microphone permission was denied. Allow microphone access in this browser, then try again."
          : "Microphone or audio setup failed. Please try again, or copy the call details.", true);
      }
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
      labelButton(callButton, "Call", "phone");
    } else if (m["type"] === "presence" && Array.isArray(m["peers"])) {
      availablePeers = [];
      for (const candidate of m["peers"].slice(0, 8) as Record<string, unknown>[]) {
        if (candidate["available"] !== true || typeof candidate["id"] !== "string" || typeof candidate["label"] !== "string") continue;
        availablePeers.push({ id: candidate["id"], label: `${candidate["label"].slice(0, 32)} · ${candidate["id"].slice(0, 4)}` });
      }
      // Preserve an unavailable selection rather than silently calling another device.
      if (selectedTarget === null) selectedTarget = availablePeers[0]?.id ?? null;
      if (!dialog.hidden) renderChoices();
    } else if (m["type"] === "incoming" || m["type"] === "outgoing") {
      // An outgoing reply must answer this tab's own pending request.
      if (m["type"] === "outgoing" && (outgoingRequest === null || m["requestId"] !== outgoingRequest)) return;
      if (callId || typeof m["callId"] !== "string") throw new Error("Invalid invite");
      if (m["type"] === "incoming" && outgoingRequest !== null) {
        // A crossing invite lost to this one. Release only that attempt's audio; keep the
        // request id so its busy reply is recognised. Answer still needs its own gesture.
        callEpoch++;
        audio?.stop();
        audio = null;
        deps.onBusy(false);
      } else outgoingRequest = null;
      callId = m["callId"];
      state = m["type"];
      // A ringing call (either side) keeps the chat unlocked until it is answered or ends. An
      // unattended device stops holding after MAX_HELD_UNANSWERED_RINGS rings in a row that nobody
      // touched it for, so a peer re-inviting in a loop cannot hold idle off forever.
      if (hooks.activityCount() !== unansweredAt) unansweredRings = 0; // someone touched the device since
      if (state === "outgoing" || unansweredRings < MAX_HELD_UNANSWERED_RINGS) holdCall();
      clearFailure();
      if (state === "incoming") diagnostics.reset();
      diagnostics.record({ step: state === "incoming" ? "incoming" : "outgoing" });
      callUntil = win.performance.now() + 30_000;
      status.textContent = state === "incoming" ? `Incoming call from ${String(m["peer"]).slice(0, 32)}` : "Calling…";
    } else if (m["type"] === "unavailable") {
      if (outgoingRequest === null || m["requestId"] !== outgoingRequest) return;
      outgoingRequest = null;
      if (callId === null) teardownCall("That person is unavailable");
    } else if (m["type"] === "ended" && m["callId"] !== callId) {
      if (outgoingRequest !== null && m["requestId"] === outgoingRequest) {
        outgoingRequest = null;
        if (callId === null) remoteEnd(m["reason"]);
      }
      return;
    } else if (m["callId"] !== callId || !callId) {
      return; // Late terminal/readiness messages cannot revive a canceled attempt.
    } else if (m["type"] === "prepare" && (state === "outgoing" || state === "incoming")) {
      void prepare(callId);
    } else if (m["type"] === "connected" && state === "preparing" && audio) {
      state = "connected";
      diagnostics.record({ step: "connected" });
      // No media was active during setup; a permission chooser may have paused timers.
      // Connected stalls still use the unchanged freshness/liveness budget from here.
      lastPulse = win.performance.now();
      callUntil = win.performance.now() + 7_200_000;
      audio.start();
      holdCall(); // Already held since the invite/ring; a no-op here, so there is no gap.
      status.textContent = "On a voice call";
      pulse();
    } else if (m["type"] === "capture" && typeof m["lease"] === "number" && state === "connected") {
      audio?.captureLease(m["lease"]);
    } else if (m["type"] === "ended") {
      remoteEnd(m["reason"]);
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
    render(); // The final affordance must use the cleared socket, with no pulse left.
  }
  function connectionFailure(event: AudioDiagnostic, message: string): void {
    const active = callId !== null || outgoingRequest !== null;
    // An idle transport failure is a separate diagnostic, not part of the last call.
    if (!active) diagnostics.reset();
    diagnostics.record(event);
    disconnect();
    if (active) showFailure(message);
    else diagnostics.printOnce();
  }
  function open(next: ServerSession, name: string): void {
    disconnect();
    diagnostics.reset();
    session = next;
    label = name;
    const epoch = socketEpoch;
    const url = new URL("/api/admin/server/calls/ws", win.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try { socket = (deps.socketFactory ?? ((u, p) => new WebSocket(u, p)))(url.href, CALL_PROTOCOL); }
    catch (error) {
      connectionFailure({ step: "socket-error", error }, "The browser couldn't open the call connection. Please try again.");
      status.textContent = "Calls unavailable";
      return;
    }
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
        if (state === "connected" && win.performance.now() - lastPulse > LEASE_MS) {
          diagnostics.record({ step: "main-thread-stalled" });
          end("The browser paused, so the call stopped. Please try again.", true);
          return; // The expired message cannot update media or a newer call.
        }
        receive(event.data);
      } catch (error) {
        connectionFailure({ step: "protocol-error", error }, "The call connection couldn't be read. Please copy the call details.");
        status.textContent = "Calls disconnected";
      }
    };
    socket.onclose = (event) => {
      if (epoch !== socketEpoch) return;
      connectionFailure({ step: "socket-closed", code: event.code }, "The call connection closed. Tap the phone icon to reconnect.");
      status.textContent = "Calls disconnected. Reconnect to try again.";
      labelButton(callButton, "Reconnect calls", "phone");
      if (event.code === 4401) hooks.lockNow("unauthorized");
    };
    socket.onerror = () => {
      if (epoch === socketEpoch) {
        connectionFailure({ step: "socket-error" }, "The call connection failed. Please try again.");
        status.textContent = "Calls unavailable";
      }
    };
    timer = win.setInterval(pulse, 100);
    render();
  }
  function pagehide(): void { detach(); }
  function outside(event: PointerEvent): void {
    if (!dialog.hidden && event.target instanceof Node && !element.contains(event.target)) {
      dialog.hidden = true;
      render();
    }
  }
  win.addEventListener("pagehide", pagehide);
  win.document.addEventListener("pointerdown", outside);
  function detach(): void { disconnect(); diagnostics.reset(); session = null; element.hidden = true; }
  return {
    element,
    attach(next: ServerSession, name: string): void {
      element.hidden = false;
      if (session?.token === next.token && socket) return;
      open(next, name);
    },
    detach,
    dispose(): void {
      detach();
      win.removeEventListener("pagehide", pagehide);
      win.document.removeEventListener("pointerdown", outside);
    },
  };
}
