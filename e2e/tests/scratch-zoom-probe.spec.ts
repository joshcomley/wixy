// SCRATCH: zoom factor measurement precision. Not for commit.
import { test } from "@playwright/test";
import { webkit, chromium } from "@playwright/test";
test("probe", async () => {
  for (const [name, bt] of [["webkit", webkit], ["chromium", chromium]] as const) {
    const b = await bt.launch();
    const p = await (await b.newContext({ viewport: { width: 440, height: 900 } })).newPage();
    await p.setContent(`<div id=t style="overflow:auto;height:500px;padding:0 12px"><div id=c style="position:relative"><div style="height:60000px"></div><div id=a style="height:10px;background:red"></div></div></div>`);
    for (const z of ["0.9", "1.1", "0.7", "1"]) {
      await p.evaluate((zz) => document.documentElement.style.setProperty("zoom", zz), z);
      const r = await p.evaluate(() => {
        const c = document.getElementById("c")!, a = document.getElementById("a")!;
        const cr = c.getBoundingClientRect();
        const cs = parseFloat(getComputedStyle(c).width);
        return { cur: (c as unknown as { currentCSSZoom?: number }).currentCSSZoom, rectW: cr.width, offW: c.offsetWidth, clientW: c.clientWidth, compW: cs, kComp: cr.width / cs, aDelta: a.getBoundingClientRect().top - cr.top, aOff: a.offsetTop };
      });
      console.log(name, z, JSON.stringify(r));
    }
    await b.close();
  }
});
