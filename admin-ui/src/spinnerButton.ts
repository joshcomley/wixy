// Busy/idle button content with the shared `.wx-spinner` (decisions/00089) —
// one helper so the status bar's Publish button and the publish drawer's
// confirm button render the exact same in-progress affordance: spinner + label
// at full opacity (a dim, static disabled button reads as "broken" on a phone
// while a 30-60s publish runs).

export function setButtonBusy(button: HTMLButtonElement, label: string): void {
  button.classList.add("wx-button-busy");
  button.textContent = "";
  const spinner = document.createElement("span");
  spinner.className = "wx-spinner";
  spinner.setAttribute("aria-hidden", "true");
  button.append(spinner, document.createTextNode(label));
}

export function setButtonIdle(button: HTMLButtonElement, label: string): void {
  button.classList.remove("wx-button-busy");
  button.textContent = label;
}
