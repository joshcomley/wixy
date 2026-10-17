# Symptom
While choosing, the WYR game stage shares its height with answer controls and the mini chat. On some screens this makes the pictures hard to inspect. The operator asked for a maximize-pictures option.

# Decided
- Add a visible Maximize pictures control to the WYR game header only when at least one image is ready.
- Open a native full-screen `<dialog>` comparison view showing both ready pictures at once, with each option label beside its picture. Native `showModal()` contains keyboard focus and makes the covered page inert. If one picture is missing, show a clear placeholder for that option.
- Close the comparison view to return to the unchanged game controls and current selection state. Lock, round change, close, or a switch back to Chat also closes the view.
- Prevent the dialog's default Escape cancel so this feature preserves Server chat's existing Escape panic-key behavior.
- Do not mutate or reveal player answers in the comparison view. Use the already-signed image URLs on the round's message.

# Enforced by
`admin-ui/tests/serverWyrGame.test.ts` covers the maximize/return flow and the no-ready-image case.
