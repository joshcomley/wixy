# 00018 — Composer draft recovery (reload mid-edit loses nothing)

**Requested:** 2026-07-21 (operator): "if ever something's being edited, but then the
page reloads for whatever reason, mid-edit some text, it should remember the text… hey,
you were editing this before, would you like to restore?"

**What (decisions/00088):**
- `composer.ts`: new `draftKey` option — every input persists `{text, updatedAt}` to
  `localStorage["wx-composer-draft:<key>"]` (try/catch, best-effort); reopening with a
  stored draft ≠ seed shows the in-composer banner ("You were editing this before
  (<ago>). Restore what you typed?" + Restore/Discard); Restore refills through the
  input pipeline (preview + refit + re-save); commit AND cancel clear (all 4 paths);
  identical-to-seed drafts cleared silently.
- `overlay.ts`: `composerDraftKey(target)` — `<page>:<key>`; item-scope keys add the
  item's index in its innermost list.
- `style.css`: `.wx-composer-draft-banner` (dark-sheet notice row between toolbar and
  textarea).
- Scope: text composer only (control sheets = separate shape, noted in the decision).

**Tests:** editor vitest +7 (persist per keystroke, banner restore/discard, commit/
cancel clear, identical-seed silent clear, no-key no-op) — 4 RED-proven (3 vacuous
guards). e2e composer-recovery.spec.ts NEW: type → reload mid-edit → banner → Restore
refills → cancel clears → nothing offered; Discard keeps seed + sticks. Both RED-proven.
Ad-hoc 10/10 at 390+320 dark; banner screenshot eyeballed.

**Gates:** editor vitest 199, tsc strict; pytest + full e2e: see index line / PR.

**PR:** (filled at ship) · **Decision:** decisions/00088
