# Decision: the section panel's staged-save model (Edit → Save → Publish)

## Symptom

Purdi, in her own words: it's unclear why entries are greyed out; the "Show on site"
control isn't prominent; editing a text box "doesn't become an edited-looking box";
there's no Save button so she doesn't know how to make changes "ready to be published";
and "Queued to be published needs figuring out… I make some changes and have no idea how
to get them to the publish queue or abandon the changes or undo what I've just done."

The root cause of all four complaints is the same design choice: every field edit in the
section panel (`sectionPanel.ts`) auto-saved to the draft within 300ms via the shared
`OpQueue`, exactly like the rest of the admin. That works fine for the inline page editor
(where the live preview IS the feedback), but the section panel is a plain form-style
screen with no live preview alongside it — an edit that silently vanishes into "the
draft" the instant she looks away gives her no moment to see "this is unsaved," no
gesture that means "I'm done, make this real," and no natural place to hang an "undo my
last change" affordance, since by the time she'd want to undo it, it was already sent.

## What was decided

The section panel now holds edits **locally** (`collectionState`, as before) against a
**saved snapshot** (`savedState`, new) — deep-equal, not reference-equal, so retyping a
field back to its original value reads as clean again. The difference between the two is
"dirty." Nothing reaches the draft until she presses **Save**, which then writes every
dirty collection as one `opQueue.enqueue` batch per collection — Inv 6 (collections
overlay as the whole array) is completely unchanged; only the MOMENT the array reaches
the server moved, from "every edit" to "an explicit gesture."

Three visible surfaces carry the three stages she asked for:

1. **Unsaved** — a changed field gets a `wx-field-dirty` left-accent/tint; a changed card
   gets an "Unsaved" badge; a sticky bottom Save bar appears with **Save** (primary),
   **Undo last** (pops one pre-mutation snapshot off a panel-wide stack, purely local),
   and **Discard unsaved** (reverts every collection to `savedState`, confirmed).
2. **Ready to publish** — once Save succeeds, a banner at the TOP of the panel reads "N
   changes ready to publish" (reading `state.draft.opCount`, the exact number the
   shell's own status-bar chip already shows — deliberately the same source of truth,
   reworded to match) with **Publish** and **Discard all changes** (wires the
   already-built-but-previously-unused `api.discardDraft()` — a real gap this closes for
   free).
3. **Published** — unchanged; the existing publish drawer/pipeline, Inv 25 feedback.

This is a **deliberate divergence**, scoped to this ONE panel. The rest of the admin
(inline page editor, theme panel, page settings) keeps auto-save — that model suits a
live-preview surface, and changing it was never the ask. Purdi's complaint was
specifically about this screen, and it's the only one where a delayed, explicit Save
actually helps rather than adding friction.

## Why deep equality, not reference equality

An earlier design considered skipping `savedState` cloning and comparing `collectionState`
`!==` `savedState` by reference (every existing pure helper in `sectionPanelModel.ts`
already returns a NEW array/object rather than mutating in place, so a naive
reference-equality dirty check would mostly work, and requires no clone at all). Rejected:
it produces a false-positive "dirty" the moment she edits a field back to its original
value (two edits, no net change) — a real, easy-to-hit case ("actually, leave it as it
was") that would leave Save enabled and the "Unsaved" badge showing for a change that
isn't one. `itemsEqual`/`jsonValueEqual` (`sectionPanelModel.ts`) do real structural
comparison — key-order-independent, so hand-authored/re-serialized content can't produce
a spurious dirty flag either. `savedState` IS still populated with a defensive
`cloneItems` (a JSON round-trip) rather than raw references, even though no current
mutator would corrupt a shared reference — cheap for these small photo-gallery arrays,
and removes the need to re-verify that invariant every time a future edit path is added.

## Detecting a Save's success with no visibility into the queue's outcome

`SectionPanelDeps.opQueue` is typed `OpQueueLike` — `{rev, enqueue, flushNow}` only, the
same narrow slice `editView.ts` already exposes to panels. The panel cannot see the
shell-owned `onAccepted`/`onError`/`onRejected` callbacks (those are wired once, in
`shell.ts`, for the whole session). So `saveNow()` cannot directly ask "did that PATCH
succeed?" — it infers it from `opQueue.rev`: snapshot `rev` before enqueueing, `await
flushNow()`, then compare. A successful batch (200) advances `rev`. BOTH failure shapes
— a network/5xx error (the queue re-queues the batch and keeps `rev` unchanged) and a 422
structural rejection (the queue drops the batch, also leaving `rev` unchanged, decisions/
00095) — are indistinguishable from here, and that's fine: either way Save must stay
available and nothing may be marked clean. The shell's own toasts ("Couldn't save your
last change — retrying…" / "That change couldn't be saved…") already tell her WHY; the
panel's own save-bar status line just says "Couldn't save — check your connection and try
Save again," never duplicating the technical distinction.

## Refresh and navigation guards

Two existing/new "something might discard her work" paths both now check dirty state, not
just focus:

- `SectionPanel.refresh()` (decisions/00115 — the shell forces a re-read after a publish
  or a draft repair, since either can rewrite staged-upload srcs behind the panel) already
  deferred while a field had focus; it now ALSO defers while `isDirty()`, re-attempting
  once she saves, undoes, or discards. In practice a `refresh()` almost never lands on a
  dirty panel — Publish auto-saves first (below) — but the guard covers the genuine race
  where another tab/device/the AI assistant publishes while she's mid-edit here.
- `shell.ts`'s `handleRoute` gained a route-change guard: leaving the section panel's
  route with `activeSectionPanel.hasUnsavedChanges() === true` prompts via `win.confirm`.
  Declining reverts the address bar to the section's own path (`win.history.pushState`)
  — by the time `handleRoute` runs, the URL has ALREADY changed (`navigateTo` pushes
  state before dispatching `popstate`; a real back/forward already moved the browser's
  own history entry), so declining must un-navigate the bar, not just skip the remount.
  A real tab close/reload is covered separately by a `beforeunload` listener the panel
  itself owns (added on mount, removed on `teardown()`) — capability-guarded the same way
  `shell.ts` already guards `win.setInterval`/`win.document`, since unit-test fakes of
  `win` may omit timers or `history`.

**Publish auto-saves first.** The panel's own Publish button (in the ready banner) calls
`saveNow()` if dirty, and only opens the drawer (`deps.onRequestPublish`, wired to
`shell.ts`'s `openPublishDrawer()`) once that succeeds — fewest taps, and the drawer must
preview a COMPLETE draft. On a save failure it stays put with the save bar's error
showing; the shell is never asked to open a drawer that can't see her latest edits. The
global status-bar Publish button (unchanged) does NOT go through this — it's the same
`openPublishDrawer()` call it always was, since IT has no local panel state to save.

## Chip wording

The shell's status-bar chip (`renderTopBar`) read "N unpublished changes" / "No
unpublished changes." Reworded to "N changes ready to publish" / "Nothing to publish" to
match the panel's own banner wording verbatim — both read the exact same
`state.draft.opCount`, so using different English for the same number would have been
its own small instance of the confusion this whole change exists to remove. This is a
global rewording (every route sees the new chip text), not scoped to the section panel.

## What to watch for

- A future collection-editing surface that wants the SAME staged model should reuse
  `sectionPanelModel.ts`'s `itemsEqual`/`jsonValueEqual`/`itemDirty`/`fieldDirty`/
  `cloneItems` rather than re-deriving dirty tracking — they're generic over
  `SectionItem[]`, not gallery-specific.
- The undo stack is panel-wide (one array of `{path, items}` snapshots across every
  collection in the section), bounded at 50, cleared on a successful Save or a Discard —
  "undo last" means "undo whatever I just did," matching how she described the ask, not
  "undo the last change to THIS collection specifically."
- `saveNow()` re-renders every collection's body on success (not just the ones that were
  dirty) purely so per-field/per-card dirty markers repaint — cheap for this panel's
  small arrays; don't assume rendering is a no-op there when reasoning about focus/typing
  races the way `refresh()`'s own guard already has to.
- If `OpQueueLike` ever grows a real success/failure signal, `saveNow()`'s rev-comparison
  inference can be simplified — it's a workaround for the seam's current shape, not a
  design goal in itself.
