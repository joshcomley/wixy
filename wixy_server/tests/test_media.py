"""spec/02-content-model.md §9's upload pipeline + reference scan."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from builder.config import MediaConfig, ProjectConfig
from builder.jsontypes import JsonObject
from builder.render import SiteSource
from wixy_server.media import (
    MediaNotFoundError,
    MediaReferencedError,
    MediaUploadError,
    delete_draft_media,
    process_upload,
    scan_media_references,
)
from wixy_server.storage import project_paths


@pytest.fixture
def media_config() -> MediaConfig:
    return MediaConfig(max_long_side_px=200, jpeg_quality=85)


def _make_jpeg_bytes(size: tuple[int, int] = (100, 60), color: str = "red") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


def _make_png_bytes(size: tuple[int, int] = (100, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", size, (0, 255, 0, 128)).save(buf, format="PNG")
    return buf.getvalue()


class TestProcessUpload:
    def test_accepts_a_jpeg_and_returns_a_hashed_slugged_filename(
        self, media_config: MediaConfig
    ) -> None:
        result = process_upload(_make_jpeg_bytes(), "My Photo.JPG", "image/jpeg", media_config)
        assert result.filename.endswith("-my-photo.jpg")
        assert len(result.filename.split("-")[0]) == 8  # the hash8 prefix

    def test_keeps_png_as_png(self, media_config: MediaConfig) -> None:
        result = process_upload(_make_png_bytes(), "icon.png", "image/png", media_config)
        assert result.filename.endswith(".png")
        reopened = Image.open(io.BytesIO(result.content))
        assert reopened.format == "PNG"

    def test_reencodes_non_png_as_jpeg(self, media_config: MediaConfig) -> None:
        # A GIF in, JPEG out — spec/02 §9's two-way split (PNG stays PNG,
        # everything else becomes JPEG q<n>), not a preserve-every-format rule.
        buf = io.BytesIO()
        Image.new("RGB", (50, 50), "blue").save(buf, format="GIF")
        result = process_upload(buf.getvalue(), "anim.gif", "image/gif", media_config)
        assert result.filename.endswith(".jpg")
        reopened = Image.open(io.BytesIO(result.content))
        assert reopened.format == "JPEG"

    def test_resizes_to_the_configured_longest_side(self, media_config: MediaConfig) -> None:
        result = process_upload(
            _make_jpeg_bytes((800, 400)), "wide.jpg", "image/jpeg", media_config
        )
        assert max(result.width, result.height) == 200
        assert result.width == 200
        assert result.height == 100  # aspect ratio preserved

    def test_does_not_upscale_a_smaller_image(self, media_config: MediaConfig) -> None:
        result = process_upload(_make_jpeg_bytes((60, 40)), "small.jpg", "image/jpeg", media_config)
        assert (result.width, result.height) == (60, 40)

    def test_strips_exif(self, media_config: MediaConfig) -> None:
        buf = io.BytesIO()
        image = Image.new("RGB", (100, 60), "red")
        exif = image.getexif()
        exif[0x0131] = "Some Camera Software"  # Software tag
        image.save(buf, format="JPEG", exif=exif)
        result = process_upload(buf.getvalue(), "photo.jpg", "image/jpeg", media_config)
        reopened = Image.open(io.BytesIO(result.content))
        assert not reopened.getexif()

    def test_auto_orients_from_exif_and_swaps_dimensions_for_a_90_degree_rotation(
        self, media_config: MediaConfig
    ) -> None:
        buf = io.BytesIO()
        image = Image.new("RGB", (100, 60), "red")  # landscape, as STORED
        exif = image.getexif()
        exif[0x0112] = 6  # Orientation: rotate 90 CW to display upright (portrait)
        image.save(buf, format="JPEG", exif=exif)
        result = process_upload(buf.getvalue(), "rotated.jpg", "image/jpeg", media_config)
        # after applying the rotation, the DISPLAYED (and now baked-in) image is portrait
        assert result.width < result.height

    def test_rejects_a_file_over_the_size_limit(self, media_config: MediaConfig) -> None:
        oversized = b"x" * (15 * 1024 * 1024 + 1)
        with pytest.raises(MediaUploadError, match="exceeds"):
            process_upload(oversized, "big.jpg", "image/jpeg", media_config)

    def test_rejects_svg_by_content_type(self, media_config: MediaConfig) -> None:
        with pytest.raises(MediaUploadError, match="SVG"):
            process_upload(b"<svg></svg>", "icon.svg", "image/svg+xml", media_config)

    def test_rejects_svg_by_extension_even_with_a_spoofed_content_type(
        self, media_config: MediaConfig
    ) -> None:
        with pytest.raises(MediaUploadError, match="SVG"):
            process_upload(b"<svg></svg>", "icon.svg", "image/jpeg", media_config)

    def test_rejects_a_non_image_mime_type(self, media_config: MediaConfig) -> None:
        with pytest.raises(MediaUploadError, match="unsupported content type"):
            process_upload(b"not an image", "doc.pdf", "application/pdf", media_config)

    def test_rejects_bytes_that_are_not_actually_a_readable_image(
        self, media_config: MediaConfig
    ) -> None:
        with pytest.raises(MediaUploadError, match="not a readable image"):
            process_upload(b"garbage-not-an-image", "fake.jpg", "image/jpeg", media_config)

    def test_reuploading_the_same_file_produces_the_same_filename(
        self, media_config: MediaConfig
    ) -> None:
        data = _make_jpeg_bytes()
        first = process_upload(data, "photo.jpg", "image/jpeg", media_config)
        second = process_upload(data, "photo.jpg", "image/jpeg", media_config)
        assert first.filename == second.filename

    def test_the_hash_is_of_content_not_the_original_filename(
        self, media_config: MediaConfig
    ) -> None:
        # The hash portion alone dedupes identical content; the slug portion still
        # reflects whatever original name each upload arrived under (a human-
        # readable filename, not a content fingerprint) — so re-uploading the same
        # image under a DIFFERENT original name produces the same hash but a
        # different full filename, which is correct, not a dedup failure.
        data = _make_jpeg_bytes()
        first = process_upload(data, "a.jpg", "image/jpeg", media_config)
        second = process_upload(data, "b.jpg", "image/jpeg", media_config)
        assert first.filename.split("-", 1)[0] == second.filename.split("-", 1)[0]


_UNUSED_PROJECT = ProjectConfig(
    slug="test",
    name="Test",
    repo="https://example.invalid/test.git",
    default_branch="main",
    cmd_project="test",
    domain="test.example.invalid",
    locale="en-GB",
    indexable=False,
    media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
)


def _source(page_contents: dict[str, JsonObject], global_content: JsonObject) -> SiteSource:
    # scan_media_references only reads page_contents/global_content — the rest of
    # SiteSource is irrelevant to it but required to construct one; unused
    # placeholders, never touched.
    return SiteSource(
        project=_UNUSED_PROJECT,
        pages_dir=Path("/unused/pages"),
        partials_dir=Path("/unused/partials"),
        theme=None,
        page_contents=page_contents,
        global_content=global_content,
        content_dir=Path("/unused/content"),
    )


class TestScanMediaReferences:
    def test_finds_a_direct_image_binding(self) -> None:
        source = _source(
            {"index": {"hero": {"bg": {"src": "images/hero.jpg", "alt": "Hero"}}}}, {}
        )
        refs = scan_media_references(source)
        assert refs == {"hero.jpg": ["index:hero"]}

    def test_finds_an_image_nested_inside_a_list(self) -> None:
        source = _source(
            {
                "index": {
                    "showcase": {
                        "items": [
                            {"img": {"src": "images/one.jpg", "alt": ""}, "title": "One"},
                            {"img": {"src": "images/two.jpg", "alt": ""}, "title": "Two"},
                        ]
                    }
                }
            },
            {},
        )
        refs = scan_media_references(source)
        assert refs == {"one.jpg": ["index:showcase"], "two.jpg": ["index:showcase"]}

    def test_finds_meta_ogimage(self) -> None:
        source = _source(
            {"about": {"meta": {"title": "About", "ogImage": {"src": "images/og.jpg", "alt": ""}}}},
            {},
        )
        refs = scan_media_references(source)
        assert refs == {"og.jpg": ["about:meta"]}

    def test_matches_by_filename_regardless_of_repo_vs_draft_path_prefix(self) -> None:
        source = _source(
            {"index": {"hero": {"bg": {"src": "/admin/draft-media/abc123-hero.jpg", "alt": ""}}}},
            {},
        )
        refs = scan_media_references(source)
        assert refs == {"abc123-hero.jpg": ["index:hero"]}

    def test_scans_global_content_too(self) -> None:
        source = _source({}, {"brand": {"logo": {"src": "images/logo.png", "alt": "Logo"}}})
        refs = scan_media_references(source)
        assert refs == {"logo.png": ["_global:brand"]}

    def test_aggregates_multiple_references_to_the_same_file_across_pages(self) -> None:
        source = _source(
            {
                "index": {"hero": {"bg": {"src": "images/shared.jpg", "alt": ""}}},
                "about": {"hero": {"bg": {"src": "images/shared.jpg", "alt": ""}}},
            },
            {},
        )
        refs = scan_media_references(source)
        assert refs == {"shared.jpg": ["about:hero", "index:hero"]}

    def test_a_page_with_no_images_produces_no_references(self) -> None:
        source = _source({"index": {"hero": {"title": "Hi"}}}, {})
        assert scan_media_references(source) == {}


class TestDeleteDraftMedia:
    def test_deletes_an_unreferenced_file(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "test")
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "unused.jpg").write_bytes(b"staged")

        delete_draft_media(paths, "unused.jpg", references={})

        assert not (paths.draft_media / "unused.jpg").exists()

    def test_raises_not_found_for_a_missing_file(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "test")
        paths.draft_media.mkdir(parents=True)
        with pytest.raises(MediaNotFoundError):
            delete_draft_media(paths, "does-not-exist.jpg", references={})

    def test_raises_referenced_and_does_not_delete(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "test")
        paths.draft_media.mkdir(parents=True)
        (paths.draft_media / "used.jpg").write_bytes(b"staged")

        with pytest.raises(MediaReferencedError, match="index:hero"):
            delete_draft_media(paths, "used.jpg", references={"used.jpg": ["index:hero"]})
        assert (paths.draft_media / "used.jpg").exists()

    def test_a_path_traversal_name_raises_not_found_rather_than_escaping_draft_media(
        self, tmp_path: Path
    ) -> None:
        # media.py's own guard, exercised directly — a normal HTTP client (and
        # FastAPI's own routing) normalizes ".." out of a URL before it would
        # ever reach this function, so this can't be reproduced through the
        # HTTP layer (test_routes_admin_api.py) at all; this is the only place
        # the guard is actually testable.
        paths = project_paths(tmp_path, "test")
        paths.draft_media.mkdir(parents=True)
        secret = tmp_path / "projects" / "secret.txt"
        secret.write_text("do not delete me")

        with pytest.raises(MediaNotFoundError):
            delete_draft_media(paths, "..", references={})
        assert secret.exists()

    def test_a_nested_path_name_raises_not_found(self, tmp_path: Path) -> None:
        paths = project_paths(tmp_path, "test")
        paths.draft_media.mkdir(parents=True)
        with pytest.raises(MediaNotFoundError):
            delete_draft_media(paths, "subdir/file.jpg", references={})
