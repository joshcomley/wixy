// The page settings drawer (spec/05-editor.md §2): "meta.* editing (title,
// description, ogImage via media dialog, nav fields)."
//
// The ogImage picker here is a minimal pick-from-existing-repo-media list (using
// the already-built, list-only `GET /api/admin/media`, milestone 6) — the REAL
// upload-capable media dialog (drag-drop, references scan, staged-draft badge)
// is explicitly milestone 8's job (spec/05 §4); this is a real, working stand-in
// for "pick an existing image," not a placeholder.

import type { AdminApi } from "./api";
import type { OpQueueLike } from "./editView";
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
    let currentSrc = meta.ogImage?.src ?? "";
    function renderPreview(): void {
      preview.innerHTML = "";
      if (currentSrc !== "") {
        const img = document.createElement("img");
        img.src = currentSrc;
        img.alt = "";
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

    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.placeholder = "Alt text";
    altInput.value = meta.ogImage?.alt ?? "";
    altInput.addEventListener("change", () => {
      commit("ogImage", { src: currentSrc, alt: altInput.value });
    });
    wrap.appendChild(altInput);

    let openPickerList: HTMLElement | null = null;

    const pickButton = document.createElement("button");
    pickButton.type = "button";
    pickButton.textContent = "Choose image";
    pickButton.addEventListener("click", () => {
      if (openPickerList !== null) {
        openPickerList.remove();
        openPickerList = null;
        return;
      }
      void openPicker();
    });
    wrap.appendChild(pickButton);

    async function openPicker(): Promise<void> {
      const items = await deps.api.getMedia();
      const list = document.createElement("div");
      list.className = "wx-media-picker";
      for (const item of items) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "wx-media-picker-item";
        const thumb = document.createElement("img");
        thumb.src = item.url;
        thumb.alt = item.name;
        option.appendChild(thumb);
        option.addEventListener("click", () => {
          currentSrc = item.url;
          renderPreview();
          commit("ogImage", { src: currentSrc, alt: altInput.value });
          list.remove();
          openPickerList = null;
        });
        list.appendChild(option);
      }
      wrap.appendChild(list);
      openPickerList = list;
    }

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
