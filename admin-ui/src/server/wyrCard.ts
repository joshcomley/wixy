// The would-you-rather card (workspace 00045): the in-thread UI for one round. It draws from the
// pure `WyrModel` (latest viewer-filtered view + the unsent picks) and the anchor message's
// attachments (the two pictures, option A first). Everything user-visible is set via
// `textContent`; the only URLs used are the signed attachment URLs the server minted.

import type { Attachment, Message } from "./api/messages";
import type { WyrChoice, WyrOutcome, WyrVote, WyrView } from "./api/wyr";
import type { WyrModel } from "./wyrModel";

export interface WyrCardDeps {
  readonly model: WyrModel;
  readonly document: Document;
  /** My display name (null before one is set — the card then shows nothing to do). */
  viewer(): string | null;
  vote(seq: number, vote: WyrVote): Promise<WyrOutcome>;
  answer(seq: number, choice: WyrChoice, guess: WyrChoice): Promise<WyrOutcome>;
  reveal(seq: number): Promise<WyrOutcome>;
  openLightbox?(source: string, alt: string): void;
  /** Called after any change that may have altered the card's height. */
  afterChange(): void;
}

export interface WyrCards {
  /** Builds the card's container for a round-anchor message. */
  create(message: Message): HTMLElement;
  /** Re-draws the card inside `container` from the model's current state. */
  render(container: HTMLElement, message: Message): void;
}

/** How long a young round keeps showing "Painting…" before concluding the pictures are not
 * coming (the server's own generation budget is 300 s). */
const PAINT_WAIT_MS = 330_000;

const ERROR_TEXT: Record<string, string> = {
  not_found: "That round is gone.",
  full: "This round already has two players.",
  not_player: "You're not part of this round.",
  bad_state: "This round has moved on — refreshing.",
  unavailable: "Couldn't reach the server. Try again.",
};

function photoUrls(message: Message): (string | null)[] {
  return [0, 1].map((i) => {
    const attachment: Attachment | undefined = message.attachments[i];
    if (attachment === undefined || attachment.kind !== "photo") return null;
    return attachment.status === "ready"
      ? (attachment.urls.full ?? attachment.urls.thumb ?? null)
      : null;
  });
}

export function createWyrCards(deps: WyrCardDeps): WyrCards {
  const doc = deps.document;
  const errors = new Map<number, string>();
  const busy = new Set<number>();

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

  function button(label: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = el("button", className, label);
    b.type = "button";
    b.disabled = disabled;
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  function otherName(view: WyrView): string {
    const me = view.you?.slot;
    const other = view.players.find((_, i) => me !== undefined && i + 1 !== me);
    return other?.name ?? "the other person";
  }

  function run(seq: number, action: () => Promise<WyrOutcome>, container: HTMLElement, message: Message): void {
    if (busy.has(seq)) return;
    busy.add(seq);
    errors.delete(seq);
    render(container, message);
    void action()
      .then((outcome) => {
        if (outcome.ok) {
          deps.model.apply(outcome.view);
        } else {
          errors.set(seq, ERROR_TEXT[outcome.kind] ?? ERROR_TEXT["unavailable"] ?? "");
        }
      })
      .catch(() => {
        errors.set(seq, ERROR_TEXT["unavailable"] ?? "");
      })
      .finally(() => {
        busy.delete(seq);
        render(container, message);
        deps.afterChange();
      });
  }

  function tile(
    view: WyrView,
    which: WyrChoice,
    url: string | null,
    frame: "loading" | "none",
    mark: "none" | "mine" | "theirs" | "both",
  ): HTMLElement {
    const label = which === "a" ? view.question.a : view.question.b;
    const figure = el("div", `wx-srv-wyr-tile${mark === "none" ? "" : ` wx-srv-wyr-tile-${mark}`}`);
    const frameEl = el("div", "wx-srv-wyr-frame");
    if (url === null && frame === "none") {
      // Text-only round (no pictures are painted here, or this one never arrived): the label
      // alone, no empty square.
      figure.appendChild(el("div", "wx-srv-wyr-label", label));
      return figure;
    }
    if (url !== null) {
      const img = doc.createElement("img");
      img.className = "wx-srv-wyr-img";
      img.src = url;
      img.alt = label;
      img.loading = "lazy";
      if (deps.openLightbox !== undefined) {
        const open = deps.openLightbox;
        img.addEventListener("click", () => open(url, label));
      }
      frameEl.appendChild(img);
    } else {
      frameEl.classList.add("wx-srv-wyr-frame-loading");
      frameEl.appendChild(el("span", "wx-srv-wyr-frame-note", "Painting\u2026"));
    }
    figure.appendChild(frameEl);
    figure.appendChild(el("div", "wx-srv-wyr-label", label));
    return figure;
  }

  function optionButton(
    group: HTMLElement,
    view: WyrView,
    seq: number,
    kind: "choice" | "guess",
    disabled: boolean,
    container: HTMLElement,
    message: Message,
  ): void {
    const current = deps.model.draft(seq)[kind];
    for (const which of ["a", "b"] as const) {
      const text = which === "a" ? view.question.a : view.question.b;
      const b = button(
        text,
        `wx-srv-wyr-option${current === which ? " wx-srv-wyr-option-on" : ""}`,
        () => {
          deps.model.setDraft(seq, { [kind]: which });
          render(container, message);
          deps.afterChange();
        },
        disabled,
      );
      b.setAttribute("aria-pressed", current === which ? "true" : "false");
      group.appendChild(b);
    }
  }

  function render(container: HTMLElement, message: Message): void {
    const seq = message.seq;
    const view = deps.model.view(seq);
    container.replaceChildren();
    container.dataset["wyrSeq"] = String(seq);

    const summary = message.wyr ?? null;
    if (view === undefined) {
      container.appendChild(
        el(
          "p",
          "wx-srv-wyr-status",
          summary?.state === "skipped" ? "Skipped." : "Would you rather… loading",
        ),
      );
      return;
    }
    container.dataset["wyrState"] = view.state;
    const me = deps.viewer();
    const busyNow = busy.has(seq);
    const urls: (string | null)[] = photoUrls(message).map((u) => u ?? null);
    const urlA = urls[0] ?? null;
    const urlB = urls[1] ?? null;
    // Wait for pictures only when this server paints them, the round is still young (a
    // generation that failed leaves none behind), and the round is not already skipped.
    const youngMs = Date.now() - message.createdAt * 1000;
    const waiting: "loading" | "none" =
      view.images && view.state !== "skipped" && youngMs < PAINT_WAIT_MS ? "loading" : "none";

    container.appendChild(el("div", "wx-srv-wyr-title", "Would you rather…?"));

    if (view.state === "skipped") {
      const skipped = el("div", "wx-srv-wyr-pair wx-srv-wyr-pair-muted");
      skipped.append(tile(view, "a", urlA, "none", "none"), tile(view, "b", urlB, "none", "none"));
      container.appendChild(skipped);
      container.appendChild(
        el("p", "wx-srv-wyr-status", "Skipped — start another from the ⋯ menu."),
      );
      return;
    }

    const resultPlayers = view.result?.players;
    const pair = el("div", "wx-srv-wyr-pair");
    for (const which of ["a", "b"] as const) {
      let mark: "none" | "mine" | "theirs" | "both" = "none";
      if (view.result !== null && resultPlayers !== undefined && view.you !== null) {
        const mineIdx = view.you.slot - 1;
        const mine = resultPlayers[mineIdx]?.choice === which;
        const theirs = resultPlayers[1 - mineIdx]?.choice === which;
        mark = mine && theirs ? "both" : mine ? "mine" : theirs ? "theirs" : "none";
      }
      pair.appendChild(tile(view, which, which === "a" ? urlA : urlB, waiting, mark));
    }
    container.appendChild(pair);

    const you = view.you;
    const section = el("div", "wx-srv-wyr-actions");

    if (view.state === "voting") {
      const joined = view.players[0];
      if (you === null) {
        section.appendChild(
          el("p", "wx-srv-wyr-status", `${joined?.name ?? "Someone"} wants to play. Join in?`),
        );
        const row = el("div", "wx-srv-wyr-row");
        row.append(
          button("Play", "wx-srv-wyr-primary", () => run(seq, () => deps.vote(seq, "play"), container, message), busyNow || me === null),
          button("Skip", "wx-srv-wyr-secondary", () => run(seq, () => deps.vote(seq, "skip"), container, message), busyNow || me === null),
        );
        section.appendChild(row);
      } else {
        section.appendChild(el("p", "wx-srv-wyr-status", "Waiting for the other person to play…"));
        section.appendChild(
          button("Skip", "wx-srv-wyr-secondary", () => run(seq, () => deps.vote(seq, "skip"), container, message), busyNow),
        );
      }
    } else if (view.state === "answering") {
      if (you === null) {
        section.appendChild(el("p", "wx-srv-wyr-status", "Two people are playing this one."));
      } else if (you.choice !== null && you.guess !== null) {
        section.appendChild(el("p", "wx-srv-wyr-status", "Your answer is in. Waiting for the other person…"));
      } else {
        const draft = deps.model.draft(seq);
        const other = otherName(view);
        section.appendChild(el("div", "wx-srv-wyr-question", "Which would YOU rather?"));
        const mine = el("div", "wx-srv-wyr-group");
        optionButton(mine, view, seq, "choice", busyNow, container, message);
        section.appendChild(mine);
        section.appendChild(el("div", "wx-srv-wyr-question", `Which will ${other} pick?`));
        const theirs = el("div", "wx-srv-wyr-group");
        optionButton(theirs, view, seq, "guess", busyNow, container, message);
        section.appendChild(theirs);
        const ready = draft.choice !== null && draft.guess !== null;
        section.appendChild(
          button(
            "Send my answer",
            "wx-srv-wyr-primary",
            () => {
              if (draft.choice === null || draft.guess === null) return;
              const { choice, guess } = draft;
              run(seq, () => deps.answer(seq, choice, guess), container, message);
            },
            !ready || busyNow,
          ),
        );
      }
    } else if (view.state === "revealing") {
      if (you === null) {
        section.appendChild(el("p", "wx-srv-wyr-status", "Both have answered — waiting for the reveal."));
      } else if (you.revealed) {
        section.appendChild(
          el("p", "wx-srv-wyr-status", `Waiting for ${otherName(view)} to press Reveal…`),
        );
      } else {
        section.appendChild(el("p", "wx-srv-wyr-status", "Both answered! Press Reveal — the answers show once you've both pressed it."));
        section.appendChild(
          button("Reveal", "wx-srv-wyr-primary", () => run(seq, () => deps.reveal(seq), container, message), busyNow),
        );
      }
    } else if (view.state === "revealed" && view.result !== null) {
      const result = view.result;
      const list = el("div", "wx-srv-wyr-results");
      result.players.forEach((player, index) => {
        const isMe = view.you?.slot === index + 1;
        const other = result.players[1 - index];
        const pickText = player.choice === "a" ? view.question.a : view.question.b;
        const guessText = player.guess === "a" ? view.question.a : view.question.b;
        const right = result.guessed[index] === true;
        const row = el("div", "wx-srv-wyr-result");
        row.appendChild(el("div", "wx-srv-wyr-result-name", isMe ? "You" : player.name));
        row.appendChild(el("div", "wx-srv-wyr-result-line", `Picked: ${pickText}`));
        row.appendChild(
          el(
            "div",
            `wx-srv-wyr-result-line ${right ? "wx-srv-wyr-right" : "wx-srv-wyr-wrong"}`,
            `${isMe ? "You" : player.name} guessed ${other?.name ?? "them"} would pick: ${guessText} ${right ? "✓" : "✗"}`,
          ),
        );
        list.appendChild(row);
      });
      section.appendChild(list);
      const both = result.guessed[0] === true && result.guessed[1] === true;
      const headline = both
        ? "You read each other’s minds!"
        : result.agree
          ? "You both picked the same one."
          : "You picked differently.";
      section.appendChild(el("p", "wx-srv-wyr-headline", headline));
    }

    const error = errors.get(seq);
    if (error !== undefined && error !== "") {
      const line = el("p", "wx-srv-wyr-error", error);
      line.setAttribute("role", "status");
      section.appendChild(line);
    }
    container.appendChild(section);
  }

  return {
    create(message) {
      const container = el("div", "wx-srv-wyr-card");
      render(container, message);
      return container;
    },
    render,
  };
}
