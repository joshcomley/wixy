/** A countdown bar driven by the WYR server's absolute Reveal deadline. */
export function createWyrCountdown(
  doc: Document,
  deadline: number,
  label: string,
  onActivate?: () => void,
  onExpire?: () => void,
): HTMLElement {
  const interactive = onActivate !== undefined;
  const root = doc.createElement(interactive ? "button" : "div");
  root.className = "wx-srv-wyr-countdown";
  root.setAttribute("data-srv-gesture-boundary", "");
  if (interactive) {
    (root as HTMLButtonElement).type = "button";
    root.addEventListener("click", () => onActivate?.());
  } else {
    root.setAttribute("role", "status");
  }
  const text = doc.createElement("span");
  text.className = "wx-srv-wyr-countdown-label";
  const track = doc.createElement("span");
  track.className = "wx-srv-wyr-countdown-track";
  const fill = doc.createElement("span");
  fill.className = "wx-srv-wyr-countdown-fill";
  track.appendChild(fill);
  root.append(text, track);

  let shownSeconds = -1;
  let timer: number | null = null;
  let expired = false;
  const update = (): void => {
    if (timer !== null && !root.isConnected) {
      doc.defaultView?.clearInterval(timer);
      timer = null;
      return;
    }
    const remaining = Math.max(0, deadline - Date.now() / 1000);
    const seconds = Math.ceil(remaining);
    if (seconds !== shownSeconds) {
      shownSeconds = seconds;
      text.textContent = `${label} · ${seconds}s`;
    }
    fill.style.transform = `scaleX(${Math.min(1, remaining / 30)})`;
    if (remaining === 0 && !expired) {
      expired = true;
      if (timer !== null) doc.defaultView?.clearInterval(timer);
      root.remove();
      onExpire?.();
    }
  };

  update();
  if (!expired && doc.defaultView !== null) {
    timer = doc.defaultView.setInterval(update, 100);
  }
  return root;
}
