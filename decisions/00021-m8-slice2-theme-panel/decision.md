# Milestone 8 slice 2: the theme panel, its embedded-preview design, and live font-swapping

## Context

Slice 1 (decisions/00020) shipped the media upload/reference-scan backend. This slice
builds the `#/theme` route (spec/05-editor.md §3): colors, fonts, effects, each
live-applying to a preview, plus per-token and per-panel "reset to published". Slice
1's todos sidecar flagged one real open design question left unresolved on purpose:
spec/05 §3 says a theme change "live-applies to THE edit iframe," but `shell.ts`'s
router only ever mounts ONE main panel at a time — `#/theme` and `#/edit/<page>` are
mutually exclusive routes, never shown together, so there is no "the edit iframe" to
apply to while the theme panel itself is open. This had to be resolved here, not
guessed at again.

## Decisions

**1. The theme panel embeds its OWN preview iframe, reusing `editView.ts`'s
`mountEditView` WHOLESALE — same device toolbar, same overlay chrome, no
stripped-down "read-only preview" variant.** Nothing in this codebase has ever built a
non-edit-mode preview surface (`/admin/preview/<page>.html` always injects
`editor.js`, unconditionally, since milestone 6) — inventing a parallel "chrome-less"
iframe host purely for the theme panel would be new, speculative infrastructure spec
never asks for (spec/05 §8: "do not build speculative hooks"). A user being able to
also click-edit content while previewing a theme change is a harmless side effect of
reuse, not a bug. `EditView` gained one new generic method for this,
`postMessage(message: ShellToOverlayMessage)` — a thin escape hatch `applyOps` itself
is now built on top of — so `editView.ts` stays free of any theme-specific knowledge;
the theme panel is the only caller that uses it directly.

**2. The embedded preview always targets the "index" page — a fixed choice, not
"most-recently-edited".** Every wixy project has an `index` page (spec/03's migration
establishes it as the fixed homepage slug; every fixture/test repo in this codebase —
`builder/tests/fixtures/mini-site`, `wixy_server/tests/test_routes_admin_api.py`'s
inline repo — has one too, confirmed by reading rather than assumed). A fixed default
is simpler and more predictable than tracking "last edited" state across sessions/
navigations for marginal benefit, and avoids a scenario where the preview page
depends on prior navigation history in a way that would need its own tests.

**3. Fonts need a SECOND shell -> overlay message, `themeFonts {url}`, alongside the
already-working `themeVars`.** A font FAMILY change requires the browser to actually
fetch a new Google Fonts stylesheet resource — a CSS custom property re-assignment
alone (what `themeVars` already does for colors and for the `--font-*` variable's
STRING value) can't load a font file. The overlay's handler
(`editor/src/overlay.ts`'s `applyThemeFonts`) finds the existing `<link>` the SAME way
`builder/templates.py`'s `_find_fonts_link` does at build time (href starting with
`https://fonts.googleapis.com/`) and swaps its `href`, falling back to creating one if
somehow absent — mirroring `apply_head`'s own fallback for parity. A font change
still ALSO sends `themeVars` (for the `--font-<role>` variable itself) — the two
messages are complementary, not alternatives.

**4. The Google Fonts URL and the `--font-*`/color/shadow CSS-var map are computed
CLIENT-SIDE via hand-ported TS pure functions (`admin-ui/src/googleFonts.ts`,
`themeVars.ts`), not fetched from the server per edit.** spec/05 §7: "the editor
never blocks on the network for keystrokes" — the theme panel needs live feedback on
every family/weight/italics change before anything is saved, so a server round-trip
per edit isn't an option. Rather than maintain two divergent code paths (server-
computed for initial load, client-computed for subsequent live edits), the client
ALWAYS computes both from whatever `ThemeData` it currently holds — one code path,
no drift risk. This is the same hand-duplication tradeoff decisions/00015 decision 2
already made for `protocol.ts` (no shared package can bridge Python and TS here
either); `googleFonts.test.ts`/`themeVars.test.ts` mirror `builder/tests/
test_theme.py`'s exact cases (including byte-for-byte cross-checked output, verified
by running both implementations against the same inputs during this session) so the
two stay provably in agreement, not just independently plausible.
`GET /api/admin/theme` (new; mirrors `GET /api/admin/content/{page}`'s shape) returns
only the raw merged `theme.json` dict — no server-computed `fontsUrl` field — for
exactly this reason.

**5. A font ROLE (`fonts.serif`, `fonts.sans`, `fonts.script`) is one SET-op token,
not three (family/weights/italics separately).** Matches the existing precedent of
`pageSettingsDrawer.ts`'s `ogImageField`, which already commits a whole `{src, alt}`
object at one path — `dotted_set` (`builder/content.py`) happily replaces an entire
nested value at any depth, so there's no backend reason to split it finer. This also
makes "reset this role to published" a single, unambiguous discard op
(`fonts.<role>`, `discard: true`) rather than three that would need to stay in sync.

**6. Per-token reset uses the EXISTING generic `DiscardOp` PATCH mechanism — no new
backend endpoint.** `{file:"theme", path:<dotted-path>, discard:true}` was already
wired generically by `_to_patch_op`/`apply_patch` before this slice (it's how
milestone 7's per-key discards already worked for page content). Per-PANEL reset
("reset all colors", "reset all fonts") enqueues one discard op per currently-known
leaf key in that section, in a single PATCH batch — the client already has every key
name from its last `GET /api/admin/theme`, so no new "reset a whole section" backend
verb is needed either.

**7. The panel does NOT know, client-side, what value a discard reverts to — so
`ThemePanel` exposes `onOpsAccepted(ops)` (mirroring `EditView.applyOps`'s role but
with different semantics) which the shell calls from the SAME OpQueue `onAccepted`
callback already wired to `activeEditView`.** A SET op is reflected optimistically
the instant the user edits (no round trip needed — matches the OpQueue's existing
optimistic philosophy). A DISCARD op's resulting value depends on whatever the
checkout/upstream currently holds, which isn't computable client-side, so
`onOpsAccepted` refetches `GET /api/admin/theme` (and only then) whenever the
accepted batch contains a `file:"theme"` discard, then fully re-renders the controls
and re-applies the live preview. This is the FIRST thing in the codebase besides
`activeEditView` that the shell's OpQueue `onAccepted` callback fans out to.

**8. Live-apply happens on every `input` tick (drag/type); the OpQueue enqueue
happens only on `change`/commit — mirroring `pageSettingsDrawer.ts`'s existing
`textField` convention and spec/05 §2's own text-editing pattern ("keystrokes update
the element immediately; commit emits the op").** A native `<input type=color>`
already fires `input` continuously while dragging and `change` once on close, which
maps onto this split naturally. Weight checkboxes and the curated-family `<select>`
commit immediately on their own `change` (no separate live/commit split makes sense
for a discrete toggle/pick, matching `pageSettingsDrawer.ts`'s `checkboxField`).

**9. Color swatches are rendered ALWAYS-EXPANDED inline (native color input + hex
field + a presets strip, all visible at once per row) rather than behind a
click-to-open popover.** spec/05 §3 says a swatch "opens a color input… + the site's
current palette as presets" — read here as "reveals/contains its own editor," not as
a mandate for a popover-positioning mechanism. The admin panel is a full-page context
(unlike the overlay's in-iframe popovers, which need `position:fixed` top-layer
treatment specifically because they float over arbitrary page content) — building a
new popover system here would be exactly the kind of parallel, unneeded
infrastructure this project avoids. Each row's presets strip lists every other
current color as a clickable swatch; clicking one copies that value into the row's
own fields and fires the same live-apply + commit path a manual edit would.

**10. A curated ~24-family Google Fonts catalog is a small hand-picked, static list
(`admin-ui/src/googleFontsCatalog.ts`), not fetched from Google's font-metadata API
at runtime.** Matches this repo's self-hosted-assets/no-CDN-calls-from-the-admin-UI
posture. 8 serif / 8 sans-serif / 8 script families, each category headed by the
site's OWN current font (Cormorant Garamond, Jost, Pinyon Script respectively) so the
existing choice is always visible as a preset, not just reachable by re-typing it. A
single fixed weight-checkbox set (300/400/500/600/700) is offered for every
family/role alike rather than a per-family weight-availability table — Google's
css2 API tolerates a requested weight a family doesn't actually publish (serves the
nearest match, doesn't error), so this is a deliberate simplification, not a gap.

## Verification

Backend: `wixy_server/routes_admin_api.py`'s new `GET /api/admin/theme` (merges the
overlay same as every other read path, 404s when `theme/theme.json` doesn't exist yet
— the pre-migration-step-4 state, decisions/00004) + `TestGetTheme` (4 new tests:
merged shape, a drafted color survives merge, a discarded op reverts to the checkout
value, missing-theme 404). `python -m pytest` 376 passed (was 372); `mypy --strict`
clean (76 files — no new Python source file, only edits to existing ones); `ruff
check` + `format --check` clean.

Frontend: `editor/src/protocol.ts` + `admin-ui/src/protocol.ts` (both hand-synced,
decisions/00015 decision 2) gained `ThemeFontsMessage`; `editor/src/overlay.ts`
gained `applyThemeFonts` + 2 new tests (swap an existing link, create one if absent).
`admin-ui/src/googleFonts.ts` (new, `buildFontsUrl`) + `googleFonts.test.ts` (6
tests) and `admin-ui/src/themeVars.ts` (new, `themeVarsFromTheme`) +
`themeVars.test.ts` (2 tests) — both cross-checked byte-for-byte against
`builder.theme.generate_fonts_url`/`generate_theme_css` for the same inputs during
this session, not just independently plausible. `admin-ui/src/themePanel.ts` (new) +
`themePanel.test.ts` (15 tests): mounts the embedded preview on "index", live-applies
on load, renders one row per color key, SET-on-change/live-on-input for hex fields,
invalid hex never commits, per-token and per-panel resets enqueue the right discard
ops, curated-family pick and weight-toggle both commit a whole-role SET, shadow
field, `onOpsAccepted` refetches only for a theme-file discard (not a SET, not a
different file), teardown propagates to the embedded view. `admin-ui/src/shell.ts`
wires `#/theme` to `mountThemePanel` (replacing its "coming soon" placeholder) and
fans `onAccepted`'s ops out to `activeThemePanel?.onOpsAccepted` alongside the
existing `activeEditView?.applyOps`; `shell.test.ts` updated (the old
"stub-route-shows-coming-soon" test now exercises `#/media` instead of `#/theme`; 2
new tests cover the real theme panel mounting + its embedded view's teardown on
route change). One real jsdom gotcha hit and fixed during testing (not theorized):
`HTMLInputElement.click()` on a checkbox that was never appended to `document` does
NOT fire `change` in this project's jsdom version (confirmed with a throwaway
isolated repro before touching any real test) — the weight-checkbox test drives the
same observable state directly (`checked = true` + `dispatchEvent(new
Event("change"))`) instead of relying on `.click()`'s connectedness-gated default
action; plain `<button>`/`<select>` event dispatch was unaffected and needed no
change.

`npm run typecheck` clean for both `admin-ui` and `editor`; `npm test` 102 passed
(admin-ui, was 76 — verified by measuring both sides of a `git stash`, not guessed)
and 104 passed (editor, was 102); `npm run build` re-run for both packages, bundle
output committed alongside source (CI's `frontend` job's drift check: `git diff
--exit-code -- wixy_server/static`).

## What to watch for

- Slice 3 (media panel + dialog + the editor's `mediaRequest`/`applyOps` rewiring)
  is next — its design was already fully worked out in slice 1's todos sidecar
  (`todos/00004.../00008-media-theme-758hsg.md`); re-read it before starting, don't
  re-derive it.
- The theme panel's `onOpsAccepted` pattern (shell fans accepted-ops out to whichever
  panel cares) is now precedent for anything else that needs to react to accepted
  ops beyond the active edit view — reuse the same shape rather than inventing a
  parallel notification mechanism if a future panel needs it too.
- The jsdom "disconnected checkbox `.click()` doesn't fire `change`" gotcha applies
  to ANY future test in this codebase that drives a checkbox/radio via `.click()`
  without appending it to `document` first — prefer a direct `checked = ...` +
  `dispatchEvent(new Event("change"))` (as this slice's tests now do) unless the
  test is deliberately appending elements to `document.body` (as `overlay.test.ts`
  already does for its own, unrelated reasons).
