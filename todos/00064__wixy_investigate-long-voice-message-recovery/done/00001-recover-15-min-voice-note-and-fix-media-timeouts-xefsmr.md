# 00001 [xefsmr] Recover the 15-minute voice note and fix media timeouts

**Status:** built on cmd/workspace-00064 (commits df16981a backend, 56d19ecc UI); delivery merge pending.

- Attachment 611c0cba59f44b7699bf37c83e05bfab (msg seq 15508), failure=timeout, 15:00 Safari webm.
- Safe copy: D:\Recovery\wixy-voice-2026-11-12\611c0cba…\original.webm (SHA-256 bc9ddea6d06cc4cd8e0047cf9b62006e6e77d4c90c6ca37e9937f3eb1a811f6e). Prod archive expires ~2026-11-19 08:36 unless retried (a retry restarts the window).
- Root cause + design: decisions/00209.
- Remaining: deliver (merge -> Slots deploy), then press Try again on the 08:30 bubble (or call POST /api/admin/server/attachments/611c0cba…/retry), confirm it plays 15:00; update Answers entry 3768 to ANSWERED.
