# Milestone 7 (editor v1) slicing

## Context

Milestone 7 (spec/05-editor.md) is the first TypeScript-heavy milestone — the admin
shell (`admin-ui/`) and the preview-iframe overlay (`editor/`), two independent
esbuild-bundled packages (no shared npm workspace: each has its own `package.json`,
`node_modules`, `tsconfig.json` — confirmed by inspection, no root `package.json` or
workspace manifest exists) communicating only via `postMessage` across the iframe
boundary. Its real scope — shell layout, hash routing, pages panel, edit-mode iframe
host, the overlay's full selection/editing chrome, the bidirectional protocol, and the
shell-owned op queue with PATCH-coalescing and rev/409 replay — is exactly the kind of
size that made M6 (server core) worth slicing into 4 PRs (decisions/00010), so this
milestone follows the same precedent rather than attempting one enormous PR.

## Decisions

**1. Four slices**, in dependency order:
   1. Shared protocol types + the shell-side op queue (pure TS, vitest-tested, no DOM
      wiring to a real iframe) — the contract slice 2 and 3 both build against.
   2. The editor overlay (`editor/`) — selection chrome, popovers, postMessage sender/
      receiver.
   3. The admin shell (`admin-ui/`) — layout, routing, pages panel, edit-mode iframe
      host wired to slices 1-2, page settings drawer.
   4. Full integration wiring + E2E 8 as a real Playwright test + CI green + closing
      decision.

**2. The `{wx: 1, type, ...}` postMessage envelope and every message shape (spec/05
§2) are defined TWICE — once in `admin-ui/src`, once in `editor/src` — not factored
into a third shared npm package.** The two packages don't import each other and never
will (they only ever communicate over `postMessage`, a serialization boundary by
construction); introducing a shared package for a handful of small message-shape types
would be a new build/publish concern for two BUNDLED, esbuild-`iife`-output consumers
that gains nothing a well-commented duplicate definition doesn't already give. Each
copy is written to explicitly cite spec/05 §2 as the single source of truth and note
the sibling package's file path, so a future protocol change is a find-both-copies
edit, not a silent drift risk nobody notices.

**3. Page Duplicate/Delete (`POST /api/admin/pages/duplicate`/`pages/delete`, spec/05
§2, spec/04 §8's page-ops row) is explicitly OUT of scope for milestone 7, despite the
persistent-todos sidecar's "What" line mentioning the pages panel "incl.
duplicate/delete."** Three independent reasons, any one of which would be sufficient:
   - Spec/08 §2's E2E flows 1/4/8 — the three this milestone is bound to — exercise
     text editing, a collection's own item add/reorder/delete, and concurrent-tab
     rev/replay. None exercises page-level duplicate or delete.
   - Building it for real needs NEW backend surface M6 deliberately didn't include
     (spec/04 §8's admin-API table lists `pages/duplicate`/`pages/delete` as a
     separate row from the four M6 built) — a page-ops mutation path on
     `wixy_server.overlay.Overlay.pages_added`/`pages_deleted` (today only settable via
     `empty_overlay`/`load_overlay`'s initial construction, no `apply_patch`-style
     mutator exists for them yet) plus the two routes themselves.
   - Spec/04 §5 step 2 says publish "applies `deleted` as `git rm`" and duplicated
     pages get their template staged at `draft/pages/<slug>.html` — i.e. the
     MATERIALIZATION semantics for page ops are explicitly milestone 9 (publisher)
     territory. Building the draft-side UI/API for an operation before its publish-
     time contract is designed risks getting the shape wrong and redoing it.

   The pages panel ships with its "Edit" action fully working (the one E2E 1/4/8
   actually need); Duplicate/Delete become real once the publisher's page-ops
   handling is being designed anyway (milestone 9, or a dedicated follow-up slice
   once M9 clarifies the contract) — tracked here so it isn't silently dropped.

**4. E2E scenarios 1 and 4 (spec/08 §2) cannot fully pass until milestone 9's
publisher exists** (both end in "→ publish → live change"/"→ publish → output HTML
reflects..."). Milestone 7's own slice 4 wires E2E 8 (concurrent editing, no publish
step) as a real, green Playwright test; 1 and 4 get their editing-side behavior built
and manually/component-tested now, with their publish-dependent tail revisited once
M9 lands — this is a sequencing fact about the acceptance suite, not a scope cut on
this milestone's own work.

## What to watch for

- If milestone 9's page-ops design ends up needing a different draft-side shape than
  what M7 half-anticipated, that's expected — nothing in M7 commits to a page-ops
  contract, by design (decision 3).
- Revisit E2E 1/4's full pass once M9 ships; they're expected to go green then, not
  before.
