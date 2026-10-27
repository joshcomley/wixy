// Adventure Time preview — the DOM around the globe: top bar, stage overlays, the action dock, the
// holiday pack panel and the two sheets (Options, Holiday bank). Plain DOM, no framework, text always
// set with textContent (the sample pack comes from a file: never innerHTML).

import type { Dest, Memory, Pack } from "./data";
import type { Hud } from "./game";

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props !== null) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") el.className = value;
      else el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function safeUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function link(url: string | null, label: string): HTMLElement | null {
  const href = safeUrl(url);
  if (href === null) return null;
  const a = h("a", { class: "pk-link", href, target: "_blank", rel: "noopener noreferrer" }, label);
  return a;
}

export function renderPack(pack: Pack, dest: Dest, unitName: string, isSample: boolean): HTMLElement {
  const root = h("div", { class: "pk" });
  if (isSample) {
    root.append(
      h(
        "div",
        { class: "pk-sample" },
        "Sample pack. The real game researches the place you land on; this one is the example for ",
        h("b", null, "Kotor"),
        ".",
      ),
    );
  }
  root.append(
    h("div", { class: "pk-place" }, `${dest.name}, ${unitName}`),
    h("h2", { class: "pk-headline" }, pack.headline),
    h("p", { class: "pk-summary" }, pack.summary),
  );
  for (const section of pack.sections) {
    const card = h("section", { class: `pk-card pk-${section.key}` }, h("h3", null, section.title));
    const list = h("ul", { class: "pk-items" });
    for (const item of section.items) {
      list.append(
        h(
          "li",
          null,
          h("div", { class: "pk-item-name" }, item.name),
          h("div", { class: "pk-item-detail" }, item.detail),
          link(item.url, "Open link"),
        ),
      );
    }
    card.append(list);
    root.append(card);
  }
  const facts: Array<[string, string]> = [
    ["Best time to go", pack.bestTime],
    ["Getting there", pack.gettingThere],
    ["Travel advice", pack.travelAdvice],
  ];
  for (const [title, text] of facts) {
    if (text === "") continue;
    root.append(h("section", { class: "pk-card pk-fact" }, h("h3", null, title), h("p", null, text)));
  }
  if (pack.sources.length > 0) {
    const list = h("ul", { class: "pk-sources" });
    for (const s of pack.sources) list.append(h("li", null, link(s.url, s.title) ?? s.title));
    root.append(h("section", { class: "pk-card pk-src" }, h("h3", null, "Sources"), list));
  }
  return root;
}

// -- The page ----------------------------------------------------------------------------------------

export interface UiHandlers {
  onNew(): void;
  onStop(): void;
  onBank(): void;
  onReject(): void;
  onKeep(): void;
  onAgain(): void;
  onBackToPlace(): void;
  onOptionsChanged(what: "advised" | "other" | "motion" | "debug"): void;
  onForget(): void;
}

export interface Ui {
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  applyHud(hud: Hud, rejectPending: boolean): void;
  setDebug(text: string): void;
  refreshBank(): void;
  readonly packHost: HTMLElement;
}

export function buildUi(memory: Memory, systemReducedMotion: boolean, handlers: UiHandlers): Ui {
  const canvas = h("canvas", { class: "globe", "aria-label": "Spinning globe", role: "img" });
  const hintMain = h("div", { class: "hint-main" });
  const hintSub = h("div", { class: "hint-sub" });
  const hint = h("div", { class: "hint", "aria-live": "polite" }, hintMain, hintSub);
  const toast = h("div", { class: "toast" });
  const nearest = h("div", { class: "nearest" });
  const litName = h("div", { class: "lit-name" });
  const litSub = h("div", { class: "lit-sub" });
  const lit = h("div", { class: "lit", "aria-live": "polite" }, litName, litSub);
  const back = h("button", { class: "chip back", type: "button" }, "Back to the place");
  const debugPre = h("pre", { class: "debug-pre" });
  const debug = h("details", { class: "debug" }, h("summary", null, "debug"), debugPre);
  const stage = h("section", { class: "stage" }, canvas, hint, toast, nearest, lit, back, debug);

  // Action dock.
  const stop = h("button", { class: "stop", type: "button" }, "Stop");
  const dockStop = h("div", { class: "dock-row dock-stop" }, stop);
  const yes = h("button", { class: "big yes", type: "button" }, "Let's go there ✓");
  const no = h("button", { class: "big no", type: "button" }, "No thanks ✕");
  const decideRow = h("div", { class: "dock-row dock-decide-row" }, yes, no);
  const askText = h("div", { class: "ask" });
  const neverYes = h("button", { class: "big no", type: "button" }, "Never show again");
  const neverNo = h("button", { class: "big keep", type: "button" }, "Keep it");
  const askRow = h("div", { class: "dock-row dock-ask-row" }, neverYes, neverNo);
  const dockDecide = h("div", { class: "dock-block dock-decide" }, askText, decideRow, askRow);
  const outcome = h("div", { class: "outcome" });
  const again = h("button", { class: "big again", type: "button" }, "Play again");
  const dockAgain = h("div", { class: "dock-block dock-again" }, outcome, again);
  const dock = h("footer", { class: "dock" }, dockStop, dockDecide, dockAgain);

  // Pack panel.
  const packTimer = h("span", { class: "pk-timer" }, "0:00");
  const packPending = h(
    "div",
    { class: "pk-pending" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("div", { class: "pk-pending-text" }, h("b", null, "Preparing holiday pack… "), packTimer, h("div", { class: "pk-pending-sub" }, "This can take a couple of minutes.")),
  );
  const exploreToggle = h("button", { class: "chip explore-toggle", type: "button" }, "Explore map");
  const packHost = h("div", { class: "pk-host" });
  const packBar = h("div", { class: "pk-bar" }, h("span", { class: "pk-bar-title" }, "Holiday pack"), exploreToggle);
  const pack = h("section", { class: "pack" }, packPending, packBar, packHost);

  // Header.
  const bankCount = h("span", { class: "count" }, "0");
  const bankBtn = h("button", { class: "chip", type: "button" }, "Bank ", bankCount);
  const newBtn = h("button", { class: "chip", type: "button" }, "New");
  const optionsBtn = h("button", { class: "chip", type: "button", "aria-haspopup": "dialog" }, "Options");
  const header = h(
    "header",
    { class: "bar" },
    h("div", { class: "title" }, h("span", { class: "title-globe", "aria-hidden": "true" }, "🌍"), h("span", { class: "title-text" }, "Adventure Time")),
    h("div", { class: "bar-actions" }, bankBtn, newBtn, optionsBtn),
  );

  // Options sheet.
  function toggleRow(id: string, title: string, help: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
    const input = h("input", { type: "checkbox", id, class: "switch-input" });
    input.checked = checked;
    const row = h(
      "label",
      { class: "opt", for: id },
      h("div", { class: "opt-text" }, h("div", { class: "opt-title" }, title), h("div", { class: "opt-help" }, help)),
      h("span", { class: "switch" }, input, h("span", { class: "switch-track" }, h("span", { class: "switch-knob" }))),
    );
    return { row, input };
  }
  const advised = toggleRow(
    "opt-advised",
    "Include places the UK says not to travel to",
    "Off by default. Countries where the UK government advises against all travel are left out of the draws.",
    memory.settings.includeAdvised,
  );
  const other = toggleRow(
    "opt-other",
    "Play the other person",
    "Cupcake does the two spins while you watch their swipe as a pen trail. You do the Stops.",
    memory.settings.playOther,
  );
  const motion = toggleRow(
    "opt-motion",
    "Reduce motion",
    systemReducedMotion ? "Your device asks for reduced motion." : "Cuts instead of camera moves, no glow flicker, no swipe trail.",
    memory.settings.reducedMotion ?? systemReducedMotion,
  );
  const debugOpt = toggleRow("opt-debug", "Show the debug corner", "Landing point, candidates and frame times.", memory.settings.showDebug);
  const forget = h("button", { class: "big no forget", type: "button" }, "Forget my banked and rejected places");
  const optionsClose = h("button", { class: "chip sheet-close", type: "button" }, "Done");
  const optionsSheet = h(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Options", hidden: "" },
    h(
      "div",
      { class: "sheet-card" },
      h("div", { class: "sheet-head" }, h("h2", null, "Options"), optionsClose),
      advised.row,
      other.row,
      motion.row,
      debugOpt.row,
      forget,
    ),
  );

  // Bank sheet.
  const bankList = h("ul", { class: "bank-list" });
  const bankEmpty = h("p", { class: "bank-empty" }, "Nothing saved yet. Bank a place with “Let's go there”.");
  const bankClose = h("button", { class: "chip sheet-close", type: "button" }, "Done");
  const bankSheet = h(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Holiday bank", hidden: "" },
    h("div", { class: "sheet-card" }, h("div", { class: "sheet-head" }, h("h2", null, "Holiday bank"), bankClose), bankEmpty, bankList),
  );

  const root = h("div", { class: "app", "data-pack": "none", "data-explore": "0", "data-action": "none" }, header, stage, pack, dock, optionsSheet, bankSheet);

  // -- wiring ---------------------------------------------------------------------------------------

  function openSheet(sheet: HTMLElement): void {
    sheet.hidden = false;
  }
  function closeSheet(sheet: HTMLElement): void {
    sheet.hidden = true;
  }
  optionsBtn.addEventListener("click", () => openSheet(optionsSheet));
  optionsClose.addEventListener("click", () => closeSheet(optionsSheet));
  bankBtn.addEventListener("click", () => {
    refreshBank();
    openSheet(bankSheet);
  });
  bankClose.addEventListener("click", () => closeSheet(bankSheet));
  for (const sheet of [optionsSheet, bankSheet]) {
    sheet.addEventListener("pointerdown", (e) => {
      if (e.target === sheet) closeSheet(sheet);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSheet(optionsSheet);
      closeSheet(bankSheet);
    }
  });
  newBtn.addEventListener("click", () => handlers.onNew());
  // Stop fires on the press, not the release: what you saw lit is what you get.
  stop.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handlers.onStop();
  });
  stop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlers.onStop();
    }
  });
  yes.addEventListener("click", () => handlers.onBank());
  no.addEventListener("click", () => handlers.onReject());
  neverYes.addEventListener("click", () => handlers.onReject());
  neverNo.addEventListener("click", () => handlers.onKeep());
  again.addEventListener("click", () => handlers.onAgain());
  back.addEventListener("click", () => handlers.onBackToPlace());
  exploreToggle.addEventListener("click", () => {
    const exploring = root.getAttribute("data-explore") === "1";
    root.setAttribute("data-explore", exploring ? "0" : "1");
    exploreToggle.textContent = exploring ? "Explore map" : "Show holiday pack";
  });
  advised.input.addEventListener("change", () => {
    memory.settings.includeAdvised = advised.input.checked;
    memory.saveSettings();
    handlers.onOptionsChanged("advised");
  });
  other.input.addEventListener("change", () => {
    memory.settings.playOther = other.input.checked;
    memory.saveSettings();
    handlers.onOptionsChanged("other");
  });
  motion.input.addEventListener("change", () => {
    memory.settings.reducedMotion = motion.input.checked;
    memory.saveSettings();
    root.classList.toggle("reduce", motion.input.checked);
    handlers.onOptionsChanged("motion");
  });
  debugOpt.input.addEventListener("change", () => {
    memory.settings.showDebug = debugOpt.input.checked;
    memory.saveSettings();
    debug.hidden = !debugOpt.input.checked;
    handlers.onOptionsChanged("debug");
  });
  forget.addEventListener("click", () => {
    handlers.onForget();
    refreshBank();
  });
  root.classList.toggle("reduce", memory.settings.reducedMotion ?? systemReducedMotion);
  debug.hidden = !memory.settings.showDebug;

  function refreshBank(): void {
    bankCount.textContent = String(memory.banked.length);
    bankList.replaceChildren();
    bankEmpty.hidden = memory.banked.length > 0;
    for (const trip of memory.banked) {
      bankList.append(
        h(
          "li",
          null,
          h("div", { class: "bank-name" }, trip.dest.name),
          h("div", { class: "bank-where" }, `${trip.dest.region}, ${trip.unitName}`),
          h("div", { class: "bank-blurb" }, trip.dest.blurb),
        ),
      );
    }
  }
  refreshBank();

  // -- HUD ------------------------------------------------------------------------------------------

  const prev = new Map<string, string>();
  function setText(key: string, el: HTMLElement, text: string): void {
    if (prev.get(key) === text) return;
    prev.set(key, text);
    el.textContent = text;
  }
  function setAttr(key: string, el: HTMLElement, name: string, value: string): void {
    if (prev.get(key) === value) return;
    prev.set(key, value);
    el.setAttribute(name, value);
  }

  function applyHud(hud: Hud, rejectPending: boolean): void {
    setText("hint", hintMain, hud.hint);
    setText("sub", hintSub, hud.sub);
    hintSub.hidden = hud.sub === "";
    setAttr("hintShow", hint, "data-show", hud.hint === "" ? "0" : "1");
    setText("toast", toast, hud.toast ?? "");
    setAttr("toastShow", toast, "data-show", hud.toast === null ? "0" : "1");
    setText("nearest", nearest, hud.nearest ?? "");
    setAttr("nearestShow", nearest, "data-show", hud.nearest === null ? "0" : "1");
    setText("litName", litName, hud.lit?.name ?? "");
    setText("litSub", litSub, hud.lit?.sub ?? "");
    litSub.hidden = hud.lit?.sub === null || hud.lit === null;
    setAttr("litShow", lit, "data-show", hud.lit === null ? "0" : "1");
    setAttr("interactive", stage, "data-interactive", hud.interactive);
    back.hidden = !(hud.canExplore && hud.chosen !== null);

    // Action dock.
    const action = hud.action === "decide" && rejectPending ? "ask" : hud.action;
    setAttr("action", root, "data-action", action);
    const packVisible = hud.pack !== null;
    const packState = hud.pack === null ? "none" : hud.pack.state;
    setAttr("pack", root, "data-pack", packState);
    if (hud.action === "stop") {
      const label = hud.stopLive ? "Stop" : "Get ready…";
      setText("stopLabel", stop, label);
      setAttr("stopLive", stop, "data-live", hud.stopLive ? "1" : "0");
      stop.setAttribute("aria-disabled", hud.stopLive ? "false" : "true");
    }
    if (hud.chosen !== null) {
      setText("ask", askText, rejectPending ? `Never show ${hud.chosen.dest.name} again?` : "");
    }
    setText("outcome", outcome, hud.outcome ?? "");
    if (hud.pack !== null) {
      const s = Math.floor(hud.pack.elapsedS);
      setText("timer", packTimer, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
    }
    void packVisible;
  }

  return {
    root,
    stage,
    canvas,
    applyHud,
    setDebug(text) {
      if (!debug.hidden) setText("debugPre", debugPre, text);
    },
    refreshBank,
    packHost,
  };
}
