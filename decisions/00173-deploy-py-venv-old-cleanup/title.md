`deploy.py` now deletes orphaned `.venv.old.*` backups at the start of every rebuild, instead of leaking one forever per deploy.
