# 00016 — Hover chip + item toolbar anchored to the document, not the viewport

**Reported:** 2026-07-21 (operator, third report, with screenshots): "when I select some
text, and then scroll, the outline stays in the right place but the 'text' tag isn't
anchored properly to it."

**Root cause:** the chip (`.wx-hover-chip`) and list item toolbar (`.wx-item-toolbar`)
were `position: fixed`, pinned once at hover time via `positionNear`'s viewport coords —
any preview scroll left them behind while the class-based outline tracked the element.

**Fix (decisions/00086):** new `positionInDocument(el, anchor)` (document coords,
absolute, doc-bottom flip guard) in `editor/src/popovers.ts`, used for both chip and
toolbar in `overlay.ts`; stylesheet fallback `position: absolute`. Zero listeners —
structural, rides the page under every scroll mechanism. Link/image popovers deliberately
KEEP viewport anchoring (editor surfaces like the composer; reachability beats
attachment — the two anchoring classes are documented in the decision).

**Tests:** editor vitest: chip coords bake in scrollX/scrollY (RED-proven: was fixed,
no inline position). e2e `hover-chrome.spec.ts` (NEW, touch contexts — desktop mouse
re-hover poisons the compare; Mobile-sim page is short so assert the MEASURED scroll
delta): chip glued on scroll after tapping text; item toolbar glued on scroll. Both
RED-proven against stashed old code (drift = scroll delta), GREEN after.
Ad-hoc 390+320 dark: drift 0.00 both; screenshot eyeballed (chip at outline's corner).

**Gates:** editor vitest 192, tsc strict; admin-ui untouched (463, tsc green as shipped).
pytest + full e2e: see index line / PR.

**PR:** (filled at ship) · **Decision:** decisions/00086
