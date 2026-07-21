# Draft writes are sanitized kind-aware (only text-kind string leaves)

## Symptom

`builder/sanitize.py`'s docstring has always claimed the sanitizer is "applied on
every draft write server-side (04 §9)". It was not: `overlay.apply_patch` stored
op values verbatim — proven when the chrome-leak incident (decisions/00073) left
raw `<button class="wx-if-eye-toggle">` markup sitting in the prod draft overlay.

## Why kind-aware, and why not sooner

A blanket "sanitize every string on write" is WRONG for this store: draft values
are kind-heterogeneous. `href`/`img.src`/meta strings are not HTML — nh3 would
entity-escape `&` in query strings and corrupt them. The sanitize must apply
only to strings that are HTML-substrate, i.e. **text-kind binding values**.

Enforcement at write time (rather than relying on render-time alone, which has
always sanitized at `_apply_text`) means every consumer of the STORE — publish
preview diffs, version diffs, the AI lane, future tooling — reads values that
already meet the 02 §5 contract, without each re-deriving the allowlist.

## Decision

New `wixy_server/draft_sanitize.py` runs inside the PATCH route
(`_apply_draft_patch`) before `apply_patch`:

- `{file, path}` → binding field via `extract_bindings_map` (raw templates —
  overlay affects values, not structure). `_global` ops resolve `@{path}` by
  scanning each page's map (globals are bound FROM pages).
- `text` kind + string → `sanitize_rich_lite`. `list` kind → recurse per item
  leaf by the item template's field kinds (nested lists included).
- Anything unresolvable (meta.*, theme, staged-for-add pages whose templates
  don't exist yet, unknown keys) passes through VERBATIM — the overlay is a
  general key/value store, not exclusively rich-text.

Rejected: blanket recursive sanitize (corrupts URLs/meta — see above); rejecting
non-clean values with a 4xx (editor + AI lanes would need pre-flight sanitation
knowledge; sanitize is idempotent and deterministic, so normalizing is strictly
better than refusing).

## What to watch for

- Sanitized storage means stored text values carry canonical entity forms
  (`&amp;`) — the editing surface decodes for display at seed time
  (composer/demote concern, decisions/00075), so this is invisible to users.
- `KindResolver` caches per-page maps per PATCH; extraction walks raw templates
  only, so a page mid-`pages_added` (template not yet materialized) simply
  yields no kinds — its ops pass through.
- Tests: `TestPatchDraftSanitize` (RED-verified against the pre-fix code).
