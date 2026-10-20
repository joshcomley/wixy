// The would-you-rather TOPICS screen (workspace 00052): "Game topics" in the ⋯ menu, and
// "Topics" on the game tab, open this full-height screen — a checklist of the question bank's
// topics with Select all / Unselect all. Save applies the choice for BOTH players' next rounds
// (it is stored on the server); at least one topic must be ticked. Opens under the header like
// the Gallery and Links screens; the thread closes it on every lock.

import { ServerLockedError } from "./api/http";
import { getWyrTopics, putWyrTopics, type WyrTopic, type WyrTopicsResult } from "./api/wyr";
import type { LockHooks, ServerSession } from "./types";

export interface WyrTopicsDeps {
  readonly document: Document;
  readonly hooks: Pick<LockHooks, "lockNow">;
  readonly getSession: () => ServerSession | null;
  /** Injectable for tests. */
  readonly load?: (session: ServerSession) => Promise<WyrTopicsResult>;
  readonly save?: (session: ServerSession, topics: readonly string[]) => Promise<WyrTopicsResult>;
}

export interface WyrTopicsView {
  readonly element: HTMLElement;
  open(topOffsetPx: number): void;
  close(): void;
  isOpen(): boolean;
}

export function createWyrTopics(deps: WyrTopicsDeps): WyrTopicsView {
  const { document: doc, hooks } = deps;
  const load = deps.load ?? getWyrTopics;
  const save = deps.save ?? putWyrTopics;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(className: string, text: string): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("data-srv-gesture-boundary", "");
    return b;
  }

  const root = el("div", "wx-srv-topics-view");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Game topics");

  const bar = el("div", "wx-srv-topics-bar");
  const title = el("span", "wx-srv-topics-title", "Game topics");
  const closeButton = button("wx-srv-topics-close", "Back");
  bar.append(title, closeButton);

  const intro = el("p", "wx-srv-topics-intro", "Questions come only from the topics you tick.");
  const quick = el("div", "wx-srv-topics-quick");
  const selectAll = button("wx-srv-topics-all", "Select all");
  const clearAll = button("wx-srv-topics-none", "Unselect all");
  quick.append(selectAll, clearAll);

  const list = el("div", "wx-srv-topics-list");
  const status = el("p", "wx-srv-topics-status");
  status.setAttribute("role", "status");
  const foot = el("div", "wx-srv-topics-foot");
  const summary = el("span", "wx-srv-topics-summary");
  const saveButton = button("wx-srv-topics-save", "Save");
  foot.append(summary, saveButton);
  root.append(bar, intro, quick, list, status, foot);

  let topics: WyrTopic[] = [];
  const ticked = new Set<string>();
  let opened = false;
  let busy = false;
  /** Bumped on every open/close so a response from an earlier session of the screen is dropped. */
  let generation = 0;
  const checkboxes = new Map<string, HTMLInputElement>();

  function setStatus(text: string): void {
    status.textContent = text;
    status.hidden = text === "";
  }

  function refresh(): void {
    for (const [id, box] of checkboxes) box.checked = ticked.has(id);
    const questions = topics.filter((t) => ticked.has(t.id)).reduce((sum, t) => sum + t.count, 0);
    summary.textContent =
      ticked.size === 0
        ? "Pick at least one topic"
        : `${ticked.size} of ${topics.length} topics · ${questions} questions`;
    saveButton.disabled = busy || topics.length === 0 || ticked.size === 0;
    selectAll.disabled = busy || topics.length === 0;
    clearAll.disabled = busy || topics.length === 0;
  }

  function render(): void {
    list.replaceChildren();
    checkboxes.clear();
    for (const topic of topics) {
      const row = el("label", "wx-srv-topics-row");
      // Ticking several topics in a row must not read as the lock double-tap (gestures.ts).
      row.setAttribute("data-srv-gesture-boundary", "");
      const box = doc.createElement("input");
      box.type = "checkbox";
      box.className = "wx-srv-topics-box";
      box.addEventListener("change", () => {
        if (box.checked) ticked.add(topic.id);
        else ticked.delete(topic.id);
        setStatus("");
        refresh();
      });
      row.append(
        box,
        el("span", "wx-srv-topics-name", topic.label),
        el("span", "wx-srv-topics-count", String(topic.count)),
      );
      list.appendChild(row);
      checkboxes.set(topic.id, box);
    }
    refresh();
  }

  function adopt(next: readonly WyrTopic[]): void {
    topics = [...next];
    ticked.clear();
    for (const topic of topics) if (topic.selected) ticked.add(topic.id);
    render();
  }

  async function run(
    startGeneration: number,
    action: () => Promise<WyrTopicsResult>,
    done: string,
  ): Promise<void> {
    busy = true;
    refresh();
    try {
      const result = await action();
      if (generation !== startGeneration) return;
      if (result.ok) {
        adopt(result.topics);
        setStatus(done);
      } else {
        setStatus("Could not reach the game - try again.");
      }
    } catch (error) {
      if (generation !== startGeneration) return;
      if (error instanceof ServerLockedError) {
        hooks.lockNow("unauthorized");
        return;
      }
      setStatus("Could not reach the game - try again.");
    } finally {
      if (generation === startGeneration) {
        busy = false;
        refresh();
      }
    }
  }

  selectAll.addEventListener("click", () => {
    for (const topic of topics) ticked.add(topic.id);
    setStatus("");
    refresh();
  });
  clearAll.addEventListener("click", () => {
    ticked.clear();
    setStatus("");
    refresh();
  });
  saveButton.addEventListener("click", () => {
    const session = deps.getSession();
    if (session === null || ticked.size === 0 || busy) return;
    const chosen = topics.filter((t) => ticked.has(t.id)).map((t) => t.id);
    void run(generation, () => save(session, chosen), "Saved. New rounds will use these topics.");
  });
  closeButton.addEventListener("click", () => view.close());

  const view: WyrTopicsView = {
    element: root,
    open(topOffsetPx: number): void {
      if (opened) return;
      const session = deps.getSession();
      if (session === null) return;
      opened = true;
      generation += 1;
      topics = [];
      ticked.clear();
      list.replaceChildren();
      checkboxes.clear();
      root.style.top = `${topOffsetPx}px`;
      root.hidden = false;
      setStatus("Loading…");
      refresh();
      void run(generation, () => load(session), "");
    },
    close(): void {
      if (!opened) return;
      opened = false;
      generation += 1;
      busy = false;
      root.hidden = true;
      list.replaceChildren();
      checkboxes.clear();
      topics = [];
      ticked.clear();
    },
    isOpen: () => opened,
  };
  setStatus("");
  return view;
}
