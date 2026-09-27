# Decision 00179: Pixel art character interaction in chat on 30s idle

## Context
When the Wixy chat interface is left open and inactive for ~30 seconds, the operator requested a playful, retro pixel art animation gimmick:
- A guy in a pink suit appears at the bottom and climbs up along chat blocks.
- A woman in a blue dress appears at the top and climbs down along chat blocks.
- Chat block traversal:
  - Vertical climbing up/down the outer walls of message blocks (`.wx-chat-bubble`).
  - When reaching an overhang (the block above extends further out horizontally), the character stretches their arms up, grasps the underside of the overhead block, and monkey-bar shimmies across with dangling, swinging legs until reaching the outer vertical edge.
  - When reaching a step-in (the current block extends further out than the block above), the character climbs onto the top surface of the current block and walks horizontally across the top to reach the wall of the next block.
- When they meet in the middle:
  - A retro pixel-art wooden platform smoothly scrolls out from the wall.
  - The characters embrace at the wall edge.
  - They push off the wall and leap across together onto the platform.
  - They lie down side-by-side on the platform and cuddle, with floating pixel heart particles rising softly.
- Interactivity & Interruption:
  - If a message comes in (or activity occurs) whilst they are climbing/traversing, they both stumble (flailing arms, startled expressions, hop backwards off the ledge) and tumble/fall off the bottom of the screen under gravity.
  - If a message comes in (or activity occurs) whilst they are lying down cuddling on the platform, the platform collapses downward (pivoting at the wall anchor), and the couple clutches each other, slides down the incline, and falls off the bottom together.
  - Any movement or incoming message interrupts them; staying still allows the full romantic sequence to unfold.
  - Canvas uses `pointer-events: none` and does not block text selection, link clicks, or message interaction.

## Architecture
- `admin-ui/src/pixelChat/`:
  - `types.ts`: TypeScript contracts for sprites, trajectories, waypoints, platforms, particles, and controllers.
  - `sprites.ts`: Deterministic color-indexed pixel matrices (scaled with crisp pixel rendering) for the guy in the pink suit, the woman in the blue dress, the scrolling platform, and heart particles.
  - `pathfinder.ts`: Trajectory planner that scans `.wx-chat-thread` bubbles and computes continuous paths with overhangs (`hang_traverse`) and step-ins (`walk_top`), falling back to synthetic stepping blocks when few bubbles exist.
  - `scene.ts`: 60fps canvas animation director managing the 5-phase choreography (traversal -> platform deployment -> embrace -> jump arc -> cuddle).
  - `idleWatchdog.ts`: Event listener tracking 30s of inactivity and user dismissal triggers.
  - `index.ts`: `mountPixelChat(threadWrap, options)` mounting entry point.
- `demos/pixel_art_chat_demo.html`:
  - Standalone interactive presentation demo page with speed selector, layout presets (Overhangs, Realistic, Empty), live state inspection, and sprite showcase, viewable via cmd file serving.

## Verification
- Vitest suite in `admin-ui/tests/pixelChat.test.ts` (11 tests) and `tests/chatPanel.test.ts` (58 tests) passing.
- Full `admin-ui` test suite passing (91 test files, 2403 tests).
