# 00002 [luufo5] Ledge & overhang traversal physics & block climbing pathfinder

## What
Implement pathfinding along chat bubble boundaries:
- Scan message bubbles (`.wx-chat-bubble`) in `.wx-chat-thread` to extract bounding boxes.
- Ascending guy path: starts at bottom of chat, climbs side of first block.
  - Overhang case (block above extends further out): reaches underside, stretches arms up, monkey-bar traverses horizontally with dangling legs until outer corner, then climbs up vertical side.
  - Step-in case (block below extends further out): climbs onto top surface, walks horizontally across top, then climbs up side of block above.
- Descending woman path: starts at top of chat, navigates down blocks toward meeting point.
- Dynamic fallback: if fewer than 2 bubbles exist, synthesize playful virtual blocks so animation always works smoothly.

## Why
Faithfully matches the operator's exact physical description of climbing, walking, and monkey-bar traversal.

## Relevant files
- `admin-ui/src/pixelChat/pathfinder.ts`
- `admin-ui/src/pixelChat/physics.ts`

## How to continue & acceptance
Pathfinder produces continuous trajectory with appropriate character animation states at each segment.
