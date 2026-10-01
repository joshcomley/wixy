# 00008 [268ysf] Polish recording-row Cancel and Stop & Send controls

## What

Move voice-recording Cancel to the left edge as a cross and style Stop & Send like the blue Send button.

## Outcome

Independently reviewed candidate `9c05238d054bc9ae148b347d3cbb1c961a99cf89`; cleared with 0 critical / 0 high. PR #295 merged to `main` as `6bf7918adbf4464332847ddc434b5ab499acea7e`. Wixy production and loopback both report version 77 on the green slot at that commit.

Independent checks: typecheck passed; focused Vitest 192/192; Playwright media/reactions 13/13; clean diff check; LF line endings; generic release-note trailer. PR CI passed 6/6.

## Where shipped

[PR #295](https://github.com/joshcomley/wixy/pull/295). Release question recorded in Answers Q-023.