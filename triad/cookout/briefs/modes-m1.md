# M1 — Mode data, pools and draw (Sonnet 5.5)

Read `modes-common.md` first. Your files: Appendix A row M1. Interfaces you deliver: A.1
(`cookout_modes.py`) and A.2 (the additive `candidates`/`facet` arguments in `cookout_bank.py`).
Tests: §8.1. Docs: your share of §9.

**Order (coordinator ruling, a refinement of A.0):** the chef-fix parcel currently owns
`cookout_bank.py` and `test_cookout_bank.py` and is mid-change. So:

1. **Now:** `cookout_modes.json`, `cookout_modes.py`, `tooling/cookout/validate_modes.py`,
   `test_cookout_modes.py` — everything in A.1 and §1.4/§2 that does not edit `cookout_bank.py`.
   Measure the §2.2 pools on the committed bank and confirm the numbers the spec states; any
   difference is reported to me, not silently absorbed.
2. **Early checkpoint hand-in** of step 1 as soon as it is green (M2 and M3 build on A.1; landing it
   early removes their stand-ins).
3. **After I tell you the chef fix has merged:** merge the feature branch, then add A.2's additive
   arguments to `cookout_bank.py` and the §8.1 additions to `test_cookout_bank.py`, then your FINAL
   HANDOFF.

`cookout_ingredients.json` is not yours — never edit it.
