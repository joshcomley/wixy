// Structured controls for well-known content shapes (decisions/00077) —
// opened instead of the composer when a clicked text binding's element carries
// `data-wx-control="<name>"` in the SITE template (a declarative hint that
// flows through the build like every other data-wx-* attribute; the engine
// reads it straight off the element at click time).
//
// The hours/price controls are bottom sheets matching the composer's look, and
// all controls keep the operator's escape hatch: free text always remains
// possible ("she can still put her own text in there, just like now").
//
// - "opening-hours": edits the WHOLE hours array at once (7 day rows, each
//   open/closed + from/to times OR a free-text value), emitting one op for the
//   list key. Clicking any value inside the list opens it.
// - "price": edits one price text as {label, amount} rows (parsed on the
//   em-dash and middle-dot separators); unparseable text drops to free-text
//   mode rather than ever trapping the user in a structure that doesn't fit.
// - "qa": edits the WHOLE Q&A array (rows of question input + answer
//   textarea, add/remove row) in a FULL-SCREEN surface (decisions/00090) —
//   a FAQ list is long-form content that outgrows a bottom sheet fast.

export interface ControlCallbacks<T> {
  onCommit: (value: T) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// opening-hours
// ---------------------------------------------------------------------------

export interface HoursRow {
  day: string;
  value: string;
  closed: boolean;
}

const TIME_PAIR_RE = /^\s*(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})\s*$/;

/** "10:00 – 19:00" → {from,to}; anything else (e.g. "By phone enquiry") →
 * null, meaning the row edits as free text. */
export function parseHoursValue(value: string): { from: string; to: string } | null {
  const match = TIME_PAIR_RE.exec(value);
  return match === null ? null : { from: match[1] ?? "", to: match[2] ?? "" };
}

export function serializeHoursValue(from: string, to: string): string {
  return `${from} – ${to}`;
}

function sheetShell(title: string): {
  root: HTMLDivElement;
  body: HTMLDivElement;
  commitBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
} {
  const root = document.createElement("div");
  root.className = "wx-composer wx-control-sheet";
  const inner = document.createElement("div");
  inner.className = "wx-composer-inner";
  root.appendChild(inner);

  const toolbar = document.createElement("div");
  toolbar.className = "wx-composer-toolbar";
  const titleEl = document.createElement("span");
  titleEl.className = "wx-control-title";
  titleEl.textContent = title;
  const spacer = document.createElement("span");
  spacer.className = "wx-composer-spacer";
  const commitBtn = document.createElement("button");
  commitBtn.type = "button";
  commitBtn.className = "wx-composer-commit wx-control-commit";
  commitBtn.textContent = "✓";
  commitBtn.title = "Save";
  commitBtn.setAttribute("aria-label", "Save");
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "wx-composer-cancel";
  cancelBtn.textContent = "✕";
  cancelBtn.title = "Cancel";
  cancelBtn.setAttribute("aria-label", "Cancel");
  toolbar.append(titleEl, spacer, commitBtn, cancelBtn);

  const body = document.createElement("div");
  body.className = "wx-control-body";
  inner.append(toolbar, body);
  return { root, body, commitBtn, cancelBtn };
}

function rowEl(...children: HTMLElement[]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "wx-control-row";
  row.append(...children);
  return row;
}

function labeledInput(
  className: string,
  value: string,
  placeholder = "",
  type = "text",
): HTMLInputElement {
  const input = document.createElement("input");
  input.className = className;
  input.value = value;
  input.placeholder = placeholder;
  input.type = type;
  return input;
}

/** Build the opening-hours sheet. Rows arrive in the list's stored order
 * (Monday..Sunday for ca, but the control doesn't hardcode days). */
export function buildHoursControl(
  items: HoursRow[],
  callbacks: ControlCallbacks<HoursRow[]>,
): HTMLElement {
  const { root, body, commitBtn, cancelBtn } = sheetShell("Opening hours");

  interface RowRefs {
    day: string;
    from: HTMLInputElement;
    to: HTMLInputElement;
    text: HTMLInputElement;
    closed: HTMLInputElement;
    custom: HTMLInputElement;
  }
  const rows: RowRefs[] = [];

  items.forEach((item) => {
    const times = parseHoursValue(item.value);

    const dayLabel = document.createElement("span");
    dayLabel.className = "wx-control-day";
    dayLabel.textContent = item.day;

    const from = labeledInput("wx-control-time", times?.from ?? "10:00", "", "time");
    const to = labeledInput("wx-control-time", times?.to ?? "17:00", "", "time");
    const text = labeledInput("wx-control-text", times === null ? item.value : "", "Custom text");
    text.hidden = times !== null;

    const closed = document.createElement("input");
    closed.type = "checkbox";
    closed.className = "wx-control-closed";
    closed.checked = item.closed;
    closed.title = "Closed this day";
    closed.setAttribute("aria-label", `${item.day} closed`);
    const closedLabel = document.createElement("label");
    closedLabel.className = "wx-control-check";
    const closedText = document.createElement("span");
    closedText.textContent = "closed";
    closedLabel.append(closed, closedText);

    const custom = document.createElement("input");
    custom.type = "checkbox";
    custom.className = "wx-control-custom";
    custom.checked = times === null;
    custom.title = "Free text instead of times";
    custom.setAttribute("aria-label", `${item.day} free text`);
    const customLabel = document.createElement("label");
    customLabel.className = "wx-control-check";
    const customText = document.createElement("span");
    customText.textContent = "text";
    customLabel.append(custom, customText);

    from.hidden = to.hidden = custom.checked;
    custom.addEventListener("change", () => {
      from.hidden = to.hidden = custom.checked;
      text.hidden = !custom.checked;
    });

    rows.push({ day: item.day, from, to, text, closed, custom });
    body.appendChild(rowEl(dayLabel, closedLabel, customLabel, from, to, text));
  });

  commitBtn.addEventListener("click", () => {
    callbacks.onCommit(
      rows.map((row) => ({
        day: row.day,
        closed: row.closed.checked,
        value: row.custom.checked
          ? row.text.value
          : serializeHoursValue(row.from.value, row.to.value),
      })),
    );
  });
  cancelBtn.addEventListener("click", callbacks.onCancel);
  return root;
}

// ---------------------------------------------------------------------------
// price
// ---------------------------------------------------------------------------

export interface PriceEntry {
  label: string;
  amount: string;
}

/** "Full Face — £330 · Three Areas — £220" → [{label, amount}×2]. Separators:
 * em/en dash between label and amount, middle dot between entries (whitespace
 * around both is trimmed, so the nbsp house style parses the same as spaces).
 * null when ANY segment doesn't fit (→ free-text mode). */
export function parsePriceList(text: string): PriceEntry[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const entries: PriceEntry[] = [];
  for (const segment of trimmed.split("·")) {
    const match = /^\s*(.+?)\s+[–—]\s+(.+?)\s*$/.exec(segment);
    if (match === null) return null;
    entries.push({ label: match[1] ?? "", amount: match[2] ?? "" });
  }
  return entries;
}

/** House style: entries joined by nbsp·nbsp, em-dash between label and amount
 * (matches the ca corpus's existing typography, and the write-time sanitize
 * stores it canonically). */
export function serializePriceList(entries: PriceEntry[]): string {
  return entries
    .filter((entry) => entry.label.trim() !== "" || entry.amount.trim() !== "")
    .map((entry) => `${entry.label.trim()} — ${entry.amount.trim()}`)
    .join(" · ");
}

/** Build the price-list sheet for one price text. `freeText: true` forces
 * free-text mode from the start (unparseable source). */
export function buildPriceControl(
  current: string,
  callbacks: ControlCallbacks<string>,
): HTMLElement {
  const { root, body, commitBtn, cancelBtn } = sheetShell("Edit price");

  const parsed = parsePriceList(current);

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "wx-price-rows";

  const textArea = document.createElement("textarea");
  textArea.className = "wx-composer-input wx-price-freetext";
  textArea.rows = 3;
  textArea.value = current;

  const modeToggle = document.createElement("button");
  modeToggle.type = "button";
  modeToggle.className = "wx-control-mode-toggle";

  interface RowRefs {
    label: HTMLInputElement;
    amount: HTMLInputElement;
    row: HTMLDivElement;
  }
  const rows: RowRefs[] = [];

  function addRow(label = "", amount = ""): void {
    const labelInput = labeledInput("wx-price-label", label, "Treatment");
    const amountInput = labeledInput("wx-price-amount", amount, "£00");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "wx-price-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove row";
    removeBtn.setAttribute("aria-label", "Remove row");
    const row = rowEl(labelInput, amountInput, removeBtn);
    rows.push({ label: labelInput, amount: amountInput, row });
    removeBtn.addEventListener("click", () => {
      const index = rows.findIndex((r) => r.row === row);
      if (index !== -1) rows.splice(index, 1);
      row.remove();
    });
    rowsWrap.appendChild(row);
  }

  let freeTextMode = parsed === null;

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "wx-price-add";
  addBtn.textContent = "+ Add row";
  addBtn.addEventListener("click", () => addRow());

  function renderMode(): void {
    rowsWrap.hidden = addBtn.hidden = freeTextMode;
    textArea.hidden = !freeTextMode;
    modeToggle.textContent = freeTextMode ? "Edit as rows" : "Edit as plain text";
  }
  modeToggle.addEventListener("click", () => {
    if (freeTextMode) {
      // rows → try to re-parse whatever the user typed; stay in text mode if
      // it still doesn't fit (nothing is lost either way — both modes commit).
      const reparsed = parsePriceList(textArea.value);
      if (reparsed === null) return;
      rows.splice(0, rows.length);
      rowsWrap.innerHTML = "";
      reparsed.forEach((entry) => addRow(entry.label, entry.amount));
      freeTextMode = false;
    } else {
      textArea.value = serializePriceList(
        rows.map((r) => ({ label: r.label.value, amount: r.amount.value })),
      );
      freeTextMode = true;
    }
    renderMode();
  });

  if (parsed !== null) {
    parsed.forEach((entry) => addRow(entry.label, entry.amount));
  }
  body.append(modeToggle, rowsWrap, addBtn, textArea);
  renderMode();

  commitBtn.addEventListener("click", () => {
    callbacks.onCommit(
      freeTextMode
        ? textArea.value
        : serializePriceList(rows.map((r) => ({ label: r.label.value, amount: r.amount.value }))),
    );
  });
  cancelBtn.addEventListener("click", callbacks.onCancel);
  return root;
}

// ---------------------------------------------------------------------------
// qa (full-screen — decisions/00090)
// ---------------------------------------------------------------------------

export interface QaItem {
  question: string;
  answer: string;
}

/** Build the full-screen Q&A editor for a `data-wx-control="qa"` list: one
 * card per question/answer pair (an input for the question, a textarea for
 * the answer — answers are the long form), "+ Add question", per-card remove.
 * The item shape ({question, answer}) is the control's contract, exactly like
 * the hours control's {day, value, closed}; commit emits the whole array in
 * row order, dropping pairs where BOTH fields were left blank (the price
 * control's blank-row rule — an accidentally added empty row mustn't become
 * an empty FAQ entry on the site). */
export function buildQaControl(
  items: QaItem[],
  callbacks: ControlCallbacks<QaItem[]>,
): HTMLElement {
  const { root, body, commitBtn, cancelBtn } = sheetShell("Questions & answers");
  root.classList.add("wx-control-fullscreen");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "wx-qa-add";
  addBtn.textContent = "+ Add question";
  body.appendChild(addBtn);

  interface RowRefs {
    question: HTMLInputElement;
    answer: HTMLTextAreaElement;
    row: HTMLDivElement;
  }
  const rows: RowRefs[] = [];

  function renumber(): void {
    rows.forEach((refs, index) => {
      const number = refs.row.querySelector(".wx-qa-number");
      if (number !== null) number.textContent = `Q${index + 1}`;
    });
  }

  function addRow(question = "", answer = ""): void {
    const number = document.createElement("span");
    number.className = "wx-qa-number";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "wx-qa-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove this question";
    removeBtn.setAttribute("aria-label", "Remove this question");
    const head = document.createElement("div");
    head.className = "wx-qa-row-head";
    head.append(number, removeBtn);

    const questionInput = labeledInput("wx-qa-question", question, "Question");
    const answerArea = document.createElement("textarea");
    answerArea.className = "wx-qa-answer";
    answerArea.rows = 4;
    answerArea.value = answer;
    answerArea.placeholder = "Answer";

    const row = document.createElement("div");
    row.className = "wx-qa-row";
    row.append(head, questionInput, answerArea);

    const refs: RowRefs = { question: questionInput, answer: answerArea, row };
    rows.push(refs);
    removeBtn.addEventListener("click", () => {
      const index = rows.indexOf(refs);
      if (index !== -1) rows.splice(index, 1);
      row.remove();
      renumber();
    });
    body.insertBefore(row, addBtn);
    renumber();
  }

  addBtn.addEventListener("click", () => {
    addRow();
    // A freshly added row starts empty — put the caret straight in its
    // question field so keyboard flow isn't broken by the detour to the button.
    rows.at(-1)?.question.focus();
  });
  items.forEach((item) => addRow(item.question, item.answer));

  commitBtn.addEventListener("click", () => {
    callbacks.onCommit(
      rows
        .map((refs) => ({
          question: refs.question.value.trim(),
          answer: refs.answer.value.trim(),
        }))
        .filter((item) => item.question !== "" || item.answer !== ""),
    );
  });
  cancelBtn.addEventListener("click", callbacks.onCancel);
  return root;
}
