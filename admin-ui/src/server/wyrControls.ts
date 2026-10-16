// The would-you-rather game's controls (workspace 00045): the state-specific part of a round —
// Play/Skip, "which would YOU rather / which will <other> pick", Reveal, and the revealed
// results. Shared by the game tab; the thread's preview card only shows `statusLine`. It draws
// from the pure `WyrModel` (latest viewer-filtered view + the unsent picks), never from the wire.

import type { WyrChoice, WyrOutcome, WyrVote, WyrView } from "./api/wyr";
import type { WyrModel } from "./wyrModel";

export interface WyrControlsDeps {
  readonly model: WyrModel;
  readonly document: Document;
  /** My display name (null before one is set — the controls then offer nothing). */
  viewer(): string | null;
  vote(seq: number, vote: WyrVote): Promise<WyrOutcome>;
  answer(seq: number, choice: WyrChoice, guess: WyrChoice): Promise<WyrOutcome>;
  reveal(seq: number): Promise<WyrOutcome>;
  /** The controls for `seq` changed (busy/error/draft) and should be redrawn. */
  redraw(seq: number): void;
  /** Called after any change that may have altered the layout's height. */
  afterChange(): void;
}

export interface WyrControls {
  /** Re-draws the controls for `view` into `container`. */
  render(container: HTMLElement, seq: number, view: WyrView): void;
}

const ERROR_TEXT: Record<string, string> = {
  not_found: "That round is gone.",
  full: "This round already has two players.",
  not_player: "You're not part of this round.",
  bad_state: "This round has moved on — refreshing.",
  unavailable: "Couldn't reach the server. Try again.",
};

function otherName(view: WyrView): string {
  const me = view.you?.slot;
  const other = view.players.find((_, i) => me !== undefined && i + 1 !== me);
  return other?.name ?? "the other person";
}

/** One plain-English line for a round's state, from the viewer's side. The thread's preview
 * card shows it; the game tab's controls say the same thing in their own wording. */
export function wyrStatusLine(view: WyrView): string {
  const you = view.you;
  switch (view.state) {
    case "voting": {
      if (you === null) return `${view.players[0]?.name ?? "Someone"} wants to play.`;
      return "Waiting for the other person to play…";
    }
    case "answering": {
      if (you === null) return "Two people are playing this one.";
      if (you.choice !== null && you.guess !== null) return "Your answer is in. Waiting for the other person…";
      return "Pick yours, and guess theirs.";
    }
    case "revealing": {
      if (you === null) return "Both answered — waiting for the reveal.";
      if (you.revealed) return `Waiting for ${otherName(view)} to press Reveal…`;
      return "Both answered! Press Reveal.";
    }
    case "revealed": {
      const result = view.result;
      if (result === null) return "Revealed.";
      const both = result.guessed[0] === true && result.guessed[1] === true;
      return both
        ? "You read each other’s minds!"
        : result.agree
          ? "You both picked the same one."
          : "You picked differently.";
    }
    case "skipped":
      return "Skipped.";
  }
}

export function createWyrControls(deps: WyrControlsDeps): WyrControls {
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

  function run(seq: number, action: () => Promise<WyrOutcome>): void {
    if (busy.has(seq)) return;
    busy.add(seq);
    errors.delete(seq);
    deps.redraw(seq);
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
        deps.redraw(seq);
        deps.afterChange();
      });
  }

  /** A two-button segmented choice: option A / option B, the current draft highlighted. */
  function segmented(
    seq: number,
    view: WyrView,
    kind: "choice" | "guess",
    disabled: boolean,
  ): HTMLElement {
    const group = el("div", "wx-srv-wyr-group");
    const current = deps.model.draft(seq)[kind];
    for (const which of ["a", "b"] as const) {
      const text = which === "a" ? view.question.a : view.question.b;
      const b = button(
        text,
        `wx-srv-wyr-option${current === which ? " wx-srv-wyr-option-on" : ""}`,
        () => {
          deps.model.setDraft(seq, { [kind]: which });
          deps.redraw(seq);
          deps.afterChange();
        },
        disabled,
      );
      b.setAttribute("aria-pressed", current === which ? "true" : "false");
      group.appendChild(b);
    }
    return group;
  }

  function render(container: HTMLElement, seq: number, view: WyrView): void {
    container.replaceChildren();
    container.dataset["wyrState"] = view.state;
    const me = deps.viewer();
    const busyNow = busy.has(seq);
    const you = view.you;

    if (view.state === "skipped") {
      container.appendChild(el("p", "wx-srv-wyr-status", "Skipped."));
    } else if (view.state === "voting") {
      if (you === null) {
        container.appendChild(el("p", "wx-srv-wyr-status", `${view.players[0]?.name ?? "Someone"} wants to play. Join in?`));
        const row = el("div", "wx-srv-wyr-row");
        row.append(
          button("Play", "wx-srv-wyr-primary", () => run(seq, () => deps.vote(seq, "play")), busyNow || me === null),
          button("Skip", "wx-srv-wyr-secondary", () => run(seq, () => deps.vote(seq, "skip")), busyNow || me === null),
        );
        container.appendChild(row);
      } else {
        container.appendChild(el("p", "wx-srv-wyr-status", "Waiting for the other person to play…"));
        container.appendChild(
          button("Skip", "wx-srv-wyr-secondary", () => run(seq, () => deps.vote(seq, "skip")), busyNow),
        );
      }
    } else if (view.state === "answering") {
      if (you === null) {
        container.appendChild(el("p", "wx-srv-wyr-status", "Two people are playing this one."));
      } else if (you.choice !== null && you.guess !== null) {
        container.appendChild(el("p", "wx-srv-wyr-status", "Your answer is in. Waiting for the other person…"));
      } else {
        const draft = deps.model.draft(seq);
        container.appendChild(el("div", "wx-srv-wyr-question", "Which would YOU rather?"));
        container.appendChild(segmented(seq, view, "choice", busyNow));
        container.appendChild(el("div", "wx-srv-wyr-question", `Which will ${otherName(view)} pick?`));
        container.appendChild(segmented(seq, view, "guess", busyNow));
        const ready = draft.choice !== null && draft.guess !== null;
        container.appendChild(
          button(
            "Send my answer",
            "wx-srv-wyr-primary",
            () => {
              if (draft.choice === null || draft.guess === null) return;
              const { choice, guess } = draft;
              run(seq, () => deps.answer(seq, choice, guess));
            },
            !ready || busyNow,
          ),
        );
      }
    } else if (view.state === "revealing") {
      if (you === null) {
        container.appendChild(el("p", "wx-srv-wyr-status", "Both have answered — waiting for the reveal."));
      } else if (you.revealed) {
        container.appendChild(el("p", "wx-srv-wyr-status", `Waiting for ${otherName(view)} to press Reveal…`));
      } else {
        container.appendChild(
          el("p", "wx-srv-wyr-status", "Both answered! Press Reveal — the answers show once you've both pressed it."),
        );
        container.appendChild(
          button("Reveal", "wx-srv-wyr-primary", () => run(seq, () => deps.reveal(seq)), busyNow),
        );
      }
    } else if (view.state === "revealed" && view.result !== null) {
      const result = view.result;
      const list = el("div", "wx-srv-wyr-results");
      result.players.forEach((player, index) => {
        const isMe = you?.slot === index + 1;
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
      container.appendChild(list);
      container.appendChild(el("p", "wx-srv-wyr-headline", wyrStatusLine(view)));
    }

    const error = errors.get(seq);
    if (error !== undefined && error !== "") {
      const line = el("p", "wx-srv-wyr-error", error);
      line.setAttribute("role", "status");
      container.appendChild(line);
    }
  }

  return { render };
}
