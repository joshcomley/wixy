// The guide's ONLY JavaScript (spec/independence/07 §1: "zero JS frameworks") —
// a plain, dependency-free copy-to-clipboard button for `.guide-copy-block`s.
// No framework, no build step: this file is served byte-for-byte as authored.
document.addEventListener("click", (event) => {
  const button = event.target.closest(".guide-copy-button");
  if (!button) return;
  const block = button.closest(".guide-copy-block");
  const text = block?.querySelector("code")?.textContent ?? "";
  navigator.clipboard.writeText(text).then(
    () => {
      const original = button.textContent;
      button.textContent = "Copied!";
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    },
    () => {
      button.textContent = "Couldn't copy — select manually";
    },
  );
});
