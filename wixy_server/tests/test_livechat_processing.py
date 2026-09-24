"""spec/server-chat/00-brief.md §7 — `wixy_server.livechat.processing`.

Runs REAL ffmpeg/ffprobe against samples generated on the fly with ffmpeg's own
`lavfi` test sources (`testsrc`/`sine`), per the module brief: this is a
hardening suite, not an optional one, so a missing ffmpeg/ffprobe is a loud
fixture error (`RuntimeError`), never a `pytest.skip`.
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import cast
from unittest.mock import patch

import pillow_heif
import pytest
from PIL import Image, ImageCms
from PIL.PngImagePlugin import PngInfo
from PIL.TiffImagePlugin import IFDRational

from wixy_server.livechat import processing

pillow_heif.register_heif_opener()  # type: ignore[attr-defined]  # no stubs for pillow_heif

# ---------------------------------------------------------------------------
# ffmpeg/ffprobe resolution — never skip, fail loudly (module brief)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def ffmpeg_bin() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError(
            "ffmpeg not found on PATH. This suite runs real ffmpeg by design and is never "
            "skipped — install ffmpeg (hub: WinGet; CI: apt-get install ffmpeg) first."
        )
    return path


@pytest.fixture(scope="session")
def ffprobe_bin() -> str:
    path = shutil.which("ffprobe")
    if path is None:
        raise RuntimeError("ffprobe not found on PATH — see the ffmpeg_bin fixture.")
    return path


# ---------------------------------------------------------------------------
# Sample generation helpers
# ---------------------------------------------------------------------------


def _gen(ffmpeg: str, args: list[str], dest: Path) -> Path:
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args, str(dest)],
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    return dest


def _make_video(
    ffmpeg: str,
    dest: Path,
    *,
    codec: str = "libx264",
    width: int = 320,
    height: int = 240,
    fps: int = 30,
    duration: float = 1.0,
    audio_codec: str | None = "aac",
    rotation: int | None = None,
    location: str | None = None,
) -> Path:
    inputs = ["-f", "lavfi", "-i", f"testsrc=size={width}x{height}:rate={fps}:duration={duration}"]
    encode = ["-c:v", codec, "-pix_fmt", "yuv420p"]
    if audio_codec is not None:
        inputs += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"]
        encode += ["-c:a", audio_codec]
    else:
        encode += ["-an"]
    if location is not None:
        encode += ["-metadata", f"location={location}"]

    base = dest.with_name(f"_base_{dest.name}")
    _gen(ffmpeg, [*inputs, *encode], base)
    if rotation is None:
        base.replace(dest)
        return dest
    _gen(ffmpeg, ["-display_rotation:v:0", str(rotation), "-i", str(base), "-c", "copy"], dest)
    base.unlink()
    return dest


def _make_voice(ffmpeg: str, dest: Path, *, duration: float = 2.0, freq: float = 300.0) -> Path:
    return _gen(
        ffmpeg,
        ["-f", "lavfi", "-i", f"sine=frequency={freq}:duration={duration}", "-c:a", "libopus"],
        dest,
    )


def _probe_streams(ffprobe: str, path: Path, *, demuxer: str = "mp4") -> list[dict[str, object]]:
    result = subprocess.run(
        [
            ffprobe,
            "-hide_banner",
            "-v",
            "error",
            "-f",
            demuxer,
            "-protocol_whitelist",
            "file",
            "-i",
            str(path),
            "-show_streams",
            "-print_format",
            "json",
        ],
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    payload = json.loads(result.stdout)
    streams: list[dict[str, object]] = payload.get("streams", [])
    return streams


def _jpeg_with_gps_and_orientation(dest: Path, *, stored_size: tuple[int, int] = (100, 60)) -> Path:
    """A JPEG whose STORED pixels are `stored_size` but whose Orientation tag
    (6 = "rotate 90 CW to correct") means the true, corrected image is
    `stored_size` transposed — plus a GPS IFD, so both "orientation applied"
    and "GPS stripped" are independently checkable from the output."""
    image = Image.new("RGB", stored_size, "red")
    exif = image.getexif()
    exif[0x0112] = 6  # Orientation
    exif[0x8825] = {  # GPSInfo IFD
        1: "N",
        2: (IFDRational(51, 1), IFDRational(30, 1), IFDRational(0, 1)),
        3: "W",
        4: (IFDRational(0, 1), IFDRational(7, 1), IFDRational(0, 1)),
    }
    image.save(dest, format="JPEG", exif=exif.tobytes())
    return dest


def _animated_gif(dest: Path) -> Path:
    frames = [Image.new("RGB", (40, 20), c) for c in ("red", "green", "blue")]
    frames[0].save(
        dest, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0
    )
    return dest


def _static_gif(dest: Path) -> Path:
    Image.new("RGB", (40, 20), "purple").save(dest, format="GIF")
    return dest


def _transparent_static_gif(dest: Path) -> Path:
    image = Image.new("P", (40, 20), 0)
    image.putpalette([240, 30, 40, 20, 190, 225] + [0, 0, 0] * 254)
    image.putdata([0 if x < 20 else 1 for _y in range(20) for x in range(40)])
    image.save(dest, format="GIF", transparency=0, comment=b"private-gif-note")
    return dest


def _webp(dest: Path) -> Path:
    Image.new("RGB", (40, 20), "teal").save(dest, format="WEBP")
    return dest


def _heic(dest: Path) -> Path:
    heif_file = pillow_heif.from_pillow(Image.new("RGB", (80, 40), "orange"))  # type: ignore[attr-defined]
    heif_file.save(dest, quality=90)
    return dest


def _decompression_bomb_png(dest: Path) -> Path:
    # Huge dimensions, solid colour -> compresses to a tiny file: the "tiny
    # file, huge declared dimensions" bomb shape (not a large-file attack).
    Image.new("L", (9500, 9000), 0).save(dest, format="PNG", optimize=True)
    return dest


def _text_bytes_as(dest: Path, text: str) -> Path:
    dest.write_bytes(text.encode("ascii"))
    return dest


# ---------------------------------------------------------------------------
# Sniff
# ---------------------------------------------------------------------------


class TestSniff:
    def test_jpeg(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, format="JPEG")
        assert processing.sniff(buf.getvalue()) == "jpeg"

    def test_png(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, format="PNG")
        assert processing.sniff(buf.getvalue()) == "png"

    def test_gif(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, format="GIF")
        assert processing.sniff(buf.getvalue()) == "gif"

    def test_webp(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (4, 4)).save(buf, format="WEBP")
        assert processing.sniff(buf.getvalue()) == "webp"

    def test_heif_ftyp_brand(self) -> None:
        buf = io.BytesIO()
        pillow_heif.from_pillow(Image.new("RGB", (8, 8))).save(buf)  # type: ignore[attr-defined]
        assert processing.sniff(buf.getvalue()) == "heif"

    def test_isobmff_mp4_ftyp_brand(self) -> None:
        # A plain mp4 ftyp brand (not a HEIF brand) sniffs as "isobmff", the
        # ffmpeg-family container — proves HEIF vs. mp4/mov/m4a are told apart
        # by ftyp BRAND, not just the shared ftyp@4 magic.
        data = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 16
        assert processing.sniff(data) == "isobmff"

    def test_ebml_webm(self) -> None:
        data = b"\x1a\x45\xdf\xa3" + b"\x00" * 16
        assert processing.sniff(data) == "ebml"

    def test_ogg(self) -> None:
        data = b"OggS" + b"\x00" * 16
        assert processing.sniff(data) == "ogg"

    def test_wav(self) -> None:
        data = b"RIFF\x00\x00\x00\x00WAVEfmt " + b"\x00" * 8
        assert processing.sniff(data) == "wav"

    def test_mp3_id3_tag(self) -> None:
        data = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 8
        assert processing.sniff(data) == "mp3"

    def test_mp3_frame_sync(self) -> None:
        data = bytes([0xFF, 0xFB, 0x90, 0x00]) + b"\x00" * 12
        assert processing.sniff(data) == "mp3"

    def test_adts_aac(self) -> None:
        data = bytes([0xFF, 0xF1, 0x00, 0x00]) + b"\x00" * 12
        assert processing.sniff(data) == "adts"

    def test_unrecognised_bytes_rejected(self) -> None:
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.sniff(b"not a media file at all, just plain text!!")
        assert exc.value.reason == "unsupported"

    def test_too_short_rejected(self) -> None:
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.sniff(b"\xff\xd8")
        assert exc.value.reason == "unsupported"


# ---------------------------------------------------------------------------
# Photo
# ---------------------------------------------------------------------------


class TestProcessPhoto:
    @staticmethod
    def _assert_near_rgb(actual: tuple[int, ...], expected: tuple[int, int, int]) -> None:
        assert all(abs(actual[index] - expected[index]) <= 8 for index in range(3))

    def test_static_gif_palette_colors_survive_full_and_thumbnail(self, tmp_path: Path) -> None:
        src = _static_gif(tmp_path / "in.gif")
        with Image.open(src) as original:
            expected = original.convert("RGB").getpixel((20, 10))

        result = processing.process_photo(src, output_dir=tmp_path / "out")

        for rendition in ("full", "thumb"):
            with Image.open(result.renditions[rendition]) as image:
                pixel = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
                self._assert_near_rgb(pixel, expected)

    def test_palette_png_colors_and_metadata_survive_without_palette_loss(
        self, tmp_path: Path
    ) -> None:
        src = tmp_path / "indexed.png"
        image = Image.new("P", (40, 20), 1)
        image.putpalette([0, 0, 0, 15, 185, 225] + [0, 0, 0] * 254)
        metadata = PngInfo()
        metadata.add_text("private-note", "must be removed")
        exif = image.getexif()
        exif[0x010E] = "private-exif"
        image.save(src, format="PNG", pnginfo=metadata, exif=exif.tobytes())
        expected = image.convert("RGB").getpixel((20, 10))

        result = processing.process_photo(src, output_dir=tmp_path / "out")

        for rendition in ("full", "thumb"):
            with Image.open(result.renditions[rendition]) as output:
                pixel = output.convert("RGB").getpixel((output.width // 2, output.height // 2))
                self._assert_near_rgb(pixel, expected)
                assert "exif" not in output.info
                assert "private-note" not in output.info

    def test_transparent_palette_png_preserves_alpha_in_full_and_thumbnail(
        self, tmp_path: Path
    ) -> None:
        src = tmp_path / "transparent.png"
        image = Image.new("P", (40, 20), 0)
        image.putpalette([230, 20, 30, 10, 180, 220] + [0, 0, 0] * 254)
        image.putdata([0 if x < 20 else 1 for _y in range(20) for x in range(40)])
        image.info["transparency"] = 0
        image.save(src, format="PNG", transparency=0)

        result = processing.process_photo(src, output_dir=tmp_path / "out")

        with Image.open(result.renditions["full"]) as full:
            rgba = full.convert("RGBA")
            assert rgba.getpixel((5, 10)) == (230, 20, 30, 0)
            assert rgba.getpixel((35, 10)) == (10, 180, 220, 255)
        with Image.open(result.renditions["thumb"]) as thumb:
            rgba = thumb.convert("RGBA")
            assert rgba.getpixel((5, 10)) == (230, 20, 30, 0)
            assert rgba.getpixel((35, 10)) == (10, 180, 220, 255)
        assert result.renditions["full"].name == "full.png"
        assert result.renditions["thumb"].name == "thumb.png"

    @pytest.mark.parametrize(
        ("kind", "full_suffix", "thumb_suffix", "has_alpha"),
        [
            ("png8-opaque", ".png", ".jpg", False),
            ("png8-transparent", ".png", ".png", True),
            ("gif-opaque", ".png", ".jpg", False),
            ("gif-transparent", ".png", ".png", True),
            ("la-png", ".png", ".png", True),
            ("rgba-png", ".png", ".png", True),
            ("rgba-webp", ".png", ".png", True),
            ("gray16-png", ".png", ".jpg", False),
            ("cmyk-jpeg", ".jpg", ".jpg", False),
        ],
    )
    def test_pixel_modes_preserve_colors_alpha_and_choose_formats(
        self,
        kind: str,
        full_suffix: str,
        thumb_suffix: str,
        has_alpha: bool,
        tmp_path: Path,
    ) -> None:
        src = tmp_path / "mode-input"
        if kind.startswith("png8"):
            image = Image.new("P", (40, 20), 1)
            image.putpalette([0, 0, 0, 22, 177, 231] + [0, 0, 0] * 254)
            if has_alpha:
                image.putdata([0 if x < 20 else 1 for _y in range(20) for x in range(40)])
                image.save(src, format="PNG", transparency=0)
            else:
                image.save(src, format="PNG")
        elif kind == "gif-opaque":
            Image.new("RGB", (40, 20), "purple").save(src, format="GIF")
        elif kind == "gif-transparent":
            src = _transparent_static_gif(src)
        elif kind == "la-png":
            image = Image.new("LA", (40, 20), (175, 255))
            image.putpixel((5, 10), (90, 0))
            image.save(src, format="PNG")
        elif kind == "rgba-png":
            image = Image.new("RGBA", (40, 20), (14, 180, 220, 255))
            image.putpixel((5, 10), (240, 20, 30, 0))
            image.save(src, format="PNG")
        elif kind == "rgba-webp":
            image = Image.new("RGBA", (40, 20), (14, 180, 220, 255))
            image.putpixel((5, 10), (240, 20, 30, 0))
            image.save(src, format="WEBP", lossless=True)
        elif kind == "gray16-png":
            image = Image.new("I;16", (40, 20))
            image.putdata([0 if x < 20 else 32768 for _y in range(20) for x in range(40)])
            image.save(src, format="PNG")
        else:
            image = Image.new("CMYK", (40, 20), (210, 90, 30, 5))
            image.save(src, format="JPEG", quality=100, subsampling=0)

        with Image.open(src) as original:
            if kind == "gray16-png":
                expected = original.convert("L").convert("RGB")
            else:
                expected = original.convert("RGBA" if has_alpha else "RGB")

        result = processing.process_photo(src, output_dir=tmp_path / "out")

        assert result.renditions["full"].suffix == full_suffix
        assert result.renditions["thumb"].suffix == thumb_suffix
        points = ((5, 10), (35, 10))
        for name in ("full", "thumb"):
            with Image.open(result.renditions[name]) as output:
                rgba = output.convert("RGBA")
                for point in points:
                    actual = rgba.getpixel(point)
                    wanted = expected.convert("RGBA").getpixel(point)
                    if has_alpha:
                        assert actual == wanted
                    else:
                        assert all(
                            abs(actual[channel] - wanted[channel]) <= 8 for channel in range(3)
                        )
                        assert actual[3] == 255
                assert "exif" not in output.info
                assert "icc_profile" not in output.info
                assert "private-note" not in output.info
                assert "comment" not in output.info

    def test_display_p3_jpeg_is_converted_to_srgb_and_profile_is_stripped(
        self, tmp_path: Path
    ) -> None:
        p3_bytes = (Path(__file__).parent / "fixtures" / "display-p3.icc").read_bytes()
        p3_profile = ImageCms.ImageCmsProfile(io.BytesIO(p3_bytes))
        srgb_profile = ImageCms.createProfile("sRGB")
        src = tmp_path / "p3.jpg"
        Image.new("RGB", (40, 20), (200, 100, 50)).save(
            src, format="JPEG", quality=100, subsampling=0, icc_profile=p3_bytes
        )
        with Image.open(src) as original:
            expected = ImageCms.profileToProfile(
                original,
                p3_profile,
                srgb_profile,
                renderingIntent=ImageCms.Intent.PERCEPTUAL,
                outputMode="RGB",
            ).getpixel((20, 10))

        result = processing.process_photo(src, output_dir=tmp_path / "out")

        assert result.renditions["full"].name == "full.jpg"
        assert result.renditions["thumb"].name == "thumb.jpg"
        for rendition in result.renditions.values():
            with Image.open(rendition) as output:
                actual = output.convert("RGB").getpixel((output.width // 2, output.height // 2))
                assert all(abs(actual[channel] - expected[channel]) <= 2 for channel in range(3))
                assert "icc_profile" not in output.info

    def test_icc_conversion_failure_warns_and_still_processes_photo(
        self,
        tmp_path: Path,
        caplog: pytest.LogCaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        p3_bytes = (Path(__file__).parent / "fixtures" / "display-p3.icc").read_bytes()
        src = tmp_path / "p3.jpg"
        Image.new("RGB", (40, 20), (120, 90, 60)).save(
            src, format="JPEG", quality=100, subsampling=0, icc_profile=p3_bytes
        )

        def fail_conversion(*_args: object, **_kwargs: object) -> Image.Image:
            raise RuntimeError("forced ICC conversion failure")

        monkeypatch.setattr(ImageCms, "profileToProfile", fail_conversion)
        caplog.set_level(logging.WARNING, logger=processing.__name__)

        result = processing.process_photo(src, output_dir=tmp_path / "out")

        assert result.renditions["full"].is_file()
        assert "Could not convert Server chat photo ICC profile to sRGB" in caplog.text

    def test_exif_gps_stripped_and_orientation_applied(self, tmp_path: Path) -> None:
        src = _jpeg_with_gps_and_orientation(tmp_path / "in.jpg", stored_size=(100, 60))
        result = processing.process_photo(src, output_dir=tmp_path / "out")

        assert result.mime == "image/jpeg"
        # Orientation 6 means the corrected image is the stored size transposed.
        assert (result.width, result.height) == (60, 100)

        full = Image.open(result.renditions["full"])
        assert full.size == (60, 100)
        full_exif = full.getexif()
        assert 0x8825 not in full_exif  # GPSInfo IFD pointer gone
        assert len(full_exif) == 0

    def test_png_kept_as_png(self, tmp_path: Path) -> None:
        src = tmp_path / "in.png"
        Image.new("RGBA", (50, 30), (10, 20, 30, 128)).save(src, format="PNG")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        assert result.mime == "image/png"
        assert Image.open(result.renditions["full"]).format == "PNG"

    def test_animated_gif_kept_as_original_bytes(self, tmp_path: Path) -> None:
        src = _animated_gif(tmp_path / "in.gif")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        assert result.mime == "image/gif"
        assert result.renditions["full"].read_bytes() == src.read_bytes()
        reopened = Image.open(result.renditions["full"])
        assert getattr(reopened, "is_animated", False) is True
        # A thumbnail is still produced even though the full rendition is untouched.
        assert result.renditions["thumb"].is_file()

    def test_static_gif_becomes_lossless_png(self, tmp_path: Path) -> None:
        src = _static_gif(tmp_path / "in.gif")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        assert result.mime == "image/png"
        assert Image.open(result.renditions["full"]).format == "PNG"

    def test_webp_becomes_jpeg(self, tmp_path: Path) -> None:
        src = _webp(tmp_path / "in.webp")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        assert result.mime == "image/jpeg"

    def test_heic_decodes_and_becomes_jpeg(self, tmp_path: Path) -> None:
        src = _heic(tmp_path / "in.heic")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        assert result.mime == "image/jpeg"
        assert (result.width, result.height) == (80, 40)
        assert Image.open(result.renditions["full"]).format == "JPEG"

    def test_long_edge_clamped_to_4096(self, tmp_path: Path) -> None:
        src = tmp_path / "in.jpg"
        Image.new("RGB", (5000, 100), "red").save(src, format="JPEG")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        assert result.width == 4096
        assert Image.open(result.renditions["full"]).size == (4096, 82)

    def test_thumbnail_long_edge_480(self, tmp_path: Path) -> None:
        src = tmp_path / "in.jpg"
        Image.new("RGB", (2000, 500), "red").save(src, format="JPEG")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        thumb = Image.open(result.renditions["thumb"])
        assert max(thumb.size) == 480

    def test_decompression_bomb_rejected_before_full_decode(self, tmp_path: Path) -> None:
        src = _decompression_bomb_png(tmp_path / "bomb.png")
        assert src.stat().st_size < 200_000  # tiny file, 85.5M declared pixels
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_photo(src, output_dir=tmp_path / "out")
        assert exc.value.reason == "decompression_bomb"

    def test_kind_mismatch_when_content_is_not_an_image(
        self, tmp_path: Path, ffmpeg_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", duration=0.5)
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_photo(src, output_dir=tmp_path / "out")
        assert exc.value.reason == "kind_mismatch"

    def test_bytes_on_disk_reflects_written_renditions(self, tmp_path: Path) -> None:
        src = tmp_path / "in.jpg"
        Image.new("RGB", (200, 150), "red").save(src, format="JPEG")
        result = processing.process_photo(src, output_dir=tmp_path / "out")
        expected = sum(p.stat().st_size for p in result.renditions.values())
        assert result.bytes_on_disk == expected
        assert result.bytes_on_disk > 0


# ---------------------------------------------------------------------------
# Voice
# ---------------------------------------------------------------------------


class TestProcessVoice:
    def test_webm_opus_becomes_m4a_with_duration_and_peaks(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_voice(ffmpeg_bin, tmp_path / "in.webm", duration=2.0)
        result = processing.process_voice(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )

        assert result.mime == "audio/mp4"
        assert result.duration_s == pytest.approx(2.0, abs=0.2)
        assert result.renditions["play"].suffix == ".m4a"
        assert result.renditions["play"].is_file()

        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        assert len(streams) == 1
        assert streams[0]["codec_name"] == "aac"
        assert streams[0]["channels"] == 1

        assert len(result.peaks) == 64
        assert all(0.0 <= p <= 1.0 for p in result.peaks)
        assert max(result.peaks) == pytest.approx(
            1.0, abs=0.01
        )  # a steady tone has SOME loud bucket
        assert any(p > 0.0 for p in result.peaks)  # not silence

    def test_kind_mismatch_when_content_has_a_video_stream(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", duration=0.5)
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_voice(
                src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "kind_mismatch"

    def test_kind_mismatch_when_content_is_an_image(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = tmp_path / "in.jpg"
        Image.new("RGB", (10, 10)).save(src, format="JPEG")
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_voice(
                src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "kind_mismatch"

    def test_duration_cap_rejects_and_cleans_up(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(processing, "_VOICE_DURATION_CAP_S", 0.5)
        src = _make_voice(ffmpeg_bin, tmp_path / "in.webm", duration=2.0)
        out_dir = tmp_path / "out"
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_voice(
                src, output_dir=out_dir, ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "duration_exceeded"
        assert not (out_dir / "play.m4a").exists()
        assert list(out_dir.glob("*")) == [] if out_dir.is_dir() else True


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------


class TestProcessVideoRemuxVsTranscode:
    def test_h264_yuv420p_small_no_audio_remuxes(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", audio_codec=None, duration=0.5)
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        assert streams[0]["codec_name"] == "h264"
        # Remux (`-c copy`) never re-encodes the pixel format we already chose.

    def test_h264_with_aac_audio_remuxes(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", audio_codec="aac", duration=0.5)
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        codecs = {s["codec_type"]: s["codec_name"] for s in streams}
        assert codecs["video"] == "h264"
        assert codecs["audio"] == "aac"

    def test_hevc_always_transcodes(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(
            ffmpeg_bin, tmp_path / "in.mp4", codec="libx265", audio_codec=None, duration=0.5
        )
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        assert streams[0]["codec_name"] == "h264"  # transcode always targets h264

    def test_oversized_long_edge_transcodes_and_is_capped(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(
            ffmpeg_bin, tmp_path / "in.mp4", width=2560, height=1440, audio_codec=None, duration=0.5
        )
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        assert max(result.width, result.height) <= 1920

    def test_high_fps_transcodes(self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", fps=90, audio_codec=None, duration=0.3)
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        assert result.renditions[
            "play"
        ].is_file()  # transcoded without error; fps is re-encoded down implicitly

    def test_non_aac_audio_transcodes(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", audio_codec="libmp3lame", duration=0.5)
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        codecs = {s["codec_type"]: s["codec_name"] for s in streams}
        assert codecs["audio"] == "aac"  # re-encoded to aac, proving transcode ran


class TestProcessVideoRotation:
    def test_rotation_survives_remux(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(
            ffmpeg_bin,
            tmp_path / "in.mp4",
            audio_codec=None,
            duration=0.5,
            rotation=90,
            width=320,
            height=240,
        )
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        side_data = cast("list[dict[str, object]]", streams[0].get("side_data_list", []))
        assert any(sd.get("rotation") == 90 for sd in side_data)

    def test_rotation_survives_transcode(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        # HEVC forces the transcode path regardless of other params.
        src = _make_video(
            ffmpeg_bin,
            tmp_path / "in.mp4",
            codec="libx265",
            audio_codec=None,
            duration=0.5,
            rotation=90,
            width=320,
            height=240,
        )
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        streams = _probe_streams(ffprobe_bin, result.renditions["play"])
        # Transcode BAKES the rotation into the pixels (no side data survives);
        # a 90 deg rotation of a non-square source swaps width and height.
        assert streams[0].get("side_data_list", []) == []
        assert (streams[0]["width"], streams[0]["height"]) == (240, 320)
        assert (result.width, result.height) == (240, 320)


class TestProcessVideoMisc:
    def test_container_metadata_location_is_stripped(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(
            ffmpeg_bin,
            tmp_path / "in.mp4",
            audio_codec=None,
            duration=0.3,
            location="+51.5074-000.1278/",
        )
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        probe = subprocess.run(
            [
                ffprobe_bin,
                "-hide_banner",
                "-v",
                "error",
                "-f",
                "mp4",
                "-protocol_whitelist",
                "file",
                "-i",
                str(result.renditions["play"]),
                "-show_format",
                "-print_format",
                "json",
            ],
            capture_output=True,
        )
        assert probe.returncode == 0
        tags = json.loads(probe.stdout)["format"].get("tags", {})
        assert "location" not in tags
        assert "location-eng" not in tags

    def test_poster_generated_and_capped_at_960(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(
            ffmpeg_bin, tmp_path / "in.mp4", width=2000, height=1000, audio_codec=None, duration=0.5
        )
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        poster = Image.open(result.renditions["poster"])
        assert max(poster.size) <= 960
        assert poster.format == "JPEG"

    def test_kind_mismatch_when_no_video_stream(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_voice(ffmpeg_bin, tmp_path / "in.webm", duration=0.5)
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_video(
                src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "kind_mismatch"

    def test_duration_cap_rejects_and_cleans_up(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(processing, "_VIDEO_DURATION_CAP_S", 0.5)
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", audio_codec=None, duration=2.0)
        out_dir = tmp_path / "out"
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process_video(
                src, output_dir=out_dir, ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "duration_exceeded"
        assert not (out_dir / "play.mp4").exists()
        assert not (out_dir / "poster.jpg").exists()

    def test_bytes_on_disk_reflects_play_and_poster(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", audio_codec=None, duration=0.5)
        result = processing.process_video(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        expected = sum(p.stat().st_size for p in result.renditions.values())
        assert result.bytes_on_disk == expected


# ---------------------------------------------------------------------------
# Security hardening (§2)
# ---------------------------------------------------------------------------


class TestSecurityHardening:
    @pytest.mark.parametrize("kind", ["photo", "voice", "video"])
    def test_hls_playlist_disguised_as_media_never_reaches_ffmpeg(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: processing.AttachmentKind
    ) -> None:
        def _boom(*args: object, **kwargs: object) -> object:
            raise AssertionError("ffmpeg/ffprobe must never be invoked for unrecognised input")

        monkeypatch.setattr(processing, "_run", _boom)
        src = _text_bytes_as(
            tmp_path / "playlist.mp4",
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nsegment0.ts\n#EXT-X-ENDLIST\n",
        )
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process(
                kind, src, output_dir=tmp_path / "out", ffmpeg="unused", ffprobe="unused"
            )
        assert exc.value.reason == "unsupported"

    @pytest.mark.parametrize("kind", ["photo", "voice", "video"])
    def test_concat_playlist_disguised_as_media_never_reaches_ffmpeg(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: processing.AttachmentKind
    ) -> None:
        def _boom(*args: object, **kwargs: object) -> object:
            raise AssertionError("ffmpeg/ffprobe must never be invoked for unrecognised input")

        monkeypatch.setattr(processing, "_run", _boom)
        src = _text_bytes_as(
            tmp_path / "list.mov", "ffconcat version 1.0\nfile 'a.mp4'\nfile 'b.mp4'\n"
        )
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process(
                kind, src, output_dir=tmp_path / "out", ffmpeg="unused", ffprobe="unused"
            )
        assert exc.value.reason == "unsupported"

    def test_decompression_bomb_rejected_via_dispatcher(self, tmp_path: Path) -> None:
        src = _decompression_bomb_png(tmp_path / "bomb.png")
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process(
                "photo", src, output_dir=tmp_path / "out", ffmpeg="unused", ffprobe="unused"
            )
        assert exc.value.reason == "decompression_bomb"

    def test_video_content_submitted_as_voice_is_rejected(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", duration=0.3)
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process(
                "voice", src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "kind_mismatch"

    def test_audio_only_content_submitted_as_video_is_rejected(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_voice(ffmpeg_bin, tmp_path / "in.webm", duration=0.3)
        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.process(
                "video", src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
            )
        assert exc.value.reason == "kind_mismatch"


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


class TestProcessDispatcher:
    def test_photo_kind_dispatches_to_process_photo(self, tmp_path: Path) -> None:
        src = tmp_path / "in.jpg"
        Image.new("RGB", (10, 10)).save(src, format="JPEG")
        result = processing.process(
            "photo", src, output_dir=tmp_path / "out", ffmpeg="unused", ffprobe="unused"
        )
        assert isinstance(result, processing.PhotoResult)

    def test_voice_kind_dispatches_to_process_voice(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_voice(ffmpeg_bin, tmp_path / "in.webm", duration=0.3)
        result = processing.process(
            "voice", src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        assert isinstance(result, processing.VoiceResult)

    def test_video_kind_dispatches_to_process_video(
        self, tmp_path: Path, ffmpeg_bin: str, ffprobe_bin: str
    ) -> None:
        src = _make_video(ffmpeg_bin, tmp_path / "in.mp4", audio_codec=None, duration=0.3)
        result = processing.process(
            "video", src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )
        assert isinstance(result, processing.VideoResult)


def test_pillow_heif_import_failure_is_reported_as_unavailable() -> None:
    with patch("builtins.__import__", side_effect=ImportError("forced missing pillow-heif")):
        assert processing._register_pillow_heif() is False
