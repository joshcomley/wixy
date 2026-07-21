# 00006 — Kind-aware sanitize_rich_lite on draft writes (spec/04 §9 gap)

**Status: not started. PR-A2, after 00005 ships.**

`sanitize.py`'s docstring claims draft writes are sanitized server-side (04 §9) —
they are NOT: `apply_patch` (wixy_server/overlay.py:140) stores values verbatim;
only BUILD sanitizes (`_apply_text`). The chrome-leak incident proved the gap
(`<button>` markup sat staged in the prod draft).

## Design (decided)

- Sanitize on draft write in the PATCH path (routes_admin_api.patch_draft or
  apply_patch), but ONLY text-kind string leaves: draft values are
  kind-heterogeneous — href/src/alt/meta strings must NOT be HTML-sanitized
  (nh3 would escape `&` in URLs etc.).
- Kind resolution: op `{file, path}` → bindings map for that page
  (builder.bindings_map extract; `_global` → page-agnostic? check how
  merged_content/bindings handle _global keys — nav is computed there; hours is a
  plain _global list) → field kind; lists walk `field.items` by leaf key name.
- Fields not found in any bindings map (e.g. meta.*, pages_added payloads):
  leave untouched.
- pytest: text-kind op with disallowed markup gets stripped; href-kind op with
  `&` untouched; unknown-path op untouched; nested list items sanitized per item
  field kinds.

## Also consider

Update the sanitize.py docstring if the 04 §9 wording needs a pointer to the
real enforcement point.
