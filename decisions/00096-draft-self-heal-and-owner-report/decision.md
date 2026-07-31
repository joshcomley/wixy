# Blocked-publish recovery: deterministic repair + a report escape hatch

## The ask

decisions/00095 closes the write paths that let a structurally-broken draft
happen going forward (the write gate) — but the owner had already been
staring at a wall of raw validator text for two days with no way forward
except a human (Josh) manually PATCHing the API. Even with the gate in
place, SOMETHING has to be the answer when a draft written before the gate
existed, or a template/binding bug the gate doesn't cover, blocks Publish.
The brief called for two owner-facing actions on that blocked state: "Fix it
for me" and "Send a report" — both explicitly required to be free of any AI
call, so they work even when the AI lane itself is the thing that's broken,
and so a nervous owner gets a predictable, explainable outcome rather than a
model's best guess at their content.

## What was decided

**`wixy_server/draft_repair.py` — algorithmic repair, not a model call.**
`POST /api/admin/draft/repair` runs the exact same `normalize_set_ops` the
write gate already applies (decisions/00095) across every existing overlay
op — this alone fixes any historical op that predates the gate and would
normalize cleanly today (e.g. a leading-slash image src whose file exists).
For the flat `COLLECTION_RULES` shapes (`gallery.sliders`/`gallery.tiles` —
exactly what the incident hit), each array item is checked against the FULL
schema (including `pattern`, unlike the write gate's structural-only check —
repair's job is to reach something PUBLISHABLE, not merely valid-enough-to-
store) and repaired item-by-item: fill missing required fields from the base
checkout's same-index item first (preserves as much of the owner's edit as
possible), fall back to replacing the whole item with base only if that
isn't enough, and drop an item with no base counterpart at all (added past
the base array's length — nothing to fall back to). A non-collection op
whose image ref still doesn't resolve after normalize is discarded outright.

**Discard beats a same-valued overwrite when the repair converges on base.**
If every item in a repaired collection array now matches base exactly, the
whole op is DISCARDED rather than left as a SetOp holding base's own values.
An identical-to-base overlay entry is pure noise, and — the concrete reason,
not just tidiness — Inv 6 (upstream changes must flow through untouched
keys): leaving a same-valued SetOp in place would permanently shadow that
key from ever picking up a LATER legitimate upstream edit to it, the same
class of bug this whole incident was about.

**Repair always re-validates and reports back, never claims silent
success.** The end of `run_repair` runs the merged result through the same
`validate_merged_for_publish` the publish preflight and preview use. What
survives comes back as `validate.errors` in the response — repair fixes
what it mechanically can (a collection shape violation, a broken image
ref) and is honest about what it can't (a template/binding problem baked
into the checkout itself is not overlay-fixable, by construction — there is
no overlay op to discard or patch). `RepairResult.actions` is a list of
plain-English sentences (`"Fixed some content in the {label}."`, `"Restored
the {label} to its last published version."`, `"Removed a change on the
{label} that pointed at a missing image."`) built from the base checkout's
own `meta.navLabel` — never a raw field/path name — so the drawer can show
the owner what actually happened without a translation layer, and Inv 1
(no site-specific literals in engine code) holds even in owner-facing
strings.

**`wixy_server/reports.py` — a full diagnostic snapshot, saved unconditionally, emailed best-effort.** "Send a report" (reachable from the blocked
state before OR after trying repair, and from a failed publish) gathers
exactly what a human would ask for first — the current validate result, the
raw overlay, the last publish job's stage/log, the live pointer, the last 5
ledger entries, upstream-ahead commits, and the engine's own sha — and
writes it to `Storage/projects/<slug>/reports/<UTC timestamp>.json`
regardless of anything else. Email is a convenience on top: plain stdlib
`smtplib` STARTTLS (no new dependency, matches the fleet's existing Gmail-
SMTP-app-password pattern), wrapped so any `OSError` is logged and reported
as `emailed: false` rather than raised — a send failure must never make the
caller think the report itself was lost, since the save already happened
first and unconditionally.

**`_settings_summary` is an explicit allowlist, not "log the settings
object minus secrets."** Only `env`/`edition`/`aiBackend`/`slot`/
`containerized` are included. Deliberately NOT a denylist-based redaction
(`vars(settings)` minus a "secrets" set) — an allowlist can't leak a FUTURE
secret field added to `Settings` later; a denylist silently would, the
first time someone adds a new credential field and forgets to also add it
to the exclusion list.

## What to watch for

- **`draft_repair`'s item-level repair only covers the flat `COLLECTION_
  RULES` table** (same scope note as decisions/00095's write gate) — the
  two nested special shapes (`treatments.sections`' `cards`, `_global.
  footer.*`) are protected going FORWARD by the write gate but have no
  auto-heal path for pre-existing corruption; that's routed to Report by
  design, not an oversight, but if those shapes turn out to need the same
  treatment, `_repair_collection_items` is the place to generalize from.
- **Repair takes `expected_rev` and raises `RevConflictError` on mismatch**
  (Inv 9) — same optimistic-concurrency contract as every other overlay
  mutation, never a partial repair applied against a rev the caller didn't
  actually see.
- **The report bundle is not sanitized for secrets beyond `_settings_
  summary`'s allowlist** — the raw overlay and validate errors could
  legitimately contain owner-authored content (never credentials, since
  content ops can't hold engine settings), but a future field added to the
  bundle should be checked against "would this leak something Josh
  shouldn't casually see in an email," since the email path has no further
  gate once `send_report_email` decides to send.
- **`send_report_email` returns `False` silently when SMTP isn't
  configured** (`not settings.report_smtp_host`) — this is the correct
  behavior for every deployment that hasn't set the `WIXY_REPORT_SMTP_*`
  env vars (e.g. a fresh standalone install, spec/independence), not a
  bug; the save-to-disk path is the one guarantee, email is opportunistic.
