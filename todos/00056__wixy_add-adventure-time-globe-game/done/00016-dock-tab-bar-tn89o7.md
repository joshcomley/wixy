# 00016 [tn89o7] Dock the bottom tab bar

Operator 2026-10-28 21:09 (screenshot cmd-uploads/6afa59db…): "The tabs at the bottom should be docked … unnecessary
padding on the left, right, and bottom". `.wx-srv-tabs` had `margin: 0 0 4px` inside `.wx-main`'s gutter. Builder
d9f9e463 (build space bs3): full-bleed, flush bottom, safe-area inset inside the bar; e2e asserts left 0 / right =
viewport / bottom = viewport.

**Done.** PR #355 merged as 41483bb; live 2026-10-28 21:38:19Z, the public stylesheet carries the docked rule.
