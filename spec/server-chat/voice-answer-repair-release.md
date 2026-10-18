# Answer/setup diagnostic repair release

- PR: https://github.com/joshcomley/wixy/pull/329
- Reviewed implementation: `514b133d2f703ddbace7d306dc8121b39235e5a4`.
- Final PR head: `0ef1a3e22921ede8dc174b5d998c6d480d4b0070`; subsequent
  changes from the reviewed head are audit/task documentation only.
- Confirmed merge: `d2fdc2662fd02686d5e31eea481b143b5f180956`.
- All six final CI checks passed: Python, frontend, release-note, guide link
  check, full browser suite and image boot proof.
- Production origin9380 and public `https://ca.cinnamons.uk/api/version` both
  returned that exact merge. Internal `/healthz` returned ready200. Green slot.
  Checked2026-10-18T20:21:56Z.
- Senior Opus round4: C0/H0/M0/L0, all five findings verified fixed. See
  [the report](voice-answer-repair-audit.md) and
  [the packet](voice-answer-repair-audit-packet.md).

This is an operator-authorized diagnostic release, not confirmation that the
physical Android Chrome to iPhone Safari failure is solved. Decision1874 asks
the affected pair to refresh/unlock/retry, check the voice-note Transcribe
control, and return the bounded Copy call details from each phone if it fails.
No human audio, conversation, transcript, identity or credentials were collected
as diagnostic evidence. Persistent task3l0ia3 remains open for that actual result.
