// The Cookout START SHEET (workspace 00058; spec/server-chat/09-cookout.md §5.4): the ⋯ menu's
// "Cookout" and the pane's "New" open this compact sheet over the chat — choose Open mode (the
// default) or Blind mode, then Start Cookout. From "New" the current round's mode comes preselected.
//
//   [ 🍳 New Cookout                                   ]
//   [ ( ) Open mode   — you both see every pair and pick ]
//   [ ( ) Blind mode  — secret picks, one big reveal    ]
//   [ Cancel                          Start Cookout ▸  ]
//
// A plain `div` with a backdrop rather than a `<dialog>`: Escape is this chat's panic key (it locks
// everything at once), so nothing here listens for it and the sheet closes by its buttons. Like the other
// screens of the ⋯ menu it sits BELOW the chat header, so the panic ✕ and the lock gestures stay reachable.

export interface CookoutStartSheetDeps {
  readonly document: Document;
  /** Start a round in the chosen mode. Resolves once the request is settled (the sheet waits on it, then
   * closes); rejects with the words to show when the round could not start (the sheet stays open). */
  start(blind: boolean): Promise<void>;
}

export interface CookoutStartSheet {
  /** The sheet and its backdrop: put it in the thread view. */
  readonly element: HTMLElement;
  /** Show the sheet below `topOffsetPx` (the chat header's height) with `blind` preselected (Open by
   * default). */
  open(blind?: boolean, topOffsetPx?: number): void;
  close(): void;
  isOpen(): boolean;
}

export function createCookoutStartSheet(deps: CookoutStartSheetDeps): CookoutStartSheet {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const root = el("div", "wx-srv-ck-start");
  root.hidden = true;
  const backdrop = el("div", "wx-srv-ck-start-backdrop");
  backdrop.setAttribute("data-srv-gesture-boundary", "");
  const sheet = el("div", "wx-srv-ck-start-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const heading = el("h2", "wx-srv-ck-start-title");
  heading.id = "wx-srv-ck-start-title";
  const headingIcon = el("span", "wx-srv-ck-start-icon", "🍳");
  headingIcon.setAttribute("aria-hidden", "true");
  heading.append(headingIcon, doc.createTextNode("New Cookout"));
  sheet.setAttribute("aria-labelledby", heading.id);
  const intro = el("p", "wx-srv-ck-start-intro", "Take turns picking 10 ingredients, then see what the chef invents.");

  const modes = el("div", "wx-srv-ck-start-modes");
  modes.setAttribute("role", "radiogroup");
  modes.setAttribute("aria-label", "Game mode");

  function modeOption(blind: boolean, icon: string, name: string, hint: string): HTMLButtonElement {
    const option = el("button", "wx-srv-ck-mode");
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("data-srv-gesture-boundary", "");
    option.dataset["mode"] = blind ? "blind" : "open";
    const glyph = el("span", "wx-srv-ck-mode-icon", icon);
    glyph.setAttribute("aria-hidden", "true");
    const words = el("span", "wx-srv-ck-mode-words");
    words.append(el("span", "wx-srv-ck-mode-name", name), el("span", "wx-srv-ck-mode-hint", hint));
    const tick = el("span", "wx-srv-ck-mode-tick", "✓");
    tick.setAttribute("aria-hidden", "true");
    option.append(glyph, words, tick);
    option.addEventListener("click", () => select(blind));
    return option;
  }

  const openOption = modeOption(false, "👀", "Open mode", "You both see every pair and every pick");
  const blindOption = modeOption(true, "🕵️", "Blind mode", "Secret picks, then one big reveal");
  modes.append(openOption, blindOption);

  const error = el("p", "wx-srv-ck-start-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = el("div", "wx-srv-ck-start-actions");
  const cancel = el("button", "wx-srv-ck-start-cancel", "Cancel");
  cancel.type = "button";
  cancel.setAttribute("data-srv-gesture-boundary", "");
  const go = el("button", "wx-srv-ck-start-go", "Start Cookout");
  go.type = "button";
  go.setAttribute("data-srv-gesture-boundary", "");
  actions.append(cancel, go);
  sheet.append(heading, intro, modes, error, actions);
  root.append(backdrop, sheet);

  let opened = false;
  let blindChosen = false;
  let busy = false;
  /** Bumped on open/close: a start that settles after the sheet went away does not touch it. */
  let generation = 0;

  function select(blind: boolean): void {
    if (busy) return;
    blindChosen = blind;
    for (const [option, on] of [
      [openOption, !blind],
      [blindOption, blind],
    ] as const) {
      option.setAttribute("aria-checked", on ? "true" : "false");
      option.classList.toggle("wx-srv-ck-mode-on", on);
    }
  }

  function setBusy(next: boolean): void {
    busy = next;
    go.disabled = next;
    cancel.disabled = next;
    go.textContent = next ? "Starting…" : "Start Cookout";
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    generation += 1;
    setBusy(false);
    root.hidden = true;
  }

  async function start(): Promise<void> {
    if (busy) return;
    const started = ++generation;
    setBusy(true);
    error.hidden = true;
    try {
      await deps.start(blindChosen);
    } catch (thrown) {
      if (started === generation) {
        error.textContent =
          thrown instanceof Error && thrown.message !== "" ? thrown.message : "Couldn't start a Cookout — try again.";
        error.hidden = false;
        setBusy(false);
      }
      return;
    }
    if (started === generation) close();
  }

  cancel.addEventListener("click", () => close());
  backdrop.addEventListener("click", () => {
    if (!busy) close();
  });
  go.addEventListener("click", () => void start());

  return {
    element: root,
    open(blind = false, topOffsetPx = 0) {
      generation += 1;
      root.style.top = `${topOffsetPx}px`;
      opened = true;
      setBusy(false);
      error.hidden = true;
      select(blind);
      root.hidden = false;
      go.focus();
    },
    close,
    isOpen: () => opened,
  };
}
