import { test } from "@playwright/test";

test("debug geometry", async ({ page }) => {
  const contentFetch = page.waitForResponse((res) => res.url().includes("/api/admin/content/index"));
  await page.goto("/admin#/edit/index");
  await contentFetch;
  await page.waitForTimeout(300);
  const frame = page.frameLocator(".wx-preview-iframe");
  const items = frame.locator("ul.showcase > [data-wx-list-item]");
  await items.first().hover();
  await page.waitForTimeout(200);

  const info = await page.evaluate(() => {
    const iframeEl = document.querySelector(".wx-preview-iframe") as HTMLIFrameElement;
    const iframeRect = iframeEl.getBoundingClientRect();
    const idoc = iframeEl.contentDocument!;
    const item = idoc.querySelector("ul.showcase > [data-wx-list-item]")!;
    const itemRect = item.getBoundingClientRect();
    const toolbar = idoc.querySelector(".wx-item-toolbar") as HTMLElement | null;
    const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
    return {
      outerViewport: { w: window.innerWidth, h: window.innerHeight },
      iframeRect: { top: iframeRect.top, left: iframeRect.left, w: iframeRect.width, h: iframeRect.height },
      iframeInnerViewport: { w: idoc.defaultView!.innerWidth, h: idoc.defaultView!.innerHeight },
      itemRect: { top: itemRect.top, bottom: itemRect.bottom, left: itemRect.left, h: itemRect.height },
      toolbarExists: toolbar !== null,
      toolbarStyle: toolbar ? { top: toolbar.style.top, left: toolbar.style.left } : null,
      toolbarRect: toolbarRect
        ? { top: toolbarRect.top, left: toolbarRect.left, w: toolbarRect.width, h: toolbarRect.height }
        : null,
    };
  });
  console.log("GEOMETRY_DEBUG " + JSON.stringify(info));
});
