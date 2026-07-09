import { afterEach, describe, expect, it } from "vitest";
import { resolveInternalPageSlug, showToast } from "../src/navigation";

function fakeWindow(origin: string, href: string): Window {
  return { location: { origin, href } } as unknown as Window;
}

function anchor(href: string): Element {
  const el = document.createElement("a");
  el.setAttribute("href", href);
  return el;
}

describe("resolveInternalPageSlug", () => {
  const win = fakeWindow("https://wixy.test", "https://wixy.test/admin/preview/index.html");

  it("resolves the home page (/) to the index slug", () => {
    expect(resolveInternalPageSlug(anchor("/"), win)).toBe("index");
  });

  it("resolves /<slug>.html to <slug>, matching builder.nav.page_url's convention", () => {
    expect(resolveInternalPageSlug(anchor("/about.html"), win)).toBe("about");
  });

  it("resolves a bare relative href against the SITE ROOT, matching the preview document's <base href=\"/\">", () => {
    // The real CA content mixes both styles (curl-verified against the live
    // preview route): @nav-computed links are root-absolute ("/about.html",
    // builder.nav.page_url), but hand-authored page/footer links are bare
    // relative ("about.html"). A real browser resolves BOTH the same way once
    // preview.py's <base href="/"> is in effect — this must agree.
    expect(resolveInternalPageSlug(anchor("contact.html"), win)).toBe("contact");
  });

  it("returns null for a relative href that doesn't match a real page path even once rooted", () => {
    expect(resolveInternalPageSlug(anchor("images/hero.jpg"), win)).toBe(null);
  });

  it("returns null for a pure same-page fragment (stays a native in-page scroll)", () => {
    expect(resolveInternalPageSlug(anchor("#contact"), win)).toBe(null);
  });

  it("returns null for a different-origin link", () => {
    expect(resolveInternalPageSlug(anchor("https://example.com/about.html"), win)).toBe(null);
  });

  it("returns null for /admin/* and /api/* paths", () => {
    expect(resolveInternalPageSlug(anchor("/admin/media"), win)).toBe(null);
    expect(resolveInternalPageSlug(anchor("/api/admin/state"), win)).toBe(null);
  });

  it("returns null for mailto:/tel: links", () => {
    expect(resolveInternalPageSlug(anchor("mailto:hello@example.com"), win)).toBe(null);
    expect(resolveInternalPageSlug(anchor("tel:+441234567890"), win)).toBe(null);
  });

  it("returns null for an anchor with no href", () => {
    const el = document.createElement("a");
    expect(resolveInternalPageSlug(el, win)).toBe(null);
  });
});

describe("showToast", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("appends a toast with the given message", () => {
    showToast("External link");
    expect(document.querySelector(".wx-toast")?.textContent).toBe("External link");
  });
});
