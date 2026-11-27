// Entry point of the public Adventure Time page (spec/adventure-public section 2.4): esbuild bundles this
// to `wixy_server/static/adventure-public/app.js` (+ `app.css`). The server's shell carries the boot JSON
// in `#adventure-public-boot` and an empty `#adventure-public-root` to mount into.

import { mountPublicApp } from "./app";
import { BOOT_ELEMENT_ID, ROOT_ELEMENT_ID, readBoot } from "./boot";

function start(): void {
  const root = document.getElementById(ROOT_ELEMENT_ID);
  if (root === null) return;
  const boot = readBoot(document, window.location.origin);
  if (boot === null) {
    const message = document.createElement("p");
    message.className = "adv-pub-fatal";
    message.setAttribute("role", "alert");
    message.textContent = `Adventure Time couldn't start (the page is missing its #${BOOT_ELEMENT_ID} data). Try reloading.`;
    root.replaceChildren(message);
    return;
  }
  mountPublicApp({ document, win: window, root, boot, fetch: (input, init) => window.fetch(input, init) });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
