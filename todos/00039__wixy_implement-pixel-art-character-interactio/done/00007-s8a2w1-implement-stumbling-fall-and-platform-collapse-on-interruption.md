# Implement stumbling fall and platform collapse on incoming message interruption

## Details
- Implement startle/stumble sprites for guy in pink suit (`GUY_STUMBLE_1`, `GUY_STUMBLE_2`) and woman in blue dress (`WOMAN_STUMBLE_1`, `WOMAN_STUMBLE_2`).
- Implement `COUPLE_SLIDE_FALL` sprite for the couple clinging together when the platform gives way.
- Add `stumble_fall` and `platform_collapse` phases in `SceneController`:
  - Climbing interruption: characters stumble off balance and tumble downward off the bottom of the screen under gravity acceleration.
  - Cuddling interruption: wooden platform collapses downward (pivoting at the wall anchor), couple slides down the sloping plank and falls off the bottom together, with bursting heart particles.
- Integrate `pixelChat.onIncomingMessage()` into `chatPanel.ts` for incoming stream message events and composer send.
- Add interactive simulation buttons to `demos/pixel_art_chat_demo.html` to test both interruption scenarios on demand.
- Full Vitest and TypeScript strict typechecks passing.
