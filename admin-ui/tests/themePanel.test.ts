import { describe, expect, it, vi } from "vitest";
import type { AdminApi, ThemeData } from "../src/api";
import type { EditView, MountEditViewDeps } from "../src/editView";
import type { DraftOp, ShellToOverlayMessage } from "../src/protocol";
import { mountThemePanel } from "../src/themePanel";

function fakeTheme(overrides: Partial<ThemeData> = {}): ThemeData {
  return {
    colors: { cream: "#F1E8D9", coffee: "#3E312A" },
    shadow: "0 18px 44px rgba(62,49,42,.14)",
    fonts: {
      serif: { family: "Cormorant Garamond", weights: ["400", "500"], italics: true },
      sans: { family: "Jost", weights: ["300", "400"], italics: false },
      script: { family: "Pinyon Script", weights: ["400"], italics: false },
    },
    ...overrides,
  };
}

function fakeApi(theme: ThemeData): AdminApi {
  return {
    getState: vi.fn(),
    getContent: vi.fn(),
    patchDraft: vi.fn(),
    discardDraft: vi.fn(),
    getMedia: vi.fn(),
    getTheme: vi.fn(async () => theme),
  } as unknown as AdminApi;
}

interface FakeView {
  element: HTMLElement;
  posted: ShellToOverlayMessage[];
  teardownCount: number;
}

function fakeMountEditView(): {
  fn: (page: string, deps: MountEditViewDeps) => EditView;
  views: FakeView[];
  pages: string[];
} {
  const views: FakeView[] = [];
  const pages: string[] = [];
  const fn = (page: string): EditView => {
    pages.push(page);
    const fake: FakeView = { element: document.createElement("div"), posted: [], teardownCount: 0 };
    views.push(fake);
    return {
      element: fake.element,
      setPage: () => {},
      applyOps: () => {},
      postMessage: (message) => fake.posted.push(message),
      teardown: () => {
        fake.teardownCount += 1;
      },
    };
  };
  return { fn, views, pages };
}

function fakeOpQueue(): { queue: { rev: number; enqueue: (op: DraftOp) => void }; ops: DraftOp[] } {
  const ops: DraftOp[] = [];
  return { queue: { rev: 0, enqueue: (op: DraftOp) => ops.push(op) }, ops };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// The MOST RECENT matching message (not the first): live-apply posts a fresh
// themeVars/themeFonts pair on every edit, so the last one is the one that
// reflects the change under test. `[...].reverse().find` rather than `findLast`
// (ES2023) — this project's tsconfig targets ES2022.
function themeVarsMessage(view: FakeView): Record<string, string> | undefined {
  const message = [...view.posted].reverse().find((m) => m.type === "themeVars");
  return message !== undefined && message.type === "themeVars" ? message.vars : undefined;
}

function themeFontsUrl(view: FakeView): string | undefined {
  const message = [...view.posted].reverse().find((m) => m.type === "themeFonts");
  return message !== undefined && message.type === "themeFonts" ? message.url : undefined;
}

describe("mountThemePanel", () => {
  it("mounts its embedded preview on the index page", async () => {
    const editView = fakeMountEditView();
    mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: fakeOpQueue().queue,
      mountEditView: editView.fn,
    });
    await flush();
    expect(editView.pages).toEqual(["index"]);
  });

  it("live-applies themeVars and themeFonts once the theme loads", async () => {
    const editView = fakeMountEditView();
    mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: fakeOpQueue().queue,
      mountEditView: editView.fn,
    });
    await flush();

    const view = editView.views[0];
    expect(view).toBeDefined();
    expect(view && themeVarsMessage(view)?.["--cream"]).toBe("#F1E8D9");
    expect(view && themeVarsMessage(view)?.["--font-serif"]).toBe("'Cormorant Garamond',serif");
    expect(view && themeFontsUrl(view)).toContain("family=Cormorant+Garamond");
  });

  it("renders a color row per palette key with the hex value pre-filled", async () => {
    const editView = fakeMountEditView();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: fakeOpQueue().queue,
      mountEditView: editView.fn,
    });
    await flush();

    const hexInputs = Array.from(
      panel.element.querySelectorAll<HTMLInputElement>(".wx-theme-hex"),
    );
    expect(hexInputs.map((input) => input.value).sort()).toEqual(["#3E312A", "#F1E8D9"]);
  });

  it("committing a color's hex field enqueues a SET op and live-applies immediately", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const hexInput = Array.from(
      panel.element.querySelectorAll<HTMLInputElement>(".wx-theme-hex"),
    ).find((input) => input.value === "#F1E8D9");
    expect(hexInput).toBeDefined();
    if (hexInput === undefined) return;

    hexInput.value = "#FFFFFF";
    hexInput.dispatchEvent(new Event("input"));
    const view = editView.views[0];
    expect(view && themeVarsMessage(view)?.["--cream"]).toBe("#FFFFFF");
    expect(opQueue.ops).toHaveLength(0); // input alone doesn't commit yet

    hexInput.dispatchEvent(new Event("change"));
    expect(opQueue.ops).toEqual([{ file: "theme", path: "colors.cream", value: "#FFFFFF" }]);
  });

  it("an invalid hex value live-applies nothing and never commits", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const hexInput = Array.from(
      panel.element.querySelectorAll<HTMLInputElement>(".wx-theme-hex"),
    ).find((input) => input.value === "#F1E8D9");
    if (hexInput === undefined) throw new Error("expected a cream hex input");

    hexInput.value = "not-a-color";
    hexInput.dispatchEvent(new Event("input"));
    hexInput.dispatchEvent(new Event("change"));
    expect(opQueue.ops).toHaveLength(0);
  });

  it("a color row's reset button enqueues a per-token discard op", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const creamRow = Array.from(
      panel.element.querySelectorAll<HTMLElement>(".wx-theme-color-row"),
    ).find((row) => row.querySelector(".wx-theme-color-label")?.textContent === "cream");
    const resetButton = creamRow?.querySelector<HTMLButtonElement>(".wx-theme-reset");
    resetButton?.click();

    expect(opQueue.ops).toEqual([{ file: "theme", path: "colors.cream", discard: true }]);
  });

  it("the Colors section's reset-all enqueues one discard per color key", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const resetAll = panel.element.querySelector<HTMLButtonElement>(
      ".wx-theme-section:nth-of-type(1) .wx-theme-reset-all",
    );
    resetAll?.click();

    expect(opQueue.ops).toEqual(
      expect.arrayContaining([
        { file: "theme", path: "colors.cream", discard: true },
        { file: "theme", path: "colors.coffee", discard: true },
      ]),
    );
    expect(opQueue.ops).toHaveLength(2);
  });

  it("picking a curated family updates the custom-family input and commits a whole-role SET", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const select = panel.element.querySelector<HTMLSelectElement>(".wx-theme-font-picker");
    expect(select).toBeDefined();
    if (select === null || select === undefined) return;
    select.value = "Playfair Display";
    select.dispatchEvent(new Event("change"));

    const familyInput = select.parentElement?.querySelector<HTMLInputElement>(
      ".wx-theme-font-family",
    );
    expect(familyInput?.value).toBe("Playfair Display");
    expect(opQueue.ops).toEqual([
      {
        file: "theme",
        path: "fonts.serif",
        value: { family: "Playfair Display", weights: ["400", "500"], italics: true },
      },
    ]);
  });

  it("toggling a weight checkbox live-applies and commits the whole role", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const sansRow = Array.from(
      panel.element.querySelectorAll<HTMLElement>(".wx-theme-font-row"),
    ).find((row) => row.querySelector("h4")?.textContent === "Body");
    const weight500 = Array.from(sansRow?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []).find(
      (box) => box.parentElement?.textContent === "500",
    );
    expect(weight500).toBeDefined();
    if (weight500 === undefined) return;
    // `.click()` relies on jsdom's connectedness-gated default action (checked-flip
    // + change) — these elements are never attached to `document`, so drive the
    // same observable state change directly instead (matching how the hex/family
    // input tests above already do a manual set + dispatch, not `.click()`).
    weight500.checked = true;
    weight500.dispatchEvent(new Event("change"));

    expect(opQueue.ops).toEqual([
      {
        file: "theme",
        path: "fonts.sans",
        value: { family: "Jost", weights: ["300", "400", "500"], italics: false },
      },
    ]);
  });

  it("a font role's reset button enqueues a per-role discard op", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const scriptRow = Array.from(
      panel.element.querySelectorAll<HTMLElement>(".wx-theme-font-row"),
    ).find((row) => row.querySelector("h4")?.textContent === "Script");
    scriptRow?.querySelector<HTMLButtonElement>(".wx-theme-reset")?.click();

    expect(opQueue.ops).toEqual([{ file: "theme", path: "fonts.script", discard: true }]);
  });

  it("committing the shadow field enqueues a SET op at the bare 'shadow' path", async () => {
    const editView = fakeMountEditView();
    const opQueue = fakeOpQueue();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: opQueue.queue,
      mountEditView: editView.fn,
    });
    await flush();

    const shadowInput = panel.element.querySelector<HTMLInputElement>(".wx-theme-shadow-input");
    if (shadowInput === null) throw new Error("expected a shadow input");
    shadowInput.value = "0 1px 2px black";
    shadowInput.dispatchEvent(new Event("input"));
    shadowInput.dispatchEvent(new Event("change"));

    expect(opQueue.ops).toEqual([{ file: "theme", path: "shadow", value: "0 1px 2px black" }]);
  });

  it("onOpsAccepted with a theme discard op refetches and re-renders with the new value", async () => {
    const theme = fakeTheme();
    const api = fakeApi(theme);
    const editView = fakeMountEditView();
    const panel = mountThemePanel({ api, opQueue: fakeOpQueue().queue, mountEditView: editView.fn });
    await flush();

    theme.colors["cream"] = "#000000"; // the "server" now reports the reverted value
    panel.onOpsAccepted([{ file: "theme", path: "colors.cream", discard: true }]);
    await flush();

    const hexInputs = Array.from(
      panel.element.querySelectorAll<HTMLInputElement>(".wx-theme-hex"),
    );
    expect(hexInputs.map((input) => input.value)).toContain("#000000");
    expect(api.getTheme).toHaveBeenCalledTimes(2); // initial load + the post-discard refresh
  });

  it("onOpsAccepted with a non-discard theme op does not refetch", async () => {
    const api = fakeApi(fakeTheme());
    const editView = fakeMountEditView();
    const panel = mountThemePanel({ api, opQueue: fakeOpQueue().queue, mountEditView: editView.fn });
    await flush();

    panel.onOpsAccepted([{ file: "theme", path: "colors.cream", value: "#FFFFFF" }]);
    await flush();

    expect(api.getTheme).toHaveBeenCalledTimes(1);
  });

  it("onOpsAccepted ignores an accepted batch for a different file", async () => {
    const api = fakeApi(fakeTheme());
    const editView = fakeMountEditView();
    const panel = mountThemePanel({ api, opQueue: fakeOpQueue().queue, mountEditView: editView.fn });
    await flush();

    panel.onOpsAccepted([{ file: "index", path: "hero.title", discard: true }]);
    await flush();

    expect(api.getTheme).toHaveBeenCalledTimes(1);
  });

  it("teardown tears down the embedded preview view", async () => {
    const editView = fakeMountEditView();
    const panel = mountThemePanel({
      api: fakeApi(fakeTheme()),
      opQueue: fakeOpQueue().queue,
      mountEditView: editView.fn,
    });
    await flush();

    panel.teardown();
    expect(editView.views[0]?.teardownCount).toBe(1);
  });
});
