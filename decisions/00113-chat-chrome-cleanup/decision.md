# Chat chrome cleanup — icon header, deep-linked preview chip, flat single-line composer

## The ask

Operator feedback (2026-08-02, same day as 00110 shipped, with a fresh phone
screenshot of the new conversation view). Quoted:

- "the all conversations can lose the text, all conversations, and just be a more
  substantial back arrow."
- "show reasoning. We can just get rid of that. We don't need that button at all."
- "rename can just be a pencil icon."
- "We also don't need the little block of text that says changes will appear in the
  preview. Rather, the notification … that appears and says 'changes have been
  published' should include a link to the preview to go and view that change. If it's
  to a specific page, it should be a link to a specific page that's been edited. If
  there are multiple pages that have been edited, we should just go to the homepage."
- "the chat area at the bottom is a bit goofy in its layout. It's very tall for no
  reason before anything's been typed in. And we want more of a layout like we have
  in CMD, where we don't need the outer wrapper. We instead want just the button to
  the left, the button to the right, and an edit box in the middle. We don't need the
  outer box around the whole area."

## What was decided

### Header — icons, less chrome

- Back is now a substantial **arrow-only** button ("←", 40px/44px touch target,
  `aria-label="All conversations"` + `title` for hover), no "All conversations" text.
- **Rename is a pencil** ("✎", `aria-label` + `title="Rename conversation"`).
- The **"Show reasoning" toggle is GONE** — the owner never needs the model's
  chain-of-thought. This cascaded: `chatPanel.ts` dropped the toggle, its handler,
  and the `includeThinking` state (the stream already defaults to excluding thinking
  messages, which is what spec/06 §1's default-off wanted); the obsolete toggle test
  was replaced with a header-shape test. `api.ts`'s `openConversationStream` keeps
  its optional `includeThinking` param (backend capability, no longer surfaced).

### Static explainer removed; the chip now deep-links

The static "Changes the assistant ships land in your draft preview…" paragraph is
removed (`.wx-chat-banner` no longer rendered). The **"Preview updated — review
changes" chip now deep-links**: after an assistant message, the upstream check
additionally fetches the publish preview and attributes the change — exactly ONE real
page in `preview.changes` → that page's Edit view (`#/edit/<slug>`); anything else
(multiple pages, only `_global`/`theme` keys, empty) → the Pages list. This
generalises the original decisions/00097 "always link to pages" note, which stood
only because commit metadata couldn't attribute pages — the publish preview's
page-grouped changes CAN. (The operator said "multiple pages → the homepage"; the
Pages list is the correct admin-side destination for reviewing a multi-page draft
before publishing — the homepage is the live site, a different concern — noted for
him explicitly.)

### Composer — flat, single-line when empty

The 00110 outer input CARD is gone: the composer is now a flat row —
**📎 | auto-growing input | Send** — no bordered wrapper around the whole area (the
"like CMD" layout the operator asked for). The textarea carries its own quiet border
+ focus ring. The empty state is a **single line (36px)** instead of 00110's two-row
floor ("very tall for no reason before anything's been typed in").

## The hard part: a single-line auto-growing textarea is impossible with `field-sizing: content` in this engine

This cost the most investigation and is why the implementation is NOT the
modern-native path. 00110 used `field-sizing: content` (auto-grow in pure CSS) with a
scrollHeight fallback. Getting the EMPTY state down to one line required an
escalating series of live diagnoses (throwaway Playwright probes against the real
e2e server, measuring computed styles — never theorised):

1. `rows="1"` → still 52px (field-sizing's intrinsic floor is TWO rows ≈ 50px).
2. `style.height = "36px"` inline → still 52px (field-sizing overrides explicit height).
3. `style.maxHeight`/class `max-height: 36px` → still 52px.
4. `style.fieldSizing = "border-box"` (disable from JS) → **silently dropped** — the
   property is READ-ONLY in this engine: `CSS.supports("field-sizing","content")` is
   true, but assigning it does nothing (measured: computed value stays `content`).
5. A class rule `.wx-chat-input-empty { field-sizing: border-box }` → still computes
   `content` (base rule wins; and even `border-box !important` on the class computed
   `content` in one probe — the served stylesheet was also found to intermittently
   lack the class rule from `document.styleSheets` while a raw fetch of the same URL
   contained it, an unrelated stale-renderer artifact that cost a diagnostic detour).

**Conclusion:** with `field-sizing: content` active, a ~36px single-line textarea is
unreachable in this engine generation. The ONLY mechanism that reliably yields 36px
empty AND correct growth is the classic scrollHeight dance — so the composer now uses
**scrollHeight auto-grow unconditionally** (no `field-sizing` on the base rule at
all), with `.wx-chat-input-empty` pinning the empty floor (36px) and its
`field-sizing: border-box` kept as a belt-and-braces override should the property
ever be reintroduced on the base rule. One proven path for every engine, no
dual-path drift. Content → grows from 2 rows to the 180px cap, then internal scroll.

## What to watch for

- If `field-sizing: content` matures (the empty-floor + read-only quirks are engine
  bugs/immaturity), the native path could be revisited — but there's no functional
  reason to; the scrollHeight dance is complete and proven in all engines.
- The preview-chip deep-link assumes `preview.changes` keys are page slugs except
  `_global`/`theme`. If a future change kind adds a non-page key, it falls back to
  the Pages list (safe default), which is the correct neutral destination.
- The reasoning toggle is gone from the UI but the backend `includeThinking`
  capability remains — if a future surface (a developer/debug view) wants it, the
  stream param is still there.

## Verification

vitest 624 (updated floor test → class-based; new header-shape, chip-deep-link ×3,
banner-gone tests; obsolete reasoning-toggle test removed), tsc clean, e2e
`chat-ux.spec.ts` passes end-to-end (new 00113 legs: header icons + 44px back
target, no reasoning toggle, no banner, flat transparent composer row, single-line
empty composer ≤48px, grow-on-type, snap-back-on-empty).
