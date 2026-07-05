# 00001 — Write the self-hosted CMS build spec [x7k2mp] — DONE 2026-07-05

Operator brief (voice, 2026-07-05): replace the Wix hosting of the Cottage Aesthetics
site (repo `cottage-aesthetics-preview`, plain HTML/CSS/JS) with a self-hosted manager at
**ca.cinnamons.uk**: every text editable, every image replaceable, theme tweakable, live
in-place edit mode (select element → popover → live preview, JSON-backed), one-button
build+publish, version history + restore, and an embedded **cmd-chats-powered AI chat**
that can do arbitrary site work ("add a page", "move that section", "new theme") exactly
like chatting in cmd. Spec in great detail for a Sonnet 5 (max effort) chat to implement
with near-zero consultation (peer mechanism as the escape hatch). Do NOT start the chat.

Delivered: `spec/README.md` + `spec/00…09` + `spec/KICKOFF-PROMPT.md` (this repo, merged
to main). Grounded in verified facts: site repo markup audit; cmd chat APIs
(new-chat/send/introspection, file:line-cited); hub hosting runbook (Slots/Devfleet/
cloudflared/CF Access; port 9380 free; CF creds live in `D:\Servers\Loom\.env`).

Also merged pre-existing unmerged work to main first per operator instruction: wixy PR #3
(workspace-00002 branch: brief, blueprint, photos, tooling, todos); verified
cottage-aesthetics-preview was already fully on its main.
