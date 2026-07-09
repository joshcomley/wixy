// The overlay <-> shell postMessage protocol (spec/05-editor.md §2, normative).
//
// This is a DELIBERATE DUPLICATE of `editor/src/protocol.ts` (decisions/00015 decision
// 2) — the two packages never import each other (they only ever talk across the iframe
// boundary via `postMessage`), and a shared npm package for a handful of small message
// shapes would be a new build concern for no real benefit. Keep both copies in sync by
// hand when the protocol changes; each cites this same spec section as ground truth.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Binding kinds from the wixy bindings-map (decisions/00012, provisional). */
export type BindingKind = "text" | "img" | "href" | "bg" | "attr" | "list" | "if";

export interface BindingField {
  key: string;
  kind: BindingKind;
  attr?: string;
  items?: BindingField[];
}

export interface PageBindings {
  page: string;
  fields: BindingField[];
}

/** A single draft overlay op (spec/02 §8's `{file, path, value}` / `{file, path,
 * discard: true}` PATCH shape — matches `wixy_server.routes_admin_api.DraftOpIn`). */
export type DraftOp =
  | { file: string; path: string; value: JsonValue }
  | { file: string; path: string; discard: true };

export type Device = "desktop" | "tablet" | "mobile";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// shell -> overlay
// ---------------------------------------------------------------------------

export interface InitMessage {
  wx: 1;
  type: "init";
  page: string;
  bindings: PageBindings;
  draftRev: number;
}

export interface ApplyOpsMessage {
  wx: 1;
  type: "applyOps";
  ops: DraftOp[];
}

export interface SetDeviceMessage {
  wx: 1;
  type: "setDevice";
  device: Device;
}

export interface ThemeVarsMessage {
  wx: 1;
  type: "themeVars";
  vars: Record<string, string>;
}

/** Swap the preview iframe's Google Fonts `<link>` `href` (spec/05 §3's "Fonts:
 * … live-applies by swapping the preview iframe's fonts link tag") — a distinct
 * message from `themeVars` because loading a new font FAMILY requires fetching a
 * new stylesheet resource, not just re-assigning a CSS custom property; a family
 * change still also sends `themeVars` for the `--font-*` variable itself. */
export interface ThemeFontsMessage {
  wx: 1;
  type: "themeFonts";
  url: string;
}

export interface SelectMessage {
  wx: 1;
  type: "select";
  key: string;
}

export type ShellToOverlayMessage =
  | InitMessage
  | ApplyOpsMessage
  | SetDeviceMessage
  | ThemeVarsMessage
  | ThemeFontsMessage
  | SelectMessage;

// ---------------------------------------------------------------------------
// overlay -> shell
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  wx: 1;
  type: "ready";
}

export interface OpMessage {
  wx: 1;
  type: "op";
  file: string;
  path: string;
  value: JsonValue;
}

export interface NavigateMessage {
  wx: 1;
  type: "navigate";
  page: string;
}

export interface SelectedMessage {
  wx: 1;
  type: "selected";
  key: string;
  kind: BindingKind;
  rect: Rect;
}

export interface MediaRequestMessage {
  wx: 1;
  type: "mediaRequest";
  key: string;
}

export type OverlayToShellMessage =
  | ReadyMessage
  | OpMessage
  | NavigateMessage
  | SelectedMessage
  | MediaRequestMessage;

// ---------------------------------------------------------------------------
// Runtime validation — postMessage payloads cross a serialization boundary, so
// TypeScript's compile-time types alone don't guard against a malformed/unexpected
// message at runtime.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The index signature is deliberate: every case below reads message-specific fields
// (`file`, `page`, `rect`, …) that aren't part of the fixed `{wx, type}` envelope
// itself, and TypeScript can't narrow arbitrary field access without one.
function isWxEnvelope(
  value: unknown,
): value is { wx: 1; type: string } & Record<string, unknown> {
  return isRecord(value) && value["wx"] === 1 && typeof value["type"] === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isDraftOp(value: unknown): value is DraftOp {
  if (!isRecord(value)) return false;
  if (typeof value["file"] !== "string" || typeof value["path"] !== "string") return false;
  if (value["discard"] === true) return true;
  return "value" in value && isJsonValue(value["value"]);
}

function isBindingKind(value: unknown): value is BindingKind {
  return (
    value === "text" ||
    value === "img" ||
    value === "href" ||
    value === "bg" ||
    value === "list" ||
    value === "if" ||
    value === "attr"
  );
}

function isBindingField(value: unknown): value is BindingField {
  if (!isRecord(value)) return false;
  if (typeof value["key"] !== "string" || !isBindingKind(value["kind"])) return false;
  if ("attr" in value && typeof value["attr"] !== "string") return false;
  if ("items" in value) {
    const items = value["items"];
    if (!Array.isArray(items) || !items.every(isBindingField)) return false;
  }
  return true;
}

function isPageBindings(value: unknown): value is PageBindings {
  if (!isRecord(value)) return false;
  const fields = value["fields"];
  return (
    typeof value["page"] === "string" && Array.isArray(fields) && fields.every(isBindingField)
  );
}

/** Narrows an arbitrary `MessageEvent.data` to a known overlay -> shell message, or
 * `null` if it isn't one this protocol version recognizes. */
export function parseOverlayToShellMessage(data: unknown): OverlayToShellMessage | null {
  if (!isWxEnvelope(data)) return null;
  switch (data.type) {
    case "ready":
      return { wx: 1, type: "ready" };
    case "op": {
      if (
        typeof data["file"] !== "string" ||
        typeof data["path"] !== "string" ||
        !isJsonValue(data["value"])
      ) {
        return null;
      }
      return { wx: 1, type: "op", file: data["file"], path: data["path"], value: data["value"] };
    }
    case "navigate":
      return typeof data["page"] === "string"
        ? { wx: 1, type: "navigate", page: data["page"] }
        : null;
    case "selected": {
      const rect = data["rect"];
      if (
        typeof data["key"] !== "string" ||
        !isBindingKind(data["kind"]) ||
        !isRecord(rect) ||
        typeof rect["x"] !== "number" ||
        typeof rect["y"] !== "number" ||
        typeof rect["width"] !== "number" ||
        typeof rect["height"] !== "number"
      ) {
        return null;
      }
      return {
        wx: 1,
        type: "selected",
        key: data["key"],
        kind: data["kind"],
        rect: { x: rect["x"], y: rect["y"], width: rect["width"], height: rect["height"] },
      };
    }
    case "mediaRequest":
      return typeof data["key"] === "string"
        ? { wx: 1, type: "mediaRequest", key: data["key"] }
        : null;
    default:
      return null;
  }
}

/** Narrows an arbitrary `MessageEvent.data` to a known shell -> overlay message, or
 * `null` if it isn't one this protocol version recognizes. */
export function parseShellToOverlayMessage(data: unknown): ShellToOverlayMessage | null {
  if (!isWxEnvelope(data)) return null;
  switch (data.type) {
    case "init": {
      if (
        typeof data["page"] !== "string" ||
        typeof data["draftRev"] !== "number" ||
        !isPageBindings(data["bindings"])
      ) {
        return null;
      }
      return {
        wx: 1,
        type: "init",
        page: data["page"],
        bindings: data["bindings"],
        draftRev: data["draftRev"],
      };
    }
    case "applyOps": {
      const ops = data["ops"];
      return Array.isArray(ops) && ops.every(isDraftOp)
        ? { wx: 1, type: "applyOps", ops }
        : null;
    }
    case "setDevice":
      return data["device"] === "desktop" ||
        data["device"] === "tablet" ||
        data["device"] === "mobile"
        ? { wx: 1, type: "setDevice", device: data["device"] }
        : null;
    case "themeVars": {
      const vars = data["vars"];
      if (!isRecord(vars) || !Object.values(vars).every((v) => typeof v === "string")) {
        return null;
      }
      return { wx: 1, type: "themeVars", vars: vars as Record<string, string> };
    }
    case "themeFonts":
      return typeof data["url"] === "string"
        ? { wx: 1, type: "themeFonts", url: data["url"] }
        : null;
    case "select":
      return typeof data["key"] === "string" ? { wx: 1, type: "select", key: data["key"] } : null;
    default:
      return null;
  }
}
