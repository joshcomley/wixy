# 00215 - activate_modes.py reads /internal/cookout/modes, not the options route

**Symptom.** `tooling/cookout/activate_modes.py --enable toastie` needed `--token <server token>`: a Server-chat
unlock token, which takes the operator's PIN entered in their browser. No agent can mint one, so no agent could
run the switch-on that the release process ends with.

**Decided.** A loopback-only `GET /internal/cookout/modes` returns `{"modes": [ids]}` (Classic first), from the same
`enabled_cookout_modes(request)` the options route uses. It follows Inv 12's `/internal` rule (bare 404 when a
`Cf-Ray`/`Cf-Connecting-Ip` header is present), needs no token and reveals only which mode ids are switched on.
The tool uses it for check (e) and the final verify; `--token` is gone.

**Why not the options route + a service token.** Any credential an agent could hold would be a standing way into
the private chat's API; the question the tool asks ("is the mode on?") needs none of the chat surface.

**Watch.** If this route ever returns anything about a chat (a round, a name, a count), it breaks the premise.
