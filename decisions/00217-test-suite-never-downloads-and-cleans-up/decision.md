# The test suite never downloads, cleans up after itself, and starts apps cheaply

## Symptom (2026-11-26, workspace 00065)

A full `pytest` run on the hub was 57 % done after 63 minutes (CI's whole python job is ~35 min) and
was writing an estimated 40-53 GiB an hour into its temp directory on hub D:, threatening the hub's
recorders (they stop below 110 GiB free). Each app-starting test's `tmp_path` held ~38 MB.

## Root cause (measured)

1. **A download per test.** `create_app` starts `CookoutVisualsService`, whose first sweep self-heals
   the Cookout picture pack: a fresh tmp storage root never holds it, so EVERY app-starting test
   downloaded the 44 MB `cookout-images-v2.tar` from GitHub and unpacked its 6,974 pictures into its
   own `storage/cookout-images/`. ~2,200 such tests in a run = ~84 GB written, and every outcome
   depended on GitHub being reachable.
2. **Nothing was cleaned up.** pytest's default retention keeps every test's `tmp_path` for the last
   three runs.
3. **Each sweep stat-ed every object.** `PackStore.missing` checked `is_file()` for each of the
   ~7,000 objects in each search directory (13,948 checks), ~5 s per app start on a loaded box, even
   when the objects directory did not exist.
4. **Each app start re-parsed the shipped files.** The Cookout ingredient bank (twice), the picture
   manifest and the catalogue were read and validated on every `create_app` (~3.3 s on a loaded box).

5. **Every HTTP client re-read the certificate bundle.** httpx builds a fresh `SSLContext` per
   client; `create_app` built five (the picture painter one per request). A 30 s py-spy sample of a
   full-run worker put 58 % of its time in `ssl.create_default_context` under `create_app`.
6. **A tooling test busy-waited on the hub's real memory.** `run_pipeline` defaulted to reading the
   machine's free memory and the tests pass a no-op `sleep`, so whenever the hub had under 20 GB free
   a worker spun inside one test (py-spy: 100 % of a worker's samples in `wait_for_memory`).

cProfile of one `/api/version` test after fix 1: 5.5 s in `leak_guard.drain` (the sweep's
`missing()`), 1.7 s `default_bank`, 1.6 s `load_visuals`.

## Decided

- `wixy_server/tests/conftest.py`: an autouse guard makes `cookout_pack._download` raise
  `FetchRefused` for any http(s) URL whose host is not loopback. `FetchRefused` is the self-heal's
  own "not now" answer, so the app keeps its emoji tiles; the pack tests' loopback test server and
  the downloader's own scheme check are unaffected. Pinned by `test_suite_never_downloads.py`
  (red on the old code: the lifespan test found the pack's files in storage).
- `pyproject.toml`: `tmp_path_retention_policy = "failed"`, `tmp_path_retention_count = 1`. A
  passing test's directory is deleted at its teardown; only failures of the latest run are kept.
- `PackStore.missing` lists each search directory once (`os.scandir` of its `ab/` subdirectories)
  instead of a stat per object per directory. Same answer, O(files present).
- The conftest guard ALSO wraps `PackStore.fetch` and refuses before it sizes the objects already
  present (another stat of every object) or takes the store lock; the `_download` guard stays as the
  backstop.
- `wixy_server/http_tls.py`: `shared_ssl_context()` builds, once per process, the same context httpx's
  `verify=True` would (`SSL_CERT_FILE` / `SSL_CERT_DIR`, else certifi), and every `httpx` client in
  `wixy_server/` passes it as `verify=`. Verification is unchanged (`test_http_tls.py` pins
  CERT_REQUIRED + hostname checking, and that two app builds make at most one context).
- `tooling/cookout/visual/images.py`: `run_pipeline(free_gb=None)` resolves `hub_free_gb` when called,
  so `test_cookout_visual_tooling.py` stubs it to "unknown" (which never blocks); the memory-gate
  tests still pass their own readings.
- `load_cookout_bank`, `load_manifest`, `load_cookout_catalogue` cache the parsed file per process,
  keyed on (path, mtime_ns, size); a failure is never cached. The returned objects are read-only
  (frozen dataclasses of tuples/frozensets/mappings), so sharing them is safe; a changed file is read
  again.

Measured after: the Cookout + version + guard tests (756) ran in 81 s at `-n 4` on the loaded hub;
the 22 version tests alone had taken ~135 s.

## Addendum: the one failure the fast full run then found

With the suite at ~10 minutes, the full run (5,769 passed) showed one real failure:
`test_livechat_live_voice.py::TestListenUpload::test_slices_keep_the_spec_06_ordering_rules`. The
idempotent re-PUT of slice 0 failed with `PermissionError: [WinError 5]` in `uploads.write_chunk`'s
`os.replace`: on Windows a file another handle holds open (the live decoder reading the chunk,
Defender, the indexer) cannot be replaced. Reproduced deterministically by holding the chunk open
(`test_livechat_uploads.py::TestWriteChunk`, red before the fix). Decided: the worker transcript's
existing `_replace_riding_out_scanners` (bounded retry, 5 x linear 50 ms) moves to
`wixy_server/fileops.py` and `write_chunk` uses it; and a replay of the SAME bytes is now a true no-op
(no rename at all), so the idempotent path cannot collide with a reader however long it holds the
file.

## Watch for

- A new background job that fetches from the internet at app start needs the same treatment: tests
  must never reach the internet. Inject a fake, or extend the conftest guard.
- Never mutate an object returned by those three loaders; they are shared across apps in a process.
