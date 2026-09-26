# 00004 [n4t8qk] Pen toolbar: collapse it while drawing; tap the draw icon to bring it back

## What (operator's words, 2026-09-27, while trying the shipped live-drawing feature)
"With the drawing, the drawing overlay is permanently on display, which limits the area that I can
actually draw on. So would you please be able to slightly redesign that? So you tap the draw thing,
you select your pen size, and you click start drawing, and that then collapses. Or in fact, yeah,
you can just put a collapse thing on it. And then whilst you're in draw mode, the draw icon is
selected, and if you tap it again, it brings it out. That's all we need so to be able to collapse
it and tap the draw button again and it opens it whilst you're in draw mode."

Folded into the same builder parcel as [8mz3wl] (voice-note recording row + mic line icon):
builder workspace 00036, session 6488657b-33ed-455d-97ef-783f12ac3236 (Gemini 3.8 Flash High),
dispatched 2026-09-27 ~00:27 UK.

## Current state (read, not guessed)
- `.wx-srv-pen-toolbar` (`admin-ui/src/server/drawingLayer.ts`, built ~lines 224-352, shown/hidden
  ~1255-1264; CSS `admin-ui/src/server/chat.css` ~1874-2089) sits between the header and the thread
  the WHOLE time the pen is on — that is the "permanently on display" overlay eating drawable area.
- The header Pen button toggles pen on/off today (`drawingLayer.ts` ~line 365, `setPen(!penOn)`),
  `aria-pressed` tracks pen-on (~line 1249-1250), and the toolbar has an existing Done button.
- The toolbar wraps onto a second line on phones (chat.css:1871 comment), so the lost area hurts
  most exactly where the operator was drawing (his phone).

## What to build
1. A collapse affordance on the toolbar collapses it while drawing stays live (strokes still land;
   the full thread area is drawable).
2. Pen on + toolbar collapsed + tap the Pen button => the toolbar RE-OPENS (must NOT turn the pen
   off). Pen on + toolbar open + tap the Pen button => collapse it. The draw icon is the toolbar
   toggle while in draw mode; exiting draw mode is the toolbar's existing Done button.
3. `aria-pressed` keeps reflecting pen-on; add `aria-expanded` for toolbar-open; update every test
   encoding the old pen-button toggle semantics.
4. Manual collapse control only — the operator floated auto-collapse-after-picking-a-size then
   withdrew it ("you can just put a collapse thing on it").
5. CSS doctrine: desktop AND mobile, Playwright-verified at 360/390px; any `hidden`-toggled class
   gets the `.<class>[hidden]{display:none}` guard AND a `HIDDEN_TOGGLED_CLASSES` entry in
   `admin-ui/tests/serverChatCss.test.ts`.
6. Tests: vitest for the collapse state machine + pen-button behaviour (the drawing suites were
   78/78 at ship); extend the drawing e2e — pen on -> toolbar visible -> collapse -> draw a stroke
   -> tap Pen -> toolbar back -> Done exits — desktop + one phone width, real click targets.

## Links
Live drawing shipped as PR #286 (main `e0eed7c`; decisions/00175 server, 00176 client; manual
docs/ai/livechat.md sections 18-19 — update them in the same commit as the behaviour change).
