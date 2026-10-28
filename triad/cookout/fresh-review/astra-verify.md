# Cookout spec fold verification — Astra

**All six original findings are CLOSED. One NEW HIGH defect remains; no new CRITICAL defect found.**

Checked the updated spec and complete fold diff against my preceding review. Author-checkout HEAD: `e841916ce0704df38b3475be6341f2867d06ff85`. Spec SHA-256: `C9D88D2587F3248CF4C5FCEBE2B63B768C6A67F9E32D97CAD464C3CB81987A34`. Line references below are to that version of `spec/server-chat/09-cookout.md`.

## Original findings

| Finding | Status | Closure evidence |
|---|---|---|
| H1 — scratch-image erasure | **CLOSED** | §3.3 lines 474–485 specifies attempt-owned scratch, unconditional exit cleanup, rejected staging cleanup, startup **and periodic** recovery with the 900-second threshold. §6 adds success/failure/delete/wipe/cancel and initially-young orphan tests. |
| H2 — stale picture-attempt writes | **CLOSED** | §3.3 lines 493–509 fences both store and fail by monotonic `images_generation`; manual retries increment rather than reset it. The schema, Appendix A.2 signatures and two-store-instance late-A-versus-B tests all carry that contract. |
| H3 — everyday/category draw guarantees | **CLOSED** | §2.3 lines 304–338 makes both categories/families distinct and everyday an entry-level hard requirement, selects only feasible pairings and samples the guaranteed entry from everyday entries only. No hard-constraint fallback remains; tests assert each emitted pair and the reported counterexamples. |
| H4 — lexical staple/manifest bypass | **CLOSED for the original bypass** | §3.2 lines 410–444 adds candidate-specific scanning and an overriding manifest pass; undeclared non-seasoning staple words and omitted picked items cannot escape through stop words/family exemptions. §6 includes the fifth-staple and frozen-manifest cases. The new false-rejection regression below is separate from the original bypass. |
| H5 — shared Comfy graph/exception mismatch | **CLOSED** | §3.3 lines 457–468 preserves the existing `EmptyLatentImage`/`ConditioningZeroOut` graph and `ImageGenerationError` wrapper contract. These names match the actual source. Existing WYR image regressions are required in §6. |
| H6 — ignored UI tests/unbundled CSS | **CLOSED** | §6 lines 889–898 and P4 ownership at line 936 now target `admin-ui/tests/cookout/*`, `admin-ui/tests/serverGameTabs.test.ts` and `admin-ui/src/server/chat.css`. They match the actual Vitest include and CSS import graph. |

## N1 — NEW HIGH: short-form staple scanning rejects selected compound ingredients

**Location:** §3.2 Pass 2, lines 427–439, and its new positive/negative scanner tests in §6.

**Problem:** The fold requires rejection of **any word-boundary occurrence** of undeclared staple short forms, with no protection for a longer ingredient name that is actually selected/declared. Ordinary valid baskets now fail the entire three-concept candidate, or its full recipe, for mentioning their own food:

- Selected `peanut-butter`, no plain `butter` in the manifest: **“Peanut butter chicken”** matches undeclared `butter`.
- Selected `coconut-milk`, no dairy `milk` in the manifest: **“Coconut milk curry”** matches undeclared `milk`.

Both are valid ingredient records under the specified bank schema. A direct word-boundary check reproduces the prescribed match (`butter` at characters 7–13; `milk` at 8–12). This is a **spec-rule counterexample**, not a claim to have run an implemented Cookout scanner. Pass 1 can suffer the same problem if allowed compound names are deleted from its dictionary before longest-match recognition.

The original undeclared-staple bypass is fixed, but replacing it with unconditional component-token rejection makes common ingredient names unusable in natural recipe prose. A repair cannot safely solve that by adding plain butter/milk: that would change the manifest and may exceed the staple cap.

**Exact remaining fix:** Recognize longest full ingredient-name/alias spans **before filtering by allowed/forbidden status**. A span matching an explicitly selected/declared compound ingredient protects its interior words from being reinterpreted as a different, shorter staple. Apply Pass 2's undeclared/omitted-food rejection to remaining spans; retain detection of a separate forbidden staple outside the allowed compound. Preserve the decided deterministic two-pass design, family policy, cap, frozen manifest and one-repair limit.

Concretely, allow **“peanut butter”** when that id is selected, but reject **“peanut butter with extra butter”** when plain butter is undeclared. Likewise allow **“coconut milk”** when selected, but reject **“coconut milk plus milk”** when dairy milk is undeclared. Match whole token-boundary phrases, longest first, rather than suppressing every future occurrence of the short word once an allowed compound was seen.

**Required regression tests:** those four positive/negative examples, case/alias variants, and continued rejection of an independently mentioned omitted food or fifth undeclared staple. This closes the new regression without restoring H4's original loophole or adding another model call.

Only this verification report was written; the spec and implementation were not edited.
