# Pending permission lifecycle — parent ruling and local verification

Both proposals and both all-proposal MERGE artifacts read. Mechanisms converge:
Gemini immediate release-time policy, Astra explicit none/exempt/handled outcome
and original hide timestamp, with existing restorePresencePending bounding owner
lifetime. No new pending flag, timer, controller policy or public interface.

Parent implementation factors their equivalent checks into one private panel
helper, completeCachedHiddenPolicy. It runs after suspension release, on persisted
pagehide (including an earlier exempt visibility hide), and before visible return.
It acts only on an eligible cached exemption that has actually ended. Its policy
recheck does not restamp original hide/screen-lock evidence. Actual lock/dispose
clears the existing marker; genuine held exemptions and ordinary chooser returns
remain exempt. The before-visible guard is Gemini MERGE's defensive boundary,
using the same helper rather than adding a separate decision path.

Bounded synchronous reentrancy is deliberate: release marks itself released;
controller nulls audio before releasing permission; panel clears restoration
authority before child detach; inner disconnect closes the socket, outer sees
null. Parent tests assert one audio stop and one socket close, not a false claim
that no reentrancy happens.

Evidence:

- Parent MEASURED-KNOWING baseline: actual panel+actual controller pending audio
  permission, two listener orders x two hidden-event cases: panel-first2fail,
  controller-first2pass. Four genuine held/ordinary chooser controls pass.
- Parent additional RED cells: logical detach must complete during pagehide,
  visibility-hidden -> permission release -> persisted pagehide must lock, and
  delayed release must create shield immediately with original screen-lock cause.
- Parent combined prototype:284 affected panel/grant/call tests pass, strict TS
  passes, LF rebuild passes. Full frontend chat regression1724 passes. Real
  Chromium full panel/chatView/thread cache test passes and preserves draft,
  reconnects only presence, restores no audio and cannot restore after panic.
  The final before-visible helper call receives proportionate affected controls.
- Gemini MERGE's283 tests/strict TS are CITED MEASURED-KNOWING evidence for its
  equivalent composition; its tests did not include parent's shield timestamp
  discriminator. Astra combined GREEN was explicitly UNEXECUTED. Neither is
  presented as a new blind replication of the parent's integrated code.

The previous round3 audit PASS at b2c01b6 is preserved as historical evidence;
it did not execute the subsequently confirmed pending-permission case and does
not clear this source change. Parent freezes the corrected exact head and seeks
a fresh focused senior review of this lifecycle delta. Existing backend/media
proof is reusable because those modules do not change in this repair.

No PR or delivery merge. Physical Android/iPad/iPhone, production Access/tunnel,
sustained quality/latency/loss and actual Slots shutdown remain open acceptance.
Parent retains final checks and actual confirmed delivery merge SHA.
