# Mobile: the topbar banner is gone; the ⋯ menu lives in the tabs row

## Symptom

Operator report (2026-08-02, phone, `/admin`): *"The bit that says Wixy
Cottage Aesthetics, and then it has the burger menu. I tap the burger menu,
nothing appears. It's taking up a lot of space. If that burger menu genuinely
doesn't have anything in it, let's just get rid of that whole banner
permanently. And if it does have something in it, move the burger menu to the
tabs area to the right."*

Two defects, one row:

1. **The ⋯ popover never visibly opened.** The topbar carries
   `overflow: hidden` (needed for the desktop edit-view slide-shut animation,
   decisions/00076) and, at ≤720px, `position: relative` to anchor the
   popover. An absolutely-positioned child at `top: 100%` starts below the
   bar's box, so the clip cut the ENTIRE popover — tapping ⋯ toggled a fully
   clipped element. The popover was always non-empty (site link, zoom, font
   scale, screenshot, theme, settings) but could never paint.
2. **The banner cost a full row** (~52px) on a phone to show a title the
   owner doesn't need, above an already-tall chrome stack (status bar +
   banner + tabs).

## Root cause

The narrow-viewport design had parked the secondary controls in a popover
anchored to the one element whose other job (the edit-view slide) required
`overflow: hidden`. The clip and the popover were fundamentally incompatible;
no z-index or positioning tweak inside that anchor could ever show it.

## What was decided

At ≤720px the topbar is `display: none` — permanently, title included (the
operator: "we don't need it"). A new `.wx-navrow` chrome row takes its place:

- It holds the relocated `.wx-nav` tab strip (`flex: 1`, still
  `overflow-x: auto`) with the ⋯ trigger as a `flex: none` sibling OUTSIDE
  the scroll — a trigger that scrolls away with the tabs is a trigger you
  lose.
- It carries the bottom border (moved off `.wx-nav`) so the rule spans the
  trigger too, and `position: relative` with NO overflow clip, so the
  popover (`top: 100%; right: 8px`) finally paints below the row.
- Edit view hides the whole row with the tabs (parity with the old topbar);
  the ▾ chrome reveal shows it again, trigger included.

`shell.ts`'s nav relocation (decisions/00084) became `placeChrome`: on narrow
it moves navEl + trigger + popover into the row; on wide it restores them to
the topbar (title/spacer never move). A breakpoint cross closes the popover
so it can't strand open in the other home.

Desktop is unchanged: the topbar stays, with the controls inline.

## Why

- The operator's conditional was explicit: the menu has real content → keep
  the trigger, move it to the tabs area; the banner itself goes either way.
- Anchoring the popover to a clip-free row is the root-cause fix for "tap ⋯,
  nothing appears" — the alternative (making the topbar clip only during the
  slide) would keep a trap that any future topbar animation re-arms.
- The trigger outside the scroll guarantees it's always one tap away, which
  is the whole point of a menu holding settings/theme/screenshot.

## What to watch for

- Any future CSS that adds `overflow: hidden/auto` to `.wx-navrow` re-breaks
  the popover exactly the way the topbar did — don't; the row must stay
  clip-free.
- The e2e regression is pinned in `mobile-edit-chrome.spec.ts` ("tapping the
  ⋯ trigger on a phone actually OPENS a visible popover"), and the relocation
  in `shell.test.ts` ("topbar overflow menu" + the navRow placement tests).
- The reveal flow in edit view now shows the nav ROW (tabs + ⋯), not the
  topbar; assertions key off `.wx-navrow`, not `.wx-topbar`, at phone widths.
