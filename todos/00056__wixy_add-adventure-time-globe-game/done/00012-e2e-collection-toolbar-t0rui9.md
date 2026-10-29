# 00012 [t0rui9] E2E 4 collection: toolbar click lands on the wrong list

Full local e2e run 2026-10-28 ~16:10Z (loaded box): collection-edit.spec.ts:72 expected item 2
"New Treatment Card", got "Item Two". Retained trace: the PATCH that resolved the test's
reorderPatch was `_global footer.legal` (expectedRev 5), not showcase.items — the moveUp click
went to the single shared `.wx-item-toolbar` while it was attached to a footer legal link.
Fix the test (and check the overlay) so the click acts on the hovered item's toolbar.

Status: DONE — fixed in PR #352 (4a508f7): toolbar carries data-wx-toolbar-list/index; the test presses only the new item's toolbar (hover+press in toPass, a hover a re-render can undo) and waits for the PATCH it caused.
