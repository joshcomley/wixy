The kill-during-publish test watches `locks/publish.lock`, not `/api/admin/state` — the state endpoint blocks on the tree lock for most of the window it was sampling.
