"""Rendered-parity harness (spec/03-site-migration.md §5) — the migration's safety net.

Runnable against any site-repo checkout: build it, serve it, capture probes (text, links,
images, computed styles, screenshots), and compare against a committed baseline captured
once from the pre-migration static site. `python -m builder parity` is the CLI entrypoint.
"""
