// The Holiday bank (workspace 00056; spec/server-chat/08-adventure-time.md §5.4): the ⋯ menu's "Holiday
// bank" opens this full-height screen over the thread listing every banked trip, newest first —
// destination, country and the research's headline — and tapping one opens that trip in the Adventure tab
// (its pack and its chat). It is the Links / Gallery precedent: under the chat header so the panic ✕ and
// the lock gestures stay reachable, closed by every lock and wipe (`thread.detach()` / `teardown()`).
//
// The list is the server's `GET /adventure/bank` (derived from banked rounds, so deleting a trip's
// message removes it). While the screen is open a trip that is banked, changes or is deleted re-reads
// the list (a short debounce collects a burst of changes into one request).

import { ServerLockedError } from "../api/http";
import type { Message } from "../api/messages";
import type { LockHooks, ServerSession } from "../types";
import { getAdventureBank, type BankResult, type BankTrip } from "./api";

export interface HolidayBankDeps {
  readonly document: Document;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly getSession: () => ServerSession | null;
  /** A trip was tapped: open it in the Adventure tab (the bank closes itself first). */
  openTrip(seq: number): void;
  /** Injectable for tests; defaults to the real `GET /adventure/bank`. */
  readonly fetchBank?: (session: ServerSession) => Promise<BankResult>;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export interface HolidayBank {
  readonly element: HTMLElement;
  /** Show the screen below `topOffsetPx` (the chat header's height). */
  open(topOffsetPx: number): void;
  close(): void;
  isOpen(): boolean;
  /** A message arrived or changed in the thread: re-read the list if it is an adventure. */
  messageChanged(message: Message): void;
  messageDeleted(seq: number): void;
}

const REFRESH_DEBOUNCE_MS = 400;

export function createHolidayBank(deps: HolidayBankDeps): HolidayBank {
  const doc = deps.document;
  const fetchBank = deps.fetchBank ?? getAdventureBank;
  const setTimer = deps.setTimeout ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = deps.clearTimeout ?? ((id: number) => window.clearTimeout(id));

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const root = el("div", "wx-srv-bank-view");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Holiday bank");

  const bar = el("div", "wx-srv-bank-bar");
  const title = el("span", "wx-srv-bank-title", "Holiday bank");
  const closeButton = el("button", "wx-srv-bank-close", "Back to chat");
  closeButton.type = "button";
  closeButton.setAttribute("data-srv-gesture-boundary", "");
  bar.append(title, closeButton);

  const list = el("div", "wx-srv-bank-list");
  const empty = el("p", "wx-srv-bank-empty", "Nothing saved yet. Bank a place with “Bank this” in the Adventure Time game.");
  empty.hidden = true;
  const loading = el("p", "wx-srv-bank-loading", "Loading…");
  loading.hidden = true;
  const error = el("p", "wx-srv-bank-error");
  error.hidden = true;
  const retry = el("button", "wx-srv-bank-retry", "Try again");
  retry.type = "button";
  retry.setAttribute("data-srv-gesture-boundary", "");
  retry.hidden = true;
  const trips = el("div", "wx-srv-bank-trips");
  list.append(trips, empty, loading, error, retry);
  root.append(bar, list);

  let opened = false;
  let loaded = false;
  let busy = false;
  let again = false;
  let current: readonly BankTrip[] = [];
  /** Bumped on every open/close so an answer to an earlier session of the screen is dropped. */
  let generation = 0;
  let timer: number | null = null;

  function refreshChrome(): void {
    empty.hidden = !(loaded && current.length === 0 && error.hidden);
    loading.hidden = !(busy && !loaded);
    retry.hidden = error.hidden;
  }

  function tripButton(trip: BankTrip): HTMLElement {
    const row = el("button", "wx-srv-bank-trip");
    row.type = "button";
    row.setAttribute("data-srv-gesture-boundary", "");
    row.dataset["tripSeq"] = String(trip.seq);
    row.append(el("span", "wx-srv-bank-trip-name", trip.destination.name));
    row.append(el("span", "wx-srv-bank-trip-where", [trip.destination.region, trip.unitName].filter((s) => s !== "").join(", ")));
    const line = trip.headline ?? trip.destination.blurb;
    if (line !== "") row.append(el("span", "wx-srv-bank-trip-headline", line));
    row.addEventListener("click", () => {
      view.close();
      deps.openTrip(trip.seq);
    });
    return row;
  }

  function draw(): void {
    trips.replaceChildren(...current.map(tripButton));
    refreshChrome();
  }

  async function load(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    const session = deps.getSession();
    if (session === null) return;
    const started = generation;
    busy = true;
    error.hidden = true;
    refreshChrome();
    let result: BankResult;
    try {
      result = await fetchBank(session);
    } catch (thrown) {
      if (started === generation && thrown instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
      result = { ok: false, kind: "unavailable" };
    }
    if (started !== generation) return;
    busy = false;
    if (result.ok) {
      current = result.trips;
      loaded = true;
      error.hidden = true;
    } else {
      error.textContent = "Couldn't load the Holiday bank.";
      error.hidden = false;
      loaded = true;
    }
    draw();
    if (again) {
      again = false;
      void load();
    }
  }

  function scheduleRefresh(): void {
    if (!opened || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void load();
    }, REFRESH_DEBOUNCE_MS);
  }

  closeButton.addEventListener("click", () => view.close());
  retry.addEventListener("click", () => void load());

  const view: HolidayBank = {
    element: root,
    open(topOffsetPx) {
      if (opened) return;
      opened = true;
      generation += 1;
      loaded = false;
      busy = false;
      again = false;
      current = [];
      error.hidden = true;
      trips.replaceChildren();
      root.style.top = `${topOffsetPx}px`;
      root.hidden = false;
      list.scrollTop = 0;
      refreshChrome();
      void load();
    },
    close() {
      if (!opened) return;
      opened = false;
      generation += 1;
      busy = false;
      again = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      root.hidden = true;
      trips.replaceChildren();
      current = [];
    },
    isOpen: () => opened,
    messageChanged(message) {
      if (message.adventure === undefined || message.adventure === null) return;
      scheduleRefresh();
    },
    messageDeleted(seq) {
      if (!opened) return;
      if (current.some((trip) => trip.seq === seq)) {
        current = current.filter((trip) => trip.seq !== seq);
        draw();
      }
    },
  };
  return view;
}
