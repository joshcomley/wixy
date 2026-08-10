# 00007 [2kiiwu] wixy: docs/ai updates (publish-pipeline, runbook, invariants, builder, architecture)

## What
Run `op call aim-doc.doc_rules` FIRST, then update:
- `docs/ai/publish-pipeline.md` — mirror-push step in swap stage 5 + in restore.
- `docs/ai/runbook.md` — new section: public site on GitHub Pages (how the deploy works, the
  `WIXY_PUBLIC_DOMAIN` repo variable, bootstrap procedure, the pre-workflow-sha restore edge,
  "domain changes = edit the variable + re-run").
- `docs/ai/invariants.md` — new numbered invariant: `wixy-live` mirrors the live pointer;
  server-only writer; advisory — never blocks publish/restore.
- `docs/ai/builder.md` — CLI override flags (`--domain`/`--indexable`) + canonical link in the
  head list.
- `docs/ai/architecture.md` — one line if its data-flow map warrants it.

## Why
Doc-maintenance contract (repo CLAUDE.md): public-surface changes (routes, schema, env vars,
an invariant) must update the matching docs/ai file in the SAME PR.

## Context / current state
Not started. Depends on [[00001]]-[[00006]] being implemented (docs describe real behavior).

## Files
`docs/ai/publish-pipeline.md`, `runbook.md`, `invariants.md`, `builder.md`, `architecture.md`.

## How to continue + acceptance
Cross-check against `op call aim-doc.doc_rules` output for the canonical update-mapping for
this stack. Keep the existing terse, precise style (exact identifiers, line refs where the
existing docs do that).

## Links
Brief §4G.
