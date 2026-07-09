// The page settings drawer (spec/05-editor.md §2): "meta.* editing (title,
// description, ogImage via media dialog, nav fields)."
//
// The ogImage field opens the SHARED `mediaDialog.ts` component (spec/05 §4: "the
// SAME component renders as a modal dialog when invoked from the editor") — this
// replaces the milestone-7-era minimal inline pick-from-existing-repo-media list
// (decisions/00018 decision 9 flagged that as a real-but-minimal stand-in meant to
// be extended here, not permanent). The dialog's own alt-text step covers both
// picking AND (re-)setting alt text, so there's no separate inline alt input here.

import type { AdminApi } from "./api";
import type { OpQueueLike } from "./editView";
import { openMediaDialog } from "./mediaDialog";
import type { JsonValue } from "./protocol";

export interface PageSettingsDeps {
  api: AdminApi;
  opQueue: OpQueueLike;
  onClose: () => void;
}

interface Meta {
  title: string;
  description: string;
  ogImage: { src: string; alt: string } | null;
  navLabel: string;
  inNav: boolean;
  navOrder: number;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function readMeta(content: Record<string, JsonValue>): Meta {
  const meta = asObject(content["meta"]);
  const ogImageRaw = asObject(meta["ogImage"]);
  const hasOgImage = meta["ogImage"] !== undefined && meta["ogImage"] !== null;
  return {
    title: typeof meta["title"] === "string" ? meta["title"] : "",
    description: typeof meta["description"] === "string" ? meta["description"] : "",
    ogImage: hasOgImage
      ? {
          src: typeof ogImageRaw["src"] === "string" ? ogImageRaw["src"] : "",
          alt: typeof ogImageRaw["alt"] === "string" ? ogImageRaw["alt"] : "",
        }
      : null,
    navLabel: typeof meta["navLabel"] === "string" ? meta["navLabel"] : "",
    inNav: meta["inNav"] === true,
    navOrder: typeof meta["navOrder"] === "number" ? meta["navOrder"] : 0,
  };
}

export interface PageSettingsDrawer {
  element: HTMLElement;
  teardown(): void;
}

export function mountPageSettingsDrawer(page: string, deps: PageSettingsDeps): PageSettingsDrawer {
  const root = document.createElement("div");
  root.className = "wx-drawer";

  const header = document.createElement("div");
  header.className = "wx-drawer-header";
  const heading = document.createElement("h3");
  heading.textContent = "Page settings";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wx-drawer-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", () => deps.onClose());
  header.append(heading, closeButton);
  root.appendChild(header);

  const body = document.createElement("div");
  body.className = "wx-drawer-body";
  body.textContent = "Loading…";
  root.appendChild(body);

  function commit(path: string, value: JsonValue): void {
    deps.opQueue.enqueue({ file: page, path: `meta.${path}`, value });
  }

  function fieldRow(labelText: string, input: HTMLElement): HTMLElement {
    const row = document.createElement("label");
    row.className = "wx-field-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    row.append(label, input);
    return row;
  }

  function textField(
    labelText: string,
    path: string,
    initial: string,
    multiline = false,
  ): HTMLElement {
    const input: HTMLInputElement | HTMLTextAreaElement = multiline
      ? document.createElement("textarea")
      : document.createElement("input");
    if (input instanceof HTMLInputElement) input.type = "text";
    input.value = initial;
    input.addEventListener("change", () => commit(path, input.value));
    return fieldRow(labelText, input);
  }

  function checkboxField(labelText: string, path: string, initial: boolean): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = initial;
    input.addEventListener("change", () => commit(path, input.checked));
    const row = document.createElement("label");
    row.className = "wx-field-row wx-field-row-checkbox";
    row.append(input, document.createTextNode(labelText));
    return row;
  }

  function numberField(labelText: string, path: string, initial: number): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(initial);
    input.addEventListener("change", () => {
      const parsed = Number(input.value);
      commit(path, Number.isFinite(parsed) ? parsed : 0);
    });
    return fieldRow(labelText, input);
  }

  function ogImageField(meta: Meta): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "wx-field-row wx-og-image";
    const label = document.createElement("span");
    label.textContent = "Social image";
    wrap.appendChild(label);

    const preview = document.createElement("div");
    preview.className = "wx-og-image-preview";
    let current = meta.ogImage;
    function renderPreview(): void {
      preview.innerHTML = "";
      if (current !== null) {
        const img = document.createElement("img");
        img.src = current.src;
        img.alt = current.alt;
        preview.appendChild(img);
      } else {
        const empty = document.createElement("span");
        empty.className = "wx-og-image-empty";
        empty.textContent = "No image selected";
        preview.appendChild(empty);
      }
    }
    renderPreview();
    wrap.appendChild(preview);

    const pickButton = document.createElement("button");
    pickButton.type = "button";
    pickButton.textContent = "Choose image";
    pickButton.addEventListener("click", () => {
      openMediaDialog({ api: deps.api }, (value) => {
        if (value === null) return;
        current = value;
        renderPreview();
        commit("ogImage", { src: value.src, alt: value.alt });
      });
    });
    wrap.appendChild(pickButton);

    return wrap;
  }

  let cancelled = false;
  deps.api
    .getContent(page)
    .then((response) => {
      if (cancelled) return;
      const meta = readMeta(response.content);
      body.innerHTML = "";
      body.append(
        textField("Title", "title", meta.title),
        textField("Description", "description", meta.description, true),
        ogImageField(meta),
        textField("Nav label", "navLabel", meta.navLabel),
        checkboxField("Show in navigation", "inNav", meta.inNav),
        numberField("Nav order", "navOrder", meta.navOrder),
      );
    })
    .catch(() => {
      if (cancelled) return;
      body.textContent = "Couldn't load page settings.";
    });

  return {
    element: root,
    teardown(): void {
      cancelled = true;
    },
  };
}
