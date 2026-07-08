# 00008 [758hsg] M8 WX — Media + theme

## What
Upload pipeline (Pillow: orient/strip/resize/re-encode), media panel+dialog+drop-on-
element, reference scan; theme panel with live vars + fonts swap; E2E 2, 3.

## Why
Owner-experience bullets #2 (tap image, replace) and #3 (tweak theme, live preview).

## Context / current state
Depends on 00007 (editor v1 — selection chrome / dialogs) and 00006 (server core).

## Relevant files
- spec/05-editor.md §3-4 (theme panel, media panel & dialog)
- spec/02-content-model.md §9 (media processing rules: EXIF strip, resize <=2000px,
  reject >15MB/non-image/SVG)
- spec/08-testing-acceptance.md §2 E2E flows 2, 3

## How to continue + acceptance
Pillow-verified EXIF strip + auto-orient + resize + re-encode; SVG reject; reference
scan before delete. Theme live-applies via CSS custom properties + font link swap, no
rebuild. E2E 2 (image replace incl. oversized EXIF-rotated fixture) and 3 (theme change
-> publish -> theme.css/fonts reflect) passing.

## Links
PR: (fill in when opened)
