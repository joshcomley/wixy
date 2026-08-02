// Live verification for decisions/00110 (the chat experience revamp) against
// the DEPLOYED wixy at https://ca.cinnamons.uk — a real browser at phone size
// with CF Access service-token headers on every request.
//
// Legs:
//   A. The pre-existing "[Test] PR7" conversation (its user message carries
//      cmd's driver-path Attachments: footer) must now render a THUMBNAIL,
//      not the raw path text — the footer-parse recovery, live.
//   B. Layout invariants on a phone viewport: composer fully on-screen, the
//      thread scrolls (or can once full), .wx-main never scrolls.
//   C. Tap a thumbnail -> lightbox -> close.
//   D. Start a NEW conversation WITH an image attached (the compose box on
//      the list view) — chip, create carries the id, and once the first turn
//      lands the bubble shows the thumbnail (the send-log recovery, live).
//   E. The composer auto-grows with long input.
//   F. Screenshots into ./live-verify-shots/ for the record.
//
// Usage: node live-verify-chat.mjs   (from e2e/, after `npm ci` + chromium)
// Requires D:\Servers\Loom\Storage\cf_access_token.json (see the verify skill).

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const TOKEN_PATH = "D:\\Servers\\Loom\\Storage\\cf_access_token.json";
const BASE = "https://ca.cinnamons.uk";
const SHOTS = path.join(__dirname, "live-verify-shots");

function headers() {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  return {
    "CF-Access-Client-Id": token.client_id,
    "CF-Access-Client-Secret": token.client_secret,
  };
}

function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ok — ${label}`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    extraHTTPHeaders: headers(),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  try {
    // -- A: footer-carrying history renders as thumbnails ---------------------
    console.log("A. open the existing [Test] PR7 conversation");
    await page.goto(`${BASE}/admin/chat`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wx-chat-list-view");
    const pr7 = page.locator(".wx-chat-list-title", { hasText: "PR7" }).first();
    await pr7.click();
    await page.waitForSelector(".wx-chat-conversation-view");

    // The raw path text must be GONE from every bubble...
    await page.waitForSelector(".wx-chat-att-thumb img", { timeout: 30_000 });
    const bodyText = await page.locator(".wx-chat-thread").innerText();
    assert(!bodyText.includes("cmd-uploads"), "no raw cmd-uploads path text in the thread");
    assert(!bodyText.includes("Attachments:"), "no Attachments: footer prose in the thread");
    // ...and the thumbnail really loads its bytes through the proxy (wait for
    // the lazy load to finish — presence alone says nothing about bytes).
    await page.waitForFunction(
      () => {
        const img = document.querySelector(".wx-chat-att-thumb img");
        return img && img.complete && img.naturalWidth > 0;
      },
      undefined,
      { timeout: 20_000 },
    );
    const thumbInfo = await page.locator(".wx-chat-att-thumb img").first().evaluate((img) => ({
      src: img.getAttribute("src"),
      naturalWidth: img.naturalWidth,
    }));
    assert(thumbInfo.src.includes("/api/admin/chat/uploads/"), `thumb src is the wixy proxy (${thumbInfo.src})`);
    assert(thumbInfo.naturalWidth > 0, `thumb image bytes load (naturalWidth=${thumbInfo.naturalWidth})`);

    // -- B: phone-layout invariants -------------------------------------------
    console.log("B. layout invariants");
    const metrics = await page.evaluate(() => {
      const thread = document.querySelector(".wx-chat-thread");
      const main = document.querySelector(".wx-main");
      const composer = document.querySelector(".wx-chat-composer");
      const rect = composer.getBoundingClientRect();
      return {
        threadScrollable: thread.scrollHeight > thread.clientHeight + 1,
        mainScrolls: main.scrollHeight > main.clientHeight + 1,
        composerTop: rect.top,
        composerBottom: rect.bottom,
        vh: window.innerHeight,
      };
    });
    assert(metrics.mainScrolls === false, ".wx-main does NOT scroll (no double-scroll)");
    assert(metrics.composerTop >= 0 && metrics.composerBottom <= metrics.vh,
      `composer fully on-screen (top=${metrics.composerTop}, bottom=${metrics.composerBottom} <= ${metrics.vh})`);
    console.log(`  info — thread scrollable already: ${metrics.threadScrollable}`);
    await page.screenshot({ path: path.join(SHOTS, "a-conversation-phone.png") });

    // -- C: lightbox ------------------------------------------------------------
    console.log("C. lightbox");
    await page.locator(".wx-chat-att-thumb").first().click();
    await page.waitForSelector(".wx-chat-lightbox img");
    await page.screenshot({ path: path.join(SHOTS, "c-lightbox.png") });
    await page.click(".wx-chat-lightbox-close");
    await page.waitForSelector(".wx-chat-lightbox", { state: "detached" });
    assert(true, "thumb -> lightbox -> close");

    // -- D: start a NEW conversation WITH an image ------------------------------
    console.log("D. new conversation with an attached image");
    await page.click(".wx-chat-back-link");
    await page.waitForSelector(".wx-chat-list-view");
    await page.click(".wx-chat-new-button");
    await page.waitForSelector(".wx-chat-compose-box .wx-chat-attach-button", { timeout: 20_000 });
    // A distinctive pre-generated image (same idea as decisions/00103's token
    // image, so the model's later description is checkable) — written ahead
    // of time by the verification run, not generated inline here.
    const imgPath = path.join(SHOTS, "verify-upload.png");
    if (!fs.existsSync(imgPath)) throw new Error(`missing ${imgPath} — generate it first`);
    await page.locator('.wx-chat-compose-box input[type="file"]').setInputFiles(imgPath);
    await page.waitForSelector(".wx-chat-compose-box .wx-chat-attachment-chip");
    assert(true, "chip appears in the NEW-conversation compose box");
    await page.fill(".wx-chat-compose-input", "What colour is the circle in this image? One word.");
    const createResp = page.waitForResponse(
      (res) => res.url().endsWith("/api/admin/chat/conversations") && res.request().method() === "POST",
    );
    await page.click(".wx-chat-compose-actions button");
    const createBody = (await (await createResp).request().postDataJSON());
    assert(Array.isArray(createBody.attachmentIds) && createBody.attachmentIds.length === 1,
      "create body carries attachmentIds");
    await page.waitForURL(/\/admin\/chat\/.+/);
    // No optimistic echo on this path BY DESIGN (echo state can't cross the
    // list->detail remount; echoes exist for sends within an open
    // conversation). The friendly provisioning placeholder covers the gap —
    // it renders once the conversation's status resolves (an async tick
    // after mount), so WAIT for the text, not just the element.
    await page.waitForFunction(
      () => /starting your conversation/i.test(
        document.querySelector(".wx-chat-thread")?.innerText ?? "",
      ),
      undefined,
      { timeout: 15_000 },
    );
    assert(true, "the starting-up placeholder shows while the first turn provisions");
    await page.screenshot({ path: path.join(SHOTS, "d-echo.png") });

    // The real first turn lands (provisioning + model) — the user bubble must
    // keep its thumbnail (send-log decoration) and the assistant must answer.
    console.log("  waiting for the first turn to land (up to 3 min)…");
    await page.waitForSelector(".wx-chat-bubble-assistant", { timeout: 180_000 });
    await page.waitForSelector(".wx-chat-bubble-user .wx-chat-att-thumb img", { timeout: 30_000 });
    const userThumbSrc = await page.locator(".wx-chat-bubble-user .wx-chat-att-thumb img").first()
      .evaluate((img) => img.getAttribute("src"));
    assert(userThumbSrc.includes(`/api/admin/chat/uploads/${createBody.attachmentIds[0]}/bytes`),
      "the server-driven bubble keeps the thumbnail (send-log decoration)");
    const reply = await page.locator(".wx-chat-bubble-assistant").first().innerText();
    console.log(`  assistant replied: ${JSON.stringify(reply.slice(0, 120))}`);
    assert(/teal|blue|green/i.test(reply), "the model genuinely saw the attached image");
    await page.screenshot({ path: path.join(SHOTS, "d-first-turn.png") });

    // The in-conversation send DOES get an optimistic echo — paint it, watch
    // it reconcile when the server copy streams in.
    console.log("D2. optimistic echo on an in-conversation send");
    await page.fill(".wx-chat-composer-input", "Thanks — ignore that, just testing.");
    await page.click(".wx-chat-send-button");
    await page.waitForSelector(".wx-chat-echo", { timeout: 5_000 });
    const echoText = await page.locator(".wx-chat-echo").innerText();
    assert(/sending…/.test(echoText), "echo paints instantly with 'sending…'");
    await page.waitForSelector(".wx-chat-echo", { state: "detached", timeout: 60_000 });
    assert(true, "echo reconciles once the server copy streams in");

    // -- E: auto-grow -------------------------------------------------------------
    console.log("E. composer auto-grow");
    const before = await page.locator(".wx-chat-composer-input").evaluate((el) => el.offsetHeight);
    await page.fill(".wx-chat-composer-input", "one\ntwo\nthree\nfour\nfive\nsix");
    const after = await page.locator(".wx-chat-composer-input").evaluate((el) => el.offsetHeight);
    assert(after > before, `textarea grows (${before} -> ${after})`);
    assert(after <= 200, `and stays capped (${after} <= 200)`);

    console.log("\nALL LIVE CHECKS PASSED");
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
