## Symptom / context

Uxer slice 6 (harness task #19): UXER-INTEGRATION.md §9 (Theme Editor,
"MANDATORY — all platforms except console"). Distinct from item 7's
light/dark/system toggle: "the toggle lets a user *pick* a preset; the
theme editor lets them *tailor* one." Must expose every palette color,
edit both variants independently, live-preview against the real surface,
Save/Reset/Export/Import, and warn (blocking) on a WCAG AA failure for
body text. Builds on slices 1-5 (decisions/00045-00048).

## Architecture: draft vs. persisted, live preview via inline custom properties

`themeEditor.ts` tracks a **draft** (in-memory, live-applied on every edit)
separate from **persisted** (written to `localStorage["wx-custom-theme"]`
only on explicit Save) — matches the spec's own distinction ("live preview
apply immediately... Save persists to session store"). Live preview sets
inline CSS custom properties on `document.documentElement` via
`style.setProperty`, which win over `style.css`'s own `:root`/
`:root[data-theme="dark"]` rules through ordinary CSS specificity — no
synthetic/iframe preview needed, since editing the admin's own chrome
naturally previews on the admin's own chrome (unlike `themePanel.ts`'s
SITE-theme editor, which genuinely needs an iframe because it's editing a
*different* document than the one it's mounted in).

**Defaults are read from the loaded stylesheet's own CSSOM rules**
(`readDefaultColors` walks `document.styleSheets` for the literal `:root`
/`:root[data-theme="dark"]` rules and reads each `--wx-*` value directly),
not a second hardcoded copy — decisions/00047 flagged this explicitly:
"slice 6 and slice 7 must both read the same source rather than
re-deriving it." This is also what makes "Reset to Defaults" correct even
after a custom override is already applied inline: `getComputedStyle`
would return the *overridden* value once one exists, but reading the
stylesheet rule directly is immune to that.

**Placement**: a third Settings tab, "Appearance" — separate from
General's existing quick theme-mode picker (added in decisions/00047),
matching Uxer's own item-7-vs-item-9 distinction. General keeps a link
into it.

## contrast.ts: the WCAG formula, verified against the actual prior audit

Standard WCAG 2.x relative-luminance contrast ratio, implemented fresh in
TypeScript (no prior JS/TS version existed — decisions/00045's original
palette work was hand-verified via a one-off Python calculation, never
committed). Cross-checked against decisions/00045's own documented ratios
(ink/surface 14.25, muted/surface 4.56, danger/surface 5.93/6.08,
white-on-brand-fill 5.17/4.79) before trusting it for anything — all
matched, confirming the port is correct, not just plausible-looking.

## Two real, previously-unverified WCAG AA failures — found and fixed, not just flagged

Building the live contrast checklist meant listing every foreground/
background pair this app's CSS *actually* renders (traced from the rules
themselves — `CONTRAST_PAIRS` in `themeEditor.ts`), not just the pairs
decisions/00045 originally happened to check. That surfaced two real bugs
in the already-shipped default palette:

1. **`--wx-muted` on `--wx-canvas` (light mode): 4.24:1, fails 4.5:1.**
   Slice 1 verified muted/*surface* (4.56, passes) but `.wx-coming-soon`
   and others render muted text directly on `--wx-canvas` (`.wx-main` has
   no background of its own, showing `.wx-shell`'s canvas through) — a
   background slice 1 never checked *this* color against. Fixed by
   darkening `#667085` → `#616a7e` (a ~4% RGB scale-down, chosen by
   searching for the minimal change that clears both surface and canvas
   with real margin: 4.95 and 4.61 respectively) — same hue character,
   just enough darker.

2. **White text on `--wx-danger` fill (dark mode): 2.77:1, fails even the
   relaxed 3:1 bar.** `--wx-danger` was doing double duty: as *text*
   (`.wx-pages-error`, `.wx-diff-validate`, etc. — verified at 6.08
   against surface in decisions/00045) and as a *fill* under white text
   (`.wx-toast-error`, `.wx-chat-offline-banner`) — never checked in the
   fill role. `#f87171` is a bright, light red specifically because that's
   what reads well as small text on a dark background; that's the exact
   opposite of what a fill needs (dark enough that white text on top still
   clears 4.5:1). This is the identical "one variable, two incompatible
   roles" problem decisions/00045 already solved for `--wx-brand-blue` vs
   `--wx-brand-blue-text` — applied the same fix: split into `--wx-danger`
   (fill; dark mode changed to `#cf3a3a`, found by interpolating from the
   old text-red toward light mode's fill-red and picking the point with
   solid margin on both "white text on it" (4.86:1) and "visible as a
   border against the dark canvas" (3.72:1)) and `--wx-danger-text`
   (unchanged `#f87171`, still correct for its original role). Light mode
   needed no split — `#b91c1c` already clears both roles (6.47 as a
   white-text fill, matching decisions/00045's original text verification)
   — mirroring how `--wx-brand-blue-text` also equals `--wx-brand-blue` in
   light mode.

Both were caught by *actually running the editor against the real
palette* and reading the computed badges, not by theorizing about the
color values — consistent with this whole chain's "watch it run" discipline
(decisions/00046, 00047 found their bugs the same way). Every text/color
usage was re-traced from `style.css`'s actual rules (not assumed) before
deciding which role each pair needed.

**Also fixed while here**: `CONTRAST_PAIRS`' `isLargeOrUi` flag was
initially set `true` for the two white-on-fill pairs, conflating "sits on
a UI element" with WCAG's actual "large text" criterion (>=18pt, or
>=14pt bold — a font-size/weight threshold, not a location one). All ten
pairs are normal 12-13px button/toast/badge text, so all should hold to
the full 4.5:1 bar. Didn't change either verdict at the time (both actual
ratios already cleared 4.5 or failed 3 outright), but left uncorrected it
could have waved through a future near-the-margin edit under the wrong
bar — fixed alongside the real bugs rather than left as latent
inaccuracy.

## The WCAG save gate

"Never let a user save a theme that fails WCAG AA for body text/
background. Warn; require explicit acknowledgement if they override."
Scoped `isBodyText` to the 4 pairs that are genuinely running text on a
background (ink/muted × surface/canvas) — not the other 6 (button fills,
badges, tints), which are real contrast pairs worth *displaying* but
aren't "body text" in the sense the mandate means. Checks both variants
(light AND dark) on every Save attempt, since Save persists both — editing
only dark shouldn't let a pre-existing (or freshly broken) light-mode
failure slip through unseen. Blocked state shows which pairs would fail
and requires a separate "Save anyway" click (not a second click on the
same Save button) to override, so the override is a deliberate, distinct
action rather than an easy double-click habit.

## admin_shell.html: custom colors apply pre-paint too

Extended the existing theme-mode bootstrap block (rather than adding a
separate IIFE) since it already resolves the variant needed to pick the
right half of `wx-custom-theme` — reusing that computation instead of
re-deriving it a second time. Same shape validation as `themeEditor.ts`'s
own `sanitizeColors` (property-name pattern + `#rrggbb` hex) before
touching the CSSOM, even though the only writer is already-sanitizing
first-party code — cheap and consistent with the defensive posture the
other bootstrap blocks already have.

## Verification

321 → 370 admin-ui tests (49 new: `contrast.ts` cross-checked against
decisions/00045 plus both new fixes; `themeEditor.ts`'s draft/persist/
reset/export/import/subscribe lifecycle, including genuine CSSOM-rule
reading via an injected `<style>` tag in jsdom; `settingsPanel.ts`'s new
Appearance tab incl. the WCAG gate's block-then-"Save anyway" flow).
Building the Appearance-tab tests caught two real implementation bugs the
same afternoon it caught the palette ones: a Save that silently no-opped
(root-caused via a forced-failure debug test that dumped a full trace —
turned out to be the WCAG gate correctly blocking a save I'd picked an
insufficiently-contrasting test color for, not a real bug) and a
completely unlabeled "Reset this variant" button (`resetVariantButton`
had no `.textContent` set at all — a real accessibility/UX bug, caught
because the test's button-text selector legitimately found nothing).

Real headless-Playwright run against `e2e/fixture_server.py` (17 checks,
all passing): initial values match the shipped (now-fixed) defaults, live
edit genuinely mutates `document.documentElement`'s computed style, a
passing save round-trips through an actual page reload with the bootstrap
script applying it before `admin.js` even loads, the WCAG gate blocks a
deliberately-broken dark-mode edit and "Save anyway" overrides it, Export
JSON round-trips, Reset-all-settings clears the custom theme too — and
specifically confirmed both real bugs now show a PASS badge in the live
UI, not just in unit tests against a synthetic stylesheet.
