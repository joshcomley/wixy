"""Media upload processing + reference scanning (spec/02-content-model.md §9).

Upload pipeline (Pillow): auto-orient from EXIF, strip EXIF (client photos =
privacy — done by simply never round-tripping the original `info` dict into the
re-saved file, not an explicit "remove exif" step), re-encode JPEG q85 / keep
PNG, resize so the longest side stays within the project's configured limit.
Rejects oversized files, non-image MIME types, and SVG (XSS surface — spec/02 §9
says SVGs enter via the AI/PR lane only, never through this upload path).

Reference scanning walks merged content (every page + `_global`) for values
shaped like an image object (`{"src": ..., "alt": ...}` — the one shape
`data-wx-img`/`data-wx-bg`/`meta.ogImage` all share, spec/02 §2) and reports
which top-level content key each media file is used from, matched by filename
(the stored `src`'s prefix differs between a repo file, `images/x.jpg`, and a
staged draft upload, `/admin/draft-media/x.jpg` — the filename is the only
form-independent thing to match on).
"""

from __future__ import annotations

import hashlib
import io
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import cast

from PIL import Image, ImageOps

from builder.config import MediaConfig
from builder.content import atomic_write_json, load_json_object
from builder.jsontypes import JsonValue
from builder.render import SiteSource
from wixy_server.storage import ProjectPaths

_MAX_UPLOAD_BYTES = 15 * 1024 * 1024
_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


class MediaUploadError(Exception):
    """A rejected upload (spec/02 §9: >15MB, non-image MIME, SVG)."""


class MediaNotFoundError(Exception):
    """No draft-staged file by this name."""


class MediaReferencedError(Exception):
    """Still referenced by draft content — spec/02 §9's unreferenced-only delete rule."""

    def __init__(self, name: str, references: list[str]) -> None:
        self.name = name
        self.references = references
        super().__init__(f"'{name}' is still referenced by: {', '.join(references)}")


def _slugify(original_filename: str) -> str:
    stem = PurePosixPath(original_filename.replace("\\", "/")).stem
    normalized = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()
    return slug or "image"


@dataclass(frozen=True, slots=True)
class ProcessedUpload:
    filename: str
    content: bytes
    width: int
    height: int


def process_upload(
    data: bytes, original_filename: str, content_type: str, config: MediaConfig
) -> ProcessedUpload:
    """Raises `MediaUploadError` for anything spec/02 §9 rejects; otherwise
    returns the re-encoded bytes and the `<hash8>-<slugged-name>.<ext>` filename
    (spec's own naming convention) ready to write to `draft/media/`. The hash is
    of the FINAL re-encoded content, not the raw upload — re-uploading the exact
    same image (even under a different original filename) naturally dedupes to
    the same staged file rather than accumulating copies."""
    if len(data) > _MAX_UPLOAD_BYTES:
        raise MediaUploadError(f"file exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit")
    if content_type == "image/svg+xml" or original_filename.lower().endswith(".svg"):
        raise MediaUploadError("SVG uploads are rejected (XSS surface, spec/02 §9)")
    if content_type not in _ALLOWED_CONTENT_TYPES:
        raise MediaUploadError(f"unsupported content type '{content_type}'")

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise MediaUploadError(f"not a readable image: {exc}") from None

    # Capture BEFORE exif_transpose: it returns a freshly transformed image (even
    # when no rotation is needed) whose `.format` is unset — only Image.open()'s
    # own return value carries that, found by testing (a real PNG upload was
    # silently re-encoded as JPEG until this was reordered).
    is_png = image.format == "PNG"
    image = ImageOps.exif_transpose(image) or image

    width, height = image.size
    longest = max(width, height)
    if longest > config.max_long_side_px:
        scale = config.max_long_side_px / longest
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        image = image.resize(new_size, Image.LANCZOS)
        width, height = image.size

    buffer = io.BytesIO()
    if is_png:
        image.save(buffer, format="PNG", optimize=True)
        ext = "png"
    else:
        image.convert("RGB").save(buffer, format="JPEG", quality=config.jpeg_quality, optimize=True)
        ext = "jpg"

    content = buffer.getvalue()
    hash8 = hashlib.sha256(content).hexdigest()[:8]
    filename = f"{hash8}-{_slugify(original_filename)}.{ext}"
    return ProcessedUpload(filename=filename, content=content, width=width, height=height)


def image_dimensions(path: Path) -> tuple[int, int] | None:
    """`None` if the file isn't a readable image — callers report dimensions as
    best-effort, not a hard requirement (a media grid entry is still useful
    without them)."""
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return None


_IMAGE_OBJECT_KEYS = {"src", "alt"}


def _walk_for_image_refs(value: JsonValue, top_level_key: str, out: dict[str, set[str]]) -> None:
    if isinstance(value, dict):
        src = value.get("src")
        if isinstance(src, str) and src != "" and set(value.keys()) <= _IMAGE_OBJECT_KEYS:
            out.setdefault(PurePosixPath(src).name, set()).add(top_level_key)
            return  # an image object's own src/alt strings never need recursing into
        for nested in value.values():
            _walk_for_image_refs(nested, top_level_key, out)
    elif isinstance(value, list):
        for item in value:
            _walk_for_image_refs(item, top_level_key, out)


def scan_media_references(source: SiteSource) -> dict[str, list[str]]:
    """Maps a media FILENAME (basename only, form-independent — see module
    docstring) to the sorted list of `<file>:<key>` content locations that
    reference it (spec/02 §9's "references (which binding keys use it)"),
    reported at the OUTERMOST content-key granularity: `showcase.items`, never
    a specific array index — the same granularity the overlay itself can
    address (opTargeting.ts: no dotted path indexes into a list at any depth,
    so no finer-grained reference exists anywhere else in this system either)."""
    refs: dict[str, set[str]] = {}
    for slug, content in source.page_contents.items():
        for key, value in content.items():
            _walk_for_image_refs(value, f"{slug}:{key}", refs)
    for key, value in source.global_content.items():
        _walk_for_image_refs(value, f"_global:{key}", refs)
    return {name: sorted(keys) for name, keys in refs.items()}


def delete_draft_media(paths: ProjectPaths, name: str, references: dict[str, list[str]]) -> None:
    """Deletes a STAGED (not-yet-published) upload immediately — spec/02 §9's
    "unreferenced-media delete" rule applied to the one case that doesn't need
    milestone 9's publish-time materialization: a draft upload was never written
    to the repo at all, so there's no git history/publish semantics to respect,
    just a filesystem delete. A repo (already-published) image's deletion goes
    through `stage_media_deletion` below instead — this function only ever looks
    inside `draft_media/`, so a repo image's name naturally raises
    `MediaNotFoundError` here rather than needing a separate guard."""
    target = paths.draft_media / name
    if target.resolve().parent != paths.draft_media.resolve() or not target.is_file():
        raise MediaNotFoundError(name)
    refs = references.get(name, [])
    if refs:
        raise MediaReferencedError(name, refs)
    target.unlink()


# ---------------------------------------------------------------------------
# Staged replacements + deletions of REPO images (decisions/00080)
# ---------------------------------------------------------------------------
#
# Both follow the same publish-time materialization contract as pages
# (decisions/00029): staging writes into `draft/media-replace/` /
# `draft/media-deleted.json`; the publish pipeline applies them to the checkout
# during `_materialize` (replacements overwrite `images/<name>` in place,
# deletions `git rm` it — re-validating references at publish time) and clears
# the staging only after validate succeeds, so a failed publish never loses
# either the staged intent or the published bytes.


def _safe_child(root: Path, name: str) -> Path:
    """`root / name`, refusing anything that would escape root (a `..` name)."""
    target = root / name
    if target.resolve().parent != root.resolve():
        raise MediaNotFoundError(name)
    return target


def stage_media_replacement(
    paths: ProjectPaths, name: str, data: bytes, content_type: str, config: MediaConfig
) -> ProcessedUpload:
    """Stage new bytes for an EXISTING image (repo or draft-upload), keeping its
    filename so every reference keeps working — applied to the checkout at the
    next publish. The target must exist today (a replacement of nothing is an
    upload, which has its own route)."""
    exists = (paths.repo / "images" / name).is_file() or (paths.draft_media / name).is_file()
    if not exists:
        raise MediaNotFoundError(name)
    processed = process_upload(data, name, content_type, config)
    paths.draft_media_replace.mkdir(parents=True, exist_ok=True)
    target = _safe_child(paths.draft_media_replace, name)
    target.write_bytes(processed.content)
    return processed


def unstage_media_replacement(paths: ProjectPaths, name: str) -> bool:
    """Discard a staged replacement (change of mind before publish)."""
    target = _safe_child(paths.draft_media_replace, name)
    if not target.is_file():
        return False
    target.unlink()
    return True


def load_deletion_list(paths: ProjectPaths) -> list[str]:
    if not paths.draft_media_deleted_list.exists():
        return []
    raw = load_json_object(paths.draft_media_deleted_list)
    names = raw.get("names", [])
    return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


def _save_deletion_list(paths: ProjectPaths, names: list[str]) -> None:
    paths.draft_media_deleted_list.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(paths.draft_media_deleted_list, {"names": cast(JsonValue, names)})


def stage_media_deletion(paths: ProjectPaths, name: str, references: dict[str, list[str]]) -> None:
    """Stage a REPO image for deletion at the next publish (decisions/00080) —
    the operator's escape from 'published images can't be deleted'. Only
    unreferenced images stage; the publish re-checks references when applying
    (content may have changed since) and skips anything newly referenced."""
    target = _safe_child(paths.repo / "images", name)
    if not target.is_file():
        raise MediaNotFoundError(name)
    refs = references.get(name, [])
    if refs:
        raise MediaReferencedError(name, refs)
    names = load_deletion_list(paths)
    if name not in names:
        _save_deletion_list(paths, [*names, name])


def unstage_media_deletion(paths: ProjectPaths, name: str) -> bool:
    names = load_deletion_list(paths)
    if name not in names:
        return False
    _save_deletion_list(paths, [n for n in names if n != name])
    return True


def media_staging(paths: ProjectPaths) -> dict[str, list[str]]:
    """Both staged sets, for the media grid's badges + the publisher's apply."""
    replaced = (
        sorted(p.name for p in paths.draft_media_replace.iterdir() if p.is_file())
        if paths.draft_media_replace.is_dir()
        else []
    )
    return {"replaced": replaced, "deleted": load_deletion_list(paths)}
