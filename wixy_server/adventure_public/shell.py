"""The public page shell, the asset table and the web manifest
(spec/adventure-public/README.md §2.3).

The page is ONE HTML document (`GET /` and `GET /d/{code}`): dark, phone-first, painted at once from
the inline style, with the client bundle (`app.js` + `app.css`, built from `admin-ui/src/public/`
into `wixy_server/static/adventure-public/`) loaded from `/assets/` under content-fingerprinted
`?v=` URLs computed from the files when the app starts. The shell never depends on those files
existing: a missing bundle just leaves the bare URL (and the page its loading text).

Everything a visitor-controlled value reaches here is HTML-escaped (`html.escape`) or JSON-escaped
for a `<script>` block; the only dynamic values are the validated code, the bank's own place names
and the host from settings.

Assets are served by NAME from three places, in this order: the bundle directory (any file in it),
the three shared Adventure imagery files in the admin bundle directory (the world map, the satellite
and the atlas pictures — the same bytes the private game uses) and this package's own `assets/`
(the home-screen icons). A name is one path segment; nothing else resolves.
"""

from __future__ import annotations

import hashlib
import html
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Final

SHARED_ASSET_NAMES: Final = (
    "adventure-world.json",
    "adventure-satellite.webp",
    "adventure-atlas.webp",
)
"""The imagery shared with the private game, served from the admin bundle directory."""
BUNDLE_JS: Final = "app.js"
BUNDLE_CSS: Final = "app.css"
ICON_NAMES: Final = ("icon-192.png", "icon-512.png", "apple-touch-icon.png")
SITE_NAME: Final = "Adventure Time"
THEME_COLOUR: Final = "#0b1020"
MISSING_MESSAGE: Final = "That place isn't on the map any more"
FINGERPRINT_LENGTH: Final = 10

_NAME_OK = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

_MEDIA_TYPES: Final = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


def media_type(path: Path) -> str:
    return _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")


def is_asset_name(name: str) -> bool:
    """One plain path segment: letters, digits, `.`, `_`, `-`; not hidden, not `..`."""
    return (
        bool(name)
        and len(name) <= 120
        and not name.startswith(".")
        and all(char in _NAME_OK for char in name)
    )


class AssetTable:
    """The `/assets/{name}` resolver and the content fingerprints (cached per file stat)."""

    def __init__(self, *, bundle_dir: Path, shared_dir: Path, builtin_dir: Path) -> None:
        self._bundle = bundle_dir
        self._shared = shared_dir
        self._builtin = builtin_dir
        self._lock = threading.Lock()
        self._cache: dict[Path, tuple[int, int, str]] = {}

    def resolve(self, name: str) -> Path | None:
        """The file `name` names, or `None`. Only a regular file directly in one of the three
        directories (and, in the shared directory, only the three imagery names) is returned. A
        source map (`*.map`) is never served: the public bundle is built without one, and a stray
        file in the bundle directory must not publish the private client's source."""
        if not is_asset_name(name) or name.lower().endswith(".map"):
            return None
        candidates = [self._bundle / name]
        if name in SHARED_ASSET_NAMES:
            candidates.append(self._shared / name)
        if name in ICON_NAMES:
            candidates.append(self._builtin / name)
        for path in candidates:
            if path.is_file():
                return path
        return None

    def fingerprint(self, path: Path) -> str | None:
        """Short content hash of `path` (recomputed only when its size or mtime changes), or `None`
        when it cannot be read."""
        try:
            stat = path.stat()
        except OSError:
            return None
        with self._lock:
            cached = self._cache.get(path)
            if cached is not None and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
                return cached[2]
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:FINGERPRINT_LENGTH]
        except OSError:
            return None
        with self._lock:
            self._cache[path] = (stat.st_mtime_ns, stat.st_size, digest)
        return digest

    def url(self, name: str) -> str:
        """`/assets/<name>?v=<content hash>`, or the bare path when the file is missing."""
        path = self.resolve(name)
        digest = self.fingerprint(path) if path is not None else None
        base = f"/assets/{name}"
        return f"{base}?v={digest}" if digest is not None else base


def json_for_script(value: object) -> str:
    """JSON safe to place inside a `<script type="application/json">` block: `<`, `>`, `&` and the
    two line separators are escaped, so nothing in it can close the block or start a tag."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (
        text.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace(" ", "\\u2028")
        .replace(" ", "\\u2029")
    )


@dataclass(frozen=True, slots=True)
class OpenGraph:
    """What `GET /d/{code}` says about a place (all plain text; escaped on output)."""

    title: str
    description: str
    url: str
    image: str | None


_STYLE = (
    "html,body{margin:0;min-height:100%;background:" + THEME_COLOUR + ";color:#e8ecf6;"
    "color-scheme:dark;font:16px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}"
    "#adventure-public-root{min-height:100vh;min-height:100dvh}"
    ".ap-boot,.ap-missing{display:flex;flex-direction:column;align-items:center;"
    "justify-content:center;gap:1rem;min-height:100vh;min-height:100dvh;padding:2rem;"
    "text-align:center;box-sizing:border-box}"
    ".ap-missing a{color:#7fd0ff;font-weight:600;padding:.7rem 1.2rem;"
    "border:1px solid #3a4a6a;border-radius:.6rem;text-decoration:none}"
)

_TEMPLATE = """<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="{theme}">
<meta name="robots" content="noindex">
<title>{title}</title>
{head_extra}<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="{icon}">
<link rel="apple-touch-icon" href="{apple}">
<link rel="stylesheet" href="{css}">
<style>{style}</style>
</head>
<body>
<div id="adventure-public-root">{root}</div>
<script type="application/json" id="adventure-public-boot">{boot}</script>
<script src="{js}" defer></script>
</body>
</html>
"""


def _esc(text: str) -> str:
    return html.escape(text, quote=True)


class PublicShell:
    """Renders the shell. Built once at start (the fingerprints are read then)."""

    def __init__(self, *, host: str, assets: AssetTable) -> None:
        self.host = host
        self.origin = f"https://{host}"
        self._assets = assets
        self._css = assets.url(BUNDLE_CSS)
        self._js = assets.url(BUNDLE_JS)
        self._icon = assets.url("icon-192.png")
        self._apple = assets.url("apple-touch-icon.png")
        self._boot_assets = {
            "world": assets.url("adventure-world.json"),
            "satellite": assets.url("adventure-satellite.webp"),
            "atlas": assets.url("adventure-atlas.webp"),
        }

    @property
    def boot_assets(self) -> dict[str, str]:
        return dict(self._boot_assets)

    def short_url(self, code: str) -> str:
        return f"{self.origin}/d/{code}"

    def render(
        self,
        *,
        code: str | None = None,
        missing: bool = False,
        graph: OpenGraph | None = None,
    ) -> str:
        """The page: the plain game (`code` None), a place (`code` and its Open Graph), or the
        "not on the map" page (`missing`: the boot block says so and the root already carries the
        message and the link, so it reads without JavaScript)."""
        boot: dict[str, object] = {
            "code": None if missing else code,
            "origin": self.origin,
            "assets": self._boot_assets,
        }
        if missing:
            boot["missing"] = True
            root = (
                f'<div class="ap-missing"><h1>{_esc(MISSING_MESSAGE)}</h1>'
                '<a href="/">Spin the globe</a></div>'
            )
        else:
            root = (
                f'<div class="ap-boot"><p>Loading {SITE_NAME}…</p>'
                f"<noscript><p>{SITE_NAME} needs JavaScript.</p></noscript></div>"
            )
        title = SITE_NAME if graph is None else f"{graph.title} — {SITE_NAME}"
        return _TEMPLATE.format(
            theme=THEME_COLOUR,
            title=_esc(title),
            head_extra=self._graph_tags(graph),
            icon=_esc(self._icon),
            apple=_esc(self._apple),
            css=_esc(self._css),
            js=_esc(self._js),
            style=_STYLE,
            root=root,
            boot=json_for_script(boot),
        )

    @staticmethod
    def _graph_tags(graph: OpenGraph | None) -> str:
        if graph is None:
            return ""
        tags = [
            ("property", "og:site_name", SITE_NAME),
            ("property", "og:type", "website"),
            ("property", "og:title", graph.title),
            ("property", "og:description", graph.description),
            ("property", "og:url", graph.url),
            ("name", "description", graph.description),
            ("name", "twitter:card", "summary_large_image" if graph.image else "summary"),
            ("name", "twitter:title", graph.title),
            ("name", "twitter:description", graph.description),
        ]
        if graph.image:
            tags.append(("property", "og:image", graph.image))
            tags.append(("name", "twitter:image", graph.image))
        return "".join(
            f'<meta {attr}="{_esc(key)}" content="{_esc(value)}">\n' for attr, key, value in tags
        )


def manifest_json() -> str:
    """The web manifest (so the game can be added to a phone's home screen)."""
    return json.dumps(
        {
            "name": SITE_NAME,
            "short_name": "Adventure",
            "description": "Spin the globe and find your next holiday.",
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "background_color": THEME_COLOUR,
            "theme_color": THEME_COLOUR,
            "icons": [
                {"src": "/assets/icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "/assets/icon-512.png", "sizes": "512x512", "type": "image/png"},
            ],
        },
        separators=(",", ":"),
    )
