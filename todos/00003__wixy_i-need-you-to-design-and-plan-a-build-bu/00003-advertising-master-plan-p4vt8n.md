# 00003 — Advertising feature: plan, playbook, guardrails [p4vt8n]

Operator brief (2026-07-08, voice): build advertising into the system — a spend DIAL
(turn ad spending up/down), AI-assisted ad design + publishing later; FIRST figure out
WHERE and WHAT to advertise for the clinic (Hartlebury/Kidderminster): local
publications, local Facebook groups, Instagram, paid ads. Delegate grunt research to
Sonnet 5 sub-agents; Fable owns the master plan. Includes budget/investment framing.

SECOND OWNER BRIEF (2026-07-08, later): Purdi's own requirements — competitors' posts are
"all AI" and it shows; HER WORDING drives every post and must never be AI-written (AI ok
for layouts only); needs a dead-simple flow (she's overwhelmed): upload/categorise her
photos (before+after pairs w/ consent, clinic, clinician "me", work close-ups; extensible),
type her words, get generated FB+IG POSTS (feed posts + carousels, creative before/after
treatments) AND short VIDEOS/reels with music; platform music catalogs are app-only so
plan = curated Meta Sound Collection tracks baked via ffmpeg + manual trending-audio path;
FB+Instagram only for now. → Captured as `advertising/03-creative-studio.md`; roadmap
REORDERED: Studio = module v1 (before the paid dial).

THIRD OWNER BRIEF (2026-07-08, later still): layouts need HANDS-ON drag/drop/swap
editing (finger, phone) so she never has to ask AI to nudge things — backed by our own
layout markup ("WXL": JSON layout tree; gestures and AI edits are both WXL mutations;
one compiler renders editor + export). Also: audit her EXISTING FB/IG posts (page id
61572079150383 / @cottageaesthetics) to ground template design in her current look —
third Sonnet agent dispatched for that (screenshots → advertising/research/existing-posts/).

State:
- `advertising/00-master-plan.md` — strategy, angles (incl. A7 her-voice doctrine),
  channel rings, spend-dial product design, Wixy integration, compliance-linter concept,
  roadmap (A: docs now; B: Creative Studio; C: paid dial; D: v3). DRAFTED.
- `advertising/03-creative-studio.md` — full Studio design (library/composer/reels/
  music/publishing + doctrine). DRAFTED.
- Two Sonnet 5 research agents running (2026-07-08 evening): local channel landscape
  (press/groups/registers/competitors/partnerships) + paid mechanics & UK regulatory
  (CAP/ASA POM ban, 18+ rules, Meta/Google policies, benchmarks, measurement).
- NEXT: synthesize their verified findings into `advertising/01-channel-playbook.md` +
  `advertising/02-regulatory-guardrails.md`, reconcile 00, ship PR.
- LATER (phase B, after CMS build completes): write the Adverts-module build spec (same
  rigor as spec/ — verified Meta/Google API facts, Business Manager prerequisites) and
  commission it.

Hard constraints already known: botulinum toxin (POM) may NOT be advertised to the UK
public in any channel incl. organic social; ads for cosmetic procedures must be 18+;
every real spend passes a human gate (fleet spend doctrine + product design §5).
