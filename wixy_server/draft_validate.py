"""The draft-write gate (spec/04-server.md §9, decisions/00095).

A `PATCH /api/admin/draft` op is normalized and structurally checked BEFORE it
is stored — the durable backstop behind the 2026-07-28 gallery publish-
corruption incident. The editor-side fixes (`contentModel.ts`'s attr read-back
and nbsp normalization, `mediaDialog.ts`'s `contentSrc`) close the two paths
that produced a bad op in the first place; this module makes a bad op
impossible to PERSIST regardless of where it comes from — a future editor bug,
a hand-crafted API call, or an AI agent mistake all go through the same PATCH
route.

Two passes, always in this order, both called from
`routes_admin_api._apply_draft_patch` after `sanitize_set_ops`, before
`apply_patch`:

1. **Normalize** (`normalize_set_ops`) — silent, best-effort corrections, never
   a rejection: a leading-slash repo image src (`/images/<name>`) rewrites to
   the canonical relative form (`images/<name>`) when that file genuinely
   exists on disk (the same "content form" `wixy_server.routes_admin_api.
   _content_src_for` now hands the media picker directly, so this is a belt-
   and-braces net for any OTHER path that could still produce the old form —
   a hand-authored PATCH, a future bug); an ALREADY-PUBLISHED staged upload
   (`/admin/draft-media/<name>` whose staged copy is gone but whose
   `images/<name>` exists — `rewrite_published_draft_media_src`,
   decisions/00115) rewrites to that published form; a whole-value nbsp-only
   string (a raw U+00A0, the literal `&nbsp;` entity nh3's sanitize pass
   re-serializes it as, or any mixture) collapses to `""` — mirrors
   `editor/src/contentModel.ts:normalizeEmptyText` exactly, as a backstop for
   the same click-target placeholder if it ever reaches the server
   unnormalized.
2. **Structural validate** (`check_structural`) — for every op whose
   `(file, path)` is a known collection (`COLLECTION_RULES`, plus the
   `treatments.sections` and `_global.footer.*` shapes `builder.validate`
   also special-cases), each item is checked against a STRUCTURAL SUBSET of
   its schema: type/required/properties/additionalProperties, deliberately
   NOT `pattern` (`jsonschema_lite.validate_against_schema`'s `skip_pattern`)
   — so an in-progress item (freshly added via the list toolbar, not yet
   filled in) stays a valid DRAFT state; full-schema enforcement (including
   `pattern`) remains publish-time only, in `builder.validate`. A violation
   raises `DraftValidationError` — the overlay is never mutated.
"""

from __future__ import annotations

import re
from pathlib import Path

from builder.collections import COLLECTION_RULES, FOOTER_KEY, TREATMENTS_SECTIONS_PATH
from builder.content import load_json_object, scan_image_refs
from builder.errors import ValidationResult
from builder.jsonschema_lite import validate_against_schema
from builder.jsontypes import JsonObject, JsonValue
from builder.render import SiteSource
from builder.validate import validate_site
from wixy_server.overlay import SetOp
from wixy_server.storage import ProjectPaths

_SCHEMAS_DIR = Path(__file__).parent.parent / "builder" / "schemas"
_schema_cache: dict[str, JsonObject] = {}
_DRAFT_MEDIA_URL_PREFIX = "/admin/draft-media/"


def load_schema(name: str) -> JsonObject:
    if name not in _schema_cache:
        _schema_cache[name] = load_json_object(_SCHEMAS_DIR / f"{name}.schema.json")
    return _schema_cache[name]


class DraftValidationError(Exception):
    """A PATCH op fails the structural gate — `summary` is a calm one-line
    message safe to surface as an HTTP 422 `detail`; `details` is the full,
    technical per-item breakdown for the server log (never shown to the
    owner)."""

    def __init__(self, summary: str, details: list[str]) -> None:
        self.summary = summary
        self.details = details
        super().__init__(summary)


# ---------------------------------------------------------------------------
# Normalize
# ---------------------------------------------------------------------------

_IMAGE_OBJECT_KEYS = frozenset({"src", "alt"})
_LEADING_SLASH_IMAGES_RE = re.compile(r"^/images/(.+)$")
# Mirrors editor/src/contentModel.ts's EMPTY_TEXT_RE exactly (Python's `\s` also
# matches U+00A0 — verified: re.match(r"\s", " ") — so no separate
# alternative is needed for the raw character, only for the literal entity nh3's
# sanitize pass can leave behind).
_EMPTY_TEXT_RE = re.compile(r"^(?:\s|&nbsp;)*$")


def _normalize_empty_text(value: str) -> str:
    return "" if _EMPTY_TEXT_RE.match(value) else value


def rewrite_leading_slash_src(src: str, repo_root: Path) -> str:
    """`/images/<name>` -> `images/<name>` when that file genuinely exists,
    else unchanged. Public (not `_`-prefixed): shared with
    `wixy_server.publisher._rewrite_draft_media_refs`, which applies the same
    rule at MATERIALIZE time — belt-and-braces for an overlay op that predates
    this gate (or any future bug) reaching all the way to publish still
    unnormalized."""
    match = _LEADING_SLASH_IMAGES_RE.match(src)
    if match is None:
        return src
    name = match.group(1)
    # Only rewrite when the file genuinely exists — never invent a reference to
    # something that isn't there (that's a real validate-time error to surface,
    # not something to paper over).
    return f"images/{name}" if (repo_root / "images" / name).is_file() else src


def rewrite_published_draft_media_src(src: str, paths: ProjectPaths) -> str:
    """`/admin/draft-media/<name>` -> `images/<name>` once that upload has been
    PUBLISHED, else unchanged (decisions/00115).

    A staged upload lives at `draft/media/<name>` and is referenced as
    `/admin/draft-media/<name>` until a publish copies it into the repo as
    `images/<name>` and deletes the staged copy (`publisher._materialize_
    locked`). A client holding a pre-publish copy of a collection array (the
    section panel keeps the array in memory while mounted) writes those now-dead
    `/admin/draft-media/` srcs back into the draft on its next edit — the exact
    2026-08-03 production shape, which blocks publishing on two `missing-image`
    errors that no amount of owner action clears.

    The rewrite is only ever applied when BOTH halves are certain: the staged
    copy is gone (so this can't hijack a legitimately-still-staged upload) AND
    `images/<name>` genuinely exists (the same "never invent a reference" rule
    `rewrite_leading_slash_src` follows — a name that resolves nowhere stays put
    and surfaces as the real `missing-image` error it is)."""
    if not src.startswith(_DRAFT_MEDIA_URL_PREFIX):
        return src
    name = src[len(_DRAFT_MEDIA_URL_PREFIX) :]
    if (paths.draft_media / name).is_file():
        return src  # still staged — a perfectly valid about-to-be-published ref
    return f"images/{name}" if (paths.repo / "images" / name).is_file() else src


def _normalize_src(src: str, paths: ProjectPaths) -> str:
    if src.startswith(_DRAFT_MEDIA_URL_PREFIX):
        return rewrite_published_draft_media_src(src, paths)
    return rewrite_leading_slash_src(src, paths.repo)


def _normalize_value(value: JsonValue, paths: ProjectPaths) -> JsonValue:
    if isinstance(value, dict):
        src = value.get("src")
        if isinstance(src, str) and set(value.keys()) <= _IMAGE_OBJECT_KEYS:
            out: dict[str, JsonValue] = {**value, "src": _normalize_src(src, paths)}
            alt = value.get("alt")
            if isinstance(alt, str):
                out["alt"] = _normalize_empty_text(alt)
            return out
        return {key: _normalize_value(sub, paths) for key, sub in value.items()}
    if isinstance(value, list):
        return [_normalize_value(item, paths) for item in value]
    if isinstance(value, str):
        return _normalize_empty_text(value)
    return value


def normalize_set_ops(ops: list[SetOp], paths: ProjectPaths) -> list[SetOp]:
    """Best-effort corrections applied to every op's value — never raises,
    never drops an op."""
    return [
        SetOp(file=op.file, path=op.path, value=_normalize_value(op.value, paths)) for op in ops
    ]


# ---------------------------------------------------------------------------
# Structural validate
# ---------------------------------------------------------------------------

_COLLECTION_SCHEMA_BY_KEY: dict[tuple[str, str], str] = {
    (rule.page, rule.path): rule.schema for rule in COLLECTION_RULES
}


def _structural_array_errors(value: JsonValue, schema_name: str, label: str) -> list[str]:
    if not isinstance(value, list):
        return [f"{label}: expected an array, got {type(value).__name__}"]
    schema = load_schema(schema_name)
    errors: list[str] = []
    for index, item in enumerate(value):
        errors.extend(
            validate_against_schema(item, schema, path=f"{label}[{index}]", skip_pattern=True)
        )
    return errors


def _structural_errors_for_op(op: SetOp) -> list[str]:
    schema_name = _COLLECTION_SCHEMA_BY_KEY.get((op.file, op.path))
    if schema_name is not None:
        return _structural_array_errors(op.value, schema_name, f"{op.file}:{op.path}")

    # treatments:sections — a list of sections, each with its OWN nested `cards`
    # collection (builder/collections.py's module docstring: this shape doesn't
    # fit the flat page/path/schema table). No fixed schema exists for a
    # section itself (builder.validate doesn't check one either — only `cards`),
    # so this only descends into each section's cards when present.
    if op.file == "treatments" and op.path == TREATMENTS_SECTIONS_PATH:
        if not isinstance(op.value, list):
            return [f"{op.file}:{op.path}: expected an array, got {type(op.value).__name__}"]
        errors: list[str] = []
        for index, section in enumerate(op.value):
            label = f"{op.file}:{op.path}[{index}]"
            if not isinstance(section, dict):
                errors.append(f"{label}: expected an object, got {type(section).__name__}")
                continue
            if "cards" in section:
                errors.extend(
                    _structural_array_errors(section["cards"], "treatment-card", f"{label}.cards")
                )
        return errors

    # _global:footer.<column> — spec/02 §3: footer column names aren't fixed,
    # every list found nested under footer validates against the same
    # link-item shape (builder.validate._validate_collections' own handling).
    if op.file == "_global" and op.path.startswith(f"{FOOTER_KEY}."):
        return _structural_array_errors(op.value, "footer-link", f"{op.file}:{op.path}")

    return []


def check_structural(ops: list[SetOp]) -> None:
    """Raises `DraftValidationError` if any op targeting a known collection
    fails a structural (type/required/properties/additionalProperties) check
    — never partial: the caller must not persist ANY op from a batch this
    rejects (`routes_admin_api._apply_draft_patch`'s whole-PATCH-atomic
    contract)."""
    details: list[str] = []
    bad_paths: set[str] = set()
    for op in ops:
        op_errors = _structural_errors_for_op(op)
        if op_errors:
            details.extend(op_errors)
            bad_paths.add(f"{op.file}:{op.path}")
    if not details:
        return
    sorted_paths = sorted(bad_paths)
    named = sorted_paths[0] if len(sorted_paths) == 1 else "one of these changes"
    summary = f"{named} doesn't match the site's expected content structure."
    raise DraftValidationError(summary, details)


# ---------------------------------------------------------------------------
# Full-schema validate (publish preview + preflight + repair) — a THIRD tier,
# above normalize/structural: the complete builder.validate.validate_site
# result (every check, including `pattern`), with one server-only false
# positive filtered out. Lives here (not routes_admin_api.py) so
# wixy_server.draft_repair can reuse it too without importing the routes
# module (which imports draft_repair — a cycle).
# ---------------------------------------------------------------------------


def staged_image_keys(source: SiteSource, paths: ProjectPaths) -> set[tuple[str, str]]:
    """`(file_label, dotted_key)` pairs whose image ref points at a currently
    staged (not-yet-published) draft upload that genuinely exists on disk —
    `validate_site`'s own image-existence check (`(project_root / src).
    exists()`) always false-positives on these: `src` is `/admin/draft-media/
    <name>` and an absolute-looking rhs wins pathlib's `/` operator, discarding
    `project_root` entirely, even though the file is a perfectly legitimate
    about-to-be-published upload. Mirrors `builder.validate._validate_images`'s
    own traversal exactly, so its errors can be filtered by these same keys."""
    all_content: dict[str, JsonObject] = {**source.page_contents, "_global": source.global_content}
    keys: set[tuple[str, str]] = set()
    for slug, content in all_content.items():
        file_label = "content/_global.json" if slug == "_global" else f"content/{slug}.json"
        for key_path, src in scan_image_refs(content):
            if src.startswith(_DRAFT_MEDIA_URL_PREFIX):
                name = src[len(_DRAFT_MEDIA_URL_PREFIX) :]
                if (paths.draft_media / name).is_file():
                    keys.add((file_label, key_path))
    return keys


def validate_merged_for_publish(merged: SiteSource, paths: ProjectPaths) -> ValidationResult:
    """`validate_site`'s result with the staged-draft-upload false-positive
    `missing-image` errors filtered out (`staged_image_keys`) — shared by the
    publish preview (`GET publish/preview`), the publish preflight (`POST
    publish`'s `_preflight`), and `draft_repair.run_repair`'s own post-repair
    check, so none of the three can ever drift on what counts as "ready to
    publish" (decisions/00095: before this gate existed, only the preview ran
    this check — a publish attempt against known-bad content reached
    `_materialize_locked`'s `validate_site` call deep inside the pipeline and
    surfaced as a raw `PublishError`/502, not the calm blocked state the
    drawer shows for the exact same problem)."""
    validate_result = validate_site(merged, paths.repo)
    safe_image_keys = staged_image_keys(merged, paths)
    filtered_errors = [
        e
        for e in validate_result.errors
        if not (e.code == "missing-image" and (e.file, e.key) in safe_image_keys)
    ]
    return ValidationResult(errors=filtered_errors)
