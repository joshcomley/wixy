# Symptom
Voice note in the Server chat on Wixie admin failed with "Not enough storage is available." (HTTP 507 storage_full).

# Root cause
`init_upload` rejects when `disk_free - size < WIXY_SERVER_MIN_FREE_MB` (default 10 GiB). The spec assumed 58.8 GB free on D:; the hub's D: now has ~8 GB free, so EVERY upload was refused even though chat media is only a few MB (Wixy storage ~690 MB, far under the 20 GiB quota).

# Decision
Default floor is now 1 GiB (still env-overridable). Quota (20 GiB) unchanged. A floor is meant to stop chat media filling the host, not to be a fixed fraction of a drive the chat doesn't control.

# Watch for
D: on the hub is genuinely near-full; freeing space there is a separate operator task. If free space drops below 1 GiB uploads will 507 again by design.
