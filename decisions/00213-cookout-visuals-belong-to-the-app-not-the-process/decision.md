# Cookout visuals belong to the app, not the process

**Supersedes** the `default_visuals()` / `set_default_visuals()` process default named in
spec/server-chat/09b-cookout-visual.md (B.6 around lines 843, 971, 1191). The spec is unchanged (it is the
decided intent of picture delivery); this entry records the one deviation.

## Symptom
On the pack v2 data PR (the manifest went from empty to 3,487 pictures) CI failed two Cookout tests
(`TestBlindRedaction::test_the_view_shape`, `TestConcepts::test_a_ready_result_lands_once_and_starts_the_picture_wait`):
the staple "water" carried a real picture where the test expected `image: None`.

## Root cause
`create_app` installed its `IngredientVisuals` as a PROCESS global (`set_default_visuals`) and
`cookout_game` read it in three places (`default_visuals()`). Nothing reset it, so a test that built an app
left the committed manifest (and, where a pack is installed, real pictures) for the next test in that
xdist worker. With an empty manifest this was invisible.

## Decision
No global. `create_app` keeps the visuals in `app.state.livechat_cookout_visuals`; the routes pass them to
`cookout_view_json(..., visuals=)`, `bank_entry_json(..., visuals=)` and `bank_ingredient_json(visuals, found)`
(required arguments, so a forgotten one is a type error, not a silent default). A caller with no app
(the image-boot proof, a bare `python -c`) uses `visuals_from_environment()`. Tests pass their own
(`tests/no_visuals.py` or a fixture's visuals). A reset fixture was rejected: it treats the symptom and
leaves the shared mutable global.

## Watch for
- Never reintroduce a module-level visuals default; a new view builder takes `visuals` explicitly.
- `deploy/standalone/ci/cookout_image_proof.sh` (the image-boot proof that runs on manifest PRs) calls
  `visuals_from_environment()`; it cannot run without Docker, so changing that name needs the CI job.
