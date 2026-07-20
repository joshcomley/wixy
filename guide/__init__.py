"""The independence-phase HTML guide's own build tooling (spec/independence/07)
— a self-contained static site, assembled by `guide.build` from `guide/
chapters/*.html` + `guide/manifest.py`. See `guide/README.md` for the full
picture; this package is pure content-assembly, no server imports.
"""

from guide.build import build
from guide.manifest import CHAPTERS, Chapter

__all__ = ["CHAPTERS", "Chapter", "build"]
