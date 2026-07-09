import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initOverlay } from "../src/overlay";
import type { OverlayToShellMessage, PageBindings } from "../src/protocol";

interface FakeWindow {
  location: { origin: string; href: string };
  parent: { postMessage: (message: unknown, origin: string) => void };
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

interface Harness {
  win: Window;
  fake: FakeWindow;
  sent: OverlayToShellMessage[];
  dispatchShellMessage: (data: unknown) => void;
  teardown: () => void;
}

function createHarness(): Omit<Harness, "teardown"> & { start: () => () => void } {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const sent: OverlayToShellMessage[] = [];
  const fake: FakeWindow = {
    location: { origin: "https://wixy.test", href: "https://wixy.test/admin/preview/index.html" },
    parent: {
      postMessage: (message) => {
        sent.push(message as OverlayToShellMessage);
      },
    },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const win = fake as unknown as Window;
  const dispatchShellMessage = (data: unknown): void => {
    const event = { origin: "https://wixy.test", data } as MessageEvent;
    listeners.get("message")?.forEach((l) => l(event));
  };
  return { win, fake, sent, dispatchShellMessage, start: () => initOverlay(win) };
}

/** Starts the overlay against the fake window and immediately delivers `init`. */
function initFor(page: string, bindings: PageBindings, draftRev = 0): Harness {
  const harness = createHarness();
  const teardown = harness.start();
  harness.dispatchShellMessage({ wx: 1, type: "init", page, bindings, draftRev });
  return {
    win: harness.win,
    fake: harness.fake,
    sent: harness.sent,
    dispatchShellMessage: harness.dispatchShellMessage,
    teardown,
  };
}

describe("initOverlay", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    document.body.innerHTML = "";
  });

  it("sends ready to the shell immediately on startup", () => {
    const harness = createHarness();
    const teardown = harness.start();
    expect(harness.sent).toEqual([{ wx: 1, type: "ready" }]);
    teardown();
  });

  describe("hover chrome", () => {
    it("adds an outline class and a chip on hover of a bound element", () => {
      root.innerHTML = `<h1 data-wx="hero.title">Title</h1>`;
      const h1 = root.querySelector("h1") as HTMLElement;
      const { teardown } = initFor("index", { page: "index", fields: [] });

      h1.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

      expect(h1.classList.contains("wx-hover-outline")).toBe(true);
      expect(document.querySelector(".wx-hover-chip")?.textContent).toBe("Text");
      teardown();
    });

    it("does not add hover chrome for @nav (computed, not generically editable)", () => {
      root.innerHTML = `<ul data-wx-list="@nav"><li data-wx-list-item></li></ul>`;
      const ul = root.querySelector("ul") as HTMLElement;
      const { teardown } = initFor("index", { page: "index", fields: [] });

      ul.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

      expect(ul.classList.contains("wx-hover-outline")).toBe(false);
      expect(document.querySelector(".wx-hover-chip")).toBeNull();
      teardown();
    });
  });

  describe("text editing", () => {
    it("clicking a plain text binding opens a popover; committing applies the DOM and emits an op", () => {
      root.innerHTML = `<h1 data-wx="hero.title">Original</h1>`;
      const h1 = root.querySelector("h1") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      h1.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const input = document.querySelector(".wx-popover input") as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = "Edited";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(h1.innerHTML).toBe("Edited");
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "hero.title",
        value: "Edited",
      });
      teardown();
    });

    it("emits an op targeting _global for an @-prefixed key", () => {
      root.innerHTML = `<div data-wx="@brand.line1">Cottage</div>`;
      const el = root.querySelector("div") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const input = document.querySelector(".wx-popover input") as HTMLInputElement;
      input.value = "New Brand";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "_global",
        path: "brand.line1",
        value: "New Brand",
      });
      teardown();
    });

    it("escape cancels without emitting an op or changing the DOM", () => {
      root.innerHTML = `<h1 data-wx="hero.title">Original</h1>`;
      const h1 = root.querySelector("h1") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      h1.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const input = document.querySelector(".wx-popover input") as HTMLInputElement;
      input.value = "Should not stick";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(h1.innerHTML).toBe("Original");
      expect(sent.filter((m) => m.type === "op")).toHaveLength(0);
      expect(document.querySelector(".wx-popover")).toBeNull();
      teardown();
    });
  });

  describe("link editing", () => {
    it("the CTA pattern (data-wx-href + data-wx on the same element) is treated as Link", () => {
      root.innerHTML = `<a href="/old.html" data-wx-href="hero.ctaHref" data-wx="hero.ctaLabel">Learn more</a>`;
      const a = root.querySelector("a") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      expect(document.querySelector(".wx-hover-chip")?.textContent).toBe("Link");

      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const inputs = Array.from(document.querySelectorAll(".wx-popover input")) as HTMLInputElement[];
      expect(inputs).toHaveLength(2);

      const hrefInput = inputs[1];
      if (hrefInput === undefined) throw new Error("expected an href input");
      hrefInput.value = "/new.html";
      hrefInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(a.getAttribute("href")).toBe("/new.html");
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "hero.ctaHref",
        value: "/new.html",
      });
      teardown();
    });
  });

  describe("image editing", () => {
    it("Replace sends mediaRequest with the binding key", () => {
      root.innerHTML = `<img data-wx-img="hero.img" src="images/old.jpg" alt="old">`;
      const img = root.querySelector("img") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(sent.at(-1)).toEqual({ wx: 1, type: "mediaRequest", key: "hero.img" });
      teardown();
    });

    it("committing alt text updates the DOM and emits the whole {src, alt} op", () => {
      root.innerHTML = `<img data-wx-img="hero.img" src="images/hero.jpg" alt="old alt">`;
      const img = root.querySelector("img") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const altInput = document.querySelectorAll(".wx-popover input")[0] as HTMLInputElement;
      altInput.value = "new alt";
      altInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(img.getAttribute("alt")).toBe("new alt");
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "hero.img",
        value: { src: "images/hero.jpg", alt: "new alt" },
      });
      teardown();
    });
  });

  describe("data-wx-if eye toggle", () => {
    it("clicking the eye toggle flips data-wx-hidden and emits a boolean op", () => {
      root.innerHTML = `
        <section data-wx-if="hero.showBadge" data-wx-hidden="1">
          <button class="wx-if-eye-toggle" type="button">eye</button>
        </section>`;
      const section = root.querySelector("section") as HTMLElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      root
        .querySelector(".wx-if-eye-toggle")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(section.hasAttribute("data-wx-hidden")).toBe(false);
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "hero.showBadge",
        value: true,
      });
      teardown();
    });

    it("handles a negated if-spec (!key) correctly", () => {
      root.innerHTML = `
        <section data-wx-if="!hero.hideExtra">
          <button class="wx-if-eye-toggle" type="button">eye</button>
        </section>`;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      root
        .querySelector(".wx-if-eye-toggle")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // was visible (no data-wx-hidden) -> click makes it hidden -> newTruthy=false
      // -> negated key's real value = !false = true
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "hero.hideExtra",
        value: true,
      });
      teardown();
    });
  });

  describe("data-wx-if eye toggle auto-injection", () => {
    it("inserts a toggle button into a hidden section that doesn't already have one", () => {
      root.innerHTML = `<section data-wx-if="hero.showBadge" data-wx-hidden="1"><p>Badge</p></section>`;
      const { teardown } = initFor("index", { page: "index", fields: [] });

      const toggle = root.querySelector("section > .wx-if-eye-toggle");
      expect(toggle).not.toBeNull();
      teardown();
    });

    it("does not insert a second toggle when one is already present", () => {
      root.innerHTML = `
        <section data-wx-if="hero.showBadge" data-wx-hidden="1">
          <button class="wx-if-eye-toggle" type="button">eye</button>
        </section>`;
      const { teardown } = initFor("index", { page: "index", fields: [] });

      expect(root.querySelectorAll(".wx-if-eye-toggle")).toHaveLength(1);
      teardown();
    });

    it("clicking an auto-injected toggle on an element that is ALSO a link binding only toggles visibility (no popover)", () => {
      // The real fixture nests this CTA pattern (same element both if-bound and
      // href-bound) inside a list item, where the if-key is item-scoped
      // (builder/tests/fixtures/mini-site/pages/index.html's ".book"/".bookHref").
      // A page-scope key exercises the identical event-conflict concern (does the
      // toggle click ALSO open the link popover?) without needing that list
      // context — item-scoped emission itself is covered by "data-wx-if eye
      // toggle" > "clicking the eye toggle flips data-wx-hidden..." above.
      root.innerHTML = `<a data-wx-if="hero.showBook" data-wx-href="hero.bookHref" data-wx-hidden="1">Book</a>`;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      root
        .querySelector(".wx-if-eye-toggle")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      expect(root.querySelector("a")?.hasAttribute("data-wx-hidden")).toBe(false);
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "hero.showBook",
        value: true,
      });
      expect(document.querySelector(".wx-popover")).toBeNull();
      teardown();
    });
  });

  describe("internal/external link navigation", () => {
    it("intercepts a same-origin page link, notifies the shell, and rewrites the iframe to the preview equivalent", () => {
      root.innerHTML = `<nav><a href="/about.html">About</a></nav>`;
      const anchor = root.querySelector("a") as HTMLAnchorElement;
      const { sent, fake, teardown } = initFor("index", { page: "index", fields: [] });

      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(sent.at(-1)).toEqual({ wx: 1, type: "navigate", page: "about" });
      expect(fake.location.href).toBe("/admin/preview/about.html");
      teardown();
    });

    it("treats the home link (/) as the index page", () => {
      root.innerHTML = `<nav><a href="/">Home</a></nav>`;
      const anchor = root.querySelector("a") as HTMLAnchorElement;
      const { sent, teardown } = initFor("about", { page: "about", fields: [] });

      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      expect(sent.at(-1)).toEqual({ wx: 1, type: "navigate", page: "index" });
      teardown();
    });

    it("treats a different-origin link as external: no navigation, a toast instead", () => {
      root.innerHTML = `<a href="https://example.com/other">Elsewhere</a>`;
      const anchor = root.querySelector("a") as HTMLAnchorElement;
      const { sent, fake, teardown } = initFor("index", { page: "index", fields: [] });
      const originalHref = fake.location.href;

      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(sent.some((m) => m.type === "navigate")).toBe(false);
      expect(fake.location.href).toBe(originalHref);
      expect(document.querySelector(".wx-toast")?.textContent).toBe("External link");
      teardown();
    });

    it("does not intercept a data-wx-href BINDING (that's an editable field, routed to the link popover)", () => {
      root.innerHTML = `<a data-wx-href="cta.href" href="/about.html">CTA</a>`;
      const anchor = root.querySelector("a") as HTMLAnchorElement;
      const { sent, teardown } = initFor("index", { page: "index", fields: [] });

      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      expect(sent.some((m) => m.type === "navigate")).toBe(false);
      expect(document.querySelector(".wx-popover")).not.toBeNull();
      teardown();
    });
  });

  describe("list item structural editing", () => {
    const showcaseBindings: PageBindings = {
      page: "index",
      fields: [
        { key: "showcase.items", kind: "list", items: [{ key: ".title", kind: "text" }] },
      ],
    };

    function renderShowcase(): void {
      root.innerHTML = `
        <ul data-wx-list="showcase.items">
          <li data-wx-list-item><h3 data-wx=".title">One</h3></li>
          <li data-wx-list-item><h3 data-wx=".title">Two</h3></li>
        </ul>`;
    }

    it("editing an item field emits the WHOLE array, not a per-item path", () => {
      renderShowcase();
      const firstTitle = root.querySelector('[data-wx=".title"]') as HTMLElement;
      const { sent, teardown } = initFor("index", showcaseBindings);

      firstTitle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const input = document.querySelector(".wx-popover input") as HTMLInputElement;
      input.value = "One Edited";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "showcase.items",
        value: [{ title: "One Edited" }, { title: "Two" }],
      });
      teardown();
    });

    it("hovering an item shows a toolbar; delete removes the item and emits the shrunk array", () => {
      renderShowcase();
      const firstItem = root.querySelectorAll("[data-wx-list-item]")[0] as HTMLElement;
      const { sent, teardown } = initFor("index", showcaseBindings);

      firstItem.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      const toolbar = document.querySelector(".wx-item-toolbar");
      expect(toolbar).not.toBeNull();

      toolbar
        ?.querySelector('[data-wx-toolbar-action="delete"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(root.querySelectorAll("[data-wx-list-item]")).toHaveLength(1);
      expect(sent.at(-1)).toEqual({
        wx: 1,
        type: "op",
        file: "index",
        path: "showcase.items",
        value: [{ title: "Two" }],
      });
      teardown();
    });

    it("moveDown swaps the item order and emits the reordered array", () => {
      renderShowcase();
      const firstItem = root.querySelectorAll("[data-wx-list-item]")[0] as HTMLElement;
      const { sent, teardown } = initFor("index", showcaseBindings);

      firstItem.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document
        .querySelector('[data-wx-toolbar-action="moveDown"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      const titles = Array.from(root.querySelectorAll('[data-wx=".title"]')).map(
        (el) => el.textContent,
      );
      expect(titles).toEqual(["Two", "One"]);
      const last = sent.at(-1);
      expect(last?.type).toBe("op");
      expect(last && "value" in last ? last.value : undefined).toEqual([
        { title: "Two" },
        { title: "One" },
      ]);
      teardown();
    });

    it("add clones the first item and blanks its text field", () => {
      renderShowcase();
      const firstItem = root.querySelectorAll("[data-wx-list-item]")[0] as HTMLElement;
      const { sent, teardown } = initFor("index", showcaseBindings);

      firstItem.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      document
        .querySelector('[data-wx-toolbar-action="add"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(root.querySelectorAll("[data-wx-list-item]")).toHaveLength(3);
      const last = sent.at(-1);
      expect(last && "value" in last ? last.value : undefined).toEqual([
        { title: "One" },
        { title: "Two" },
        { title: "" },
      ]);
      teardown();
    });
  });

  describe("shell messages", () => {
    it("themeVars sets CSS custom properties on the document root", () => {
      const harness = createHarness();
      const teardown = harness.start();
      harness.dispatchShellMessage({ wx: 1, type: "themeVars", vars: { "--clay": "#B26E4A" } });
      expect(document.documentElement.style.getPropertyValue("--clay")).toBe("#B26E4A");
      teardown();
    });

    describe("themeFonts", () => {
      afterEach(() => {
        document.head
          .querySelectorAll("link")
          .forEach((link) => link.href.includes("fonts.googleapis.com") && link.remove());
      });

      it("swaps an existing Google Fonts link's href", () => {
        const existing = document.createElement("link");
        existing.rel = "stylesheet";
        existing.href = "https://fonts.googleapis.com/css2?family=Jost:wght@400";
        document.head.appendChild(existing);

        const harness = createHarness();
        const teardown = harness.start();
        harness.dispatchShellMessage({
          wx: 1,
          type: "themeFonts",
          url: "https://fonts.googleapis.com/css2?family=Roboto:wght@400",
        });

        const links = Array.from(document.head.querySelectorAll("link")).filter((l) =>
          l.href.includes("fonts.googleapis.com"),
        );
        expect(links).toHaveLength(1);
        expect(links[0]?.href).toBe("https://fonts.googleapis.com/css2?family=Roboto:wght@400");
        teardown();
      });

      it("creates a fonts link if none exists yet", () => {
        const harness = createHarness();
        const teardown = harness.start();
        harness.dispatchShellMessage({
          wx: 1,
          type: "themeFonts",
          url: "https://fonts.googleapis.com/css2?family=Roboto:wght@400",
        });

        const link = Array.from(document.head.querySelectorAll("link")).find((l) =>
          l.href.includes("fonts.googleapis.com"),
        );
        expect(link?.href).toBe("https://fonts.googleapis.com/css2?family=Roboto:wght@400");
        expect(link?.rel).toBe("stylesheet");
        teardown();
      });
    });

    it("select scrolls the matching bound element into view", () => {
      root.innerHTML = `<h1 data-wx="hero.title">Title</h1>`;
      const h1 = root.querySelector("h1") as HTMLElement;
      const scrollIntoView = vi.fn();
      h1.scrollIntoView = scrollIntoView;

      const harness = createHarness();
      const teardown = harness.start();
      harness.dispatchShellMessage({ wx: 1, type: "select", key: "hero.title" });

      expect(scrollIntoView).toHaveBeenCalled();
      teardown();
    });
  });
});
