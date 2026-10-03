# 00001 [04s922] Technical brief, pixel art sprites & character animation engine

## What
Design and implement the pixel art sprite engine for the two characters:
- Guy in a pink suit (pink suit jacket, pink trousers, dark hair, stylish design)
- Woman in a blue dress (blue gown/dress, detailed hair, elegant design)
Each with crisp retro pixel art rendering, scaled integer pixel factors, and animation frame states:
- Vertical climbing (up for the guy, down for the woman)
- Horizontal walking across block tops
- Overhang/monkey-bar traversal (arms stretched up holding ledge, dangling legs swaying)
- Jumping / leaping
- Embracing & cuddling

## Why
Delightful idle interaction requested by the operator when chat is quiet for 30s.

## Context & current state
Chat thread renders bubbles (`.wx-chat-bubble`) inside `.wx-chat-thread`.
A canvas overlay mounts over the thread with `pointer-events: none` and pixelated rendering (`image-rendering: pixelated`).

## Relevant files
- `admin-ui/src/pixelChat/sprites.ts`
- `admin-ui/src/pixelChat/types.ts`
- `admin-ui/src/pixelChat/renderer.ts`

## How to continue & acceptance
Sprites render crisply without anti-aliasing blur, supporting multiple animation frames per state.
