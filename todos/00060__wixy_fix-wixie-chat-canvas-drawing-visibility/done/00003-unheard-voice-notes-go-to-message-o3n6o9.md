# Unheard voice notes: Go to message + Previous / Next bar (o3n6o9)

Operator request (2026-10-30): see an unheard voice note in context; Go to message from the list; a bar
above the composer to step to the previous / next unheard note.

Done: Go to message (closes list, reveals + highlights), .wx-srv-unheard-nav bar (gesture-exempt), jump
holds the thread until scrollend (fixed a 3-in-10 snap-back race, also in a quote's jump). Tests: vitest
3688/3688; full e2e 285/285; server-unheard-nav.spec.ts 20/20 repeats. See decisions/00207.
