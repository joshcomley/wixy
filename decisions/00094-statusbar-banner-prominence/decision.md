# The unpublished-changes bar: no nested pill, and prominent only when it matters

## The ask (operator, 2026-07-30)

"Please can you make the unpublished changes banner a bit tidier. We don't need
the nested bubble around the text, and the whole banner needs to be more
visually prominent."

## What was wrong

`.wx-statusbar` (decisions/00083) held a `.wx-draft-chip` styled as a pill —
`--wx-canvas` fill, 1px border, `border-radius: 999px` — inside a bar that
already had its own `--wx-surface` background and border. **A box inside a banner
is redundant chrome:** the banner is the container, so the nested rounded box made
the bar read as a control tray rather than a message.

Prominence was actively working against it: `4px` vertical padding, `0.75rem`
text in `--wx-muted`, and the **same `--wx-surface` background as the topbar
directly below it** — so the one always-visible "you have unpublished work"
surface blended into the chrome around it. On a phone the `≤720px` rule shrank it
further to `0.6875rem`, which is why it read as incidental in the operator's
screenshot.

## What was decided

**1. The chip is a label, not a pill.** Background, border, radius and padding
dropped; it's now `600 0.875rem` in `--wx-ink`, underlined on hover. It stays a
`<button>` (it opens the review drawer, and `ai-lane.spec.ts` clicks it), but it
needs no box to advertise that: **the Publish button beside it opens the same
drawer**, so the chip is a convenience trigger, not the only route in. Element and
class names are unchanged, so every existing selector still resolves.

**2. The bar is prominent WHEN THERE IS WORK, not always.** A new
`.wx-statusbar-pending` class (toggled in `shell.ts:renderTopBar`) gives it the
`--wx-brand-blue-tint` background and a 2px `--wx-brand-blue` bottom rule, tying
it visually to the Publish button it sits beside. With nothing to publish the bar
falls back to the plain surface colour and its label goes muted/regular-weight.

This state-dependence is the deliberate part. An always-loud bar reading "No
unpublished changes" would train the owner to tune out the exact surface that has
to get their attention when it matters — the prominence has to *mean* something.
The class is keyed off "is there anything to publish" (local draft ops **or**
outside site updates), and is also applied while a publish RUNS, since the chip is
narrating live stages then (decisions/00089) and the bar going quiet mid-publish
would be the worst moment for it.

**3. The quiet-state styling is keyed off the BAR's class, not the chip's
`disabled` attribute.** Tempting but wrong: the chip is *enabled* when there's
nothing to publish (it still opens the drawer), and *disabled* in a completely
different state — mid-publish, where the text is a live stage narration that must
stay legible.

**4. Publish button keeps its natural padding.** The old `padding-top/bottom: 4px`
override existed to match the pill's height; in the taller banner that read as an
undersized tap target, and `align-items: center` already prevents it stretching.

Rejected: a solid brand-blue band with white text. That is *more* prominent but
repeats the exact readability mistake decisions/00093 had just fixed in the chat
bubbles (saturated fill + white body text), and it would collide with the Publish
button sitting inside it.

## What to watch for

- **Don't make the pending styling unconditional.** Point 2 is the whole design;
  `shell.test.ts` pins both states ("goes prominent" / "stays quiet"), so
  hard-coding the class fails the suite.
- **`--wx-brand-blue-tint` must stay legible under `--wx-ink` in both themes** —
  verified computed on a real render: light `#eaf0fe`/`#1e2430`, dark
  `#1e2a47`/`#e4e7ed`. If that token is ever retuned, re-check this bar and the
  chat bubbles (decisions/00093) together, since both now depend on that pairing.
- **Truncation, not shrinking, is how the label copes with narrow screens** —
  `.wx-statusbar .wx-draft-chip` keeps `flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis`. The mobile rule now only steps the font to
  `0.8125rem`; don't reintroduce a tiny size to fit more text in.
