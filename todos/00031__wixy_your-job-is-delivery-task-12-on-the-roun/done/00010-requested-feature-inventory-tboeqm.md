# 00010 [tboeqm] Inventory operator-requested Wixy features across handovers

## What

Read-only inventory of operator-originated Wixy product requests in the accessible handover lineage, deduplicating corrections and checking delivery status.

## Outcome

The scout found 11 top-level asks/work items in six available handover documents. My source cross-check adds two omitted view-once requests and records the later drawing-header addendum as a refinement, for 13 distinct asks/work items in the available evidence. Three provider-continuation transcripts are copies of one underlying conversation across provider switches, not three independent histories. The unrelated `before-after-gallery-enhancement.md` was excluded. No source was found before session `5c02ee2a`, so this is not verifiably the full set of 15 handovers.

| # | Operator request | Status / evidence |
|---|---|---|
| 1 | Make Playwright/E2E 10–100x faster | Partial: PR #279 sped the suite up about 2.5x; follow-up replacing fixed login sleeps remains open as `g491g0`. |
| 2 | Add live collaborative drawing (pen, color/size, select/delete, anchored to chat) | Shipped: PRs #286/#287. Later addendum: hide settings cog; add session Undo/Redo; close exits and discards the in-progress drawing. Shipped in PR #293. |
| 3 | Fix urgent disk-space loss | Operational request, not a user-facing feature: PR #283 plus Aim.SlotSwap PRs #195/#196; cleanup verified. |
| 4 | Add view-once photos/videos with chosen duration and a Spotlight reveal effect | Shipped: PR #271. |
| 5 | Redesign view-once control as a prominent composer button and bottom sheet | Shipped: PR #277 (spec/design PR #276); Architect ratification conditions included in the implementation. |
| 6 | Rename Spotlight to Tease | Shipped: PR #284. |
| 7 | Preview Tease while composing and add a viewer speed slider | Shipped: PR #285. |
| 8 | Let the pen toolbar collapse and reopen via the draw icon | Shipped: PR #293. |
| 9 | Give voice recording its own row with pause/resume; replace mic emoji with a line icon | Shipped: PR #293. |
| 10 | Add an optional “Ask before playing audio messages” setting | Shipped in PR #293 (commit `055b6bc`). The scout found its DONE closeout missing from committed `TODO-00029.md`; the current DM working copy has an uncommitted DONE line. |
| 11 | Add a bottom-of-transcript Re-transcribe action and preserve old text if retry fails | Shipped in PR #293 (commits `47a0298`, `2a3a180`). The committed TODO journal likewise lacked a DONE closeout; the current DM working copy has one uncommitted. |
| 12 | Put the transcript action left and message time right on one row | Shipped: PR #294. Residual non-blocking view-once timestamp/reaction regression and whitespace cleanup remain open as `lr4uac`. |
| 13 | Move recording Cancel to a far-left cross and style Stop & Send like Send | Shipped and live: PR #295, merge `6bf7918`. |

## Remaining gaps

- `g491g0`: replace fixed E2E login sleeps; not started.
- `lr4uac`: restore time/reactions on view-once bubbles and remove six whitespace-only additions from PR #294.
- The view-once composer has an operator-owed real-phone check in task `ny0oiw`; code is shipped, but the manual check is not recorded as completed.
- PR #289 fixed section-panel refresh overwriting an edit, but the available handover files contain no direct operator-authored source wording; it is not counted among the verified requests.
- The two DONE entries for `p3r8vk` and `t6w2qb` are now present in this local TODO working copy, but these changes are uncommitted and therefore absent from committed `main`.

## Sources reviewed

- Three chained provider-continuation transcripts: `5c02ee2a`, `7b7869b2`, `8a7a6a65`, `b96e8c95` (cumulative copies across provider switches).
- `2609261044-view-once-composer-redesign-ratified-conditions.md`.
- `2609261517-disk-incident-drawing-tease-rename.md`.
- `2609262249-live-drawing-audit-then-voice-note-pause.md`.
- `todos/TODO-00029.md`, ten sidecars, decisions/00169–00178, and PR/commit ancestry.
- `before-after-gallery-enhancement.md` was found but excluded as an unrelated, superseded workspace 00002 document.