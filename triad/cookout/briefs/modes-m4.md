# M4 — UI (Opus 5.5)

Read `modes-common.md` first. Your files: Appendix A row M4. Spec: §6 in full (start-sheet mode
picker, intro, picking with the bread turn, chef/dishes/card/recipe book, accessibility), the wire A.3,
§8.5 vitest. Docs: your share of §9. Build on the round-2 picture-first screens (09b parcel 4, merged
as PR 381 / 73e10f1e) — reuse their components; do not fork them.

Dependencies: M2's wire is frozen in A.3 — build against JSON fixtures of §5.4 now. The two mode tile
pictures come from M3's early PR; until it lands, use an untracked stand-in image at the same path and
never commit it.

Phone first, measured: verify at 360×640, 390×844, 360×560, 360×480 and 1280×800 (Playwright viewport,
real frame) that the start sheet and every toastie picking state fit with no page scroll, and send me
phone-size screenshots of every new screen with your hand-in. Classic screens must not change.
