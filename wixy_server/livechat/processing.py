"""Server-chat media processing (spec/server-chat/00-brief.md §7) — pure, typed,
no DB/settings/store coupling. Every public function takes explicit input/output
paths and (where ffmpeg is needed) explicit binary paths; callers resolve those
from settings and own everything stateful (leases, quotas, the DB row). This
module only ever touches the one input file it's given and the rendition files
it's asked to write.

Pipeline for every attachment: sniff magic bytes first (`sniff`/`sniff_path`),
map the sniffed container to either the Pillow-native image path or an ffmpeg
demuxer, and reject anything unrecognised or mismatched against the claimed
`AttachmentKind` — all BEFORE ffmpeg/ffprobe ever sees the file. This is the
load-bearing hardening: an HLS playlist or ffconcat script renamed to `.mp4`
has no recognised magic bytes, so it is rejected by `sniff` and never reaches
a subprocess (§2's ffmpeg SSRF/LFI concern). Every ffprobe/ffmpeg invocation
still additionally pins `-f <demuxer> -protocol_whitelist file` as defense in
depth against ffmpeg's own format auto-detection.

Storage layout (§4) this module's outputs are named for:
    media/<id[:2]>/<id>/  full.{jpg|png|gif}  thumb.{jpg|png}   (photo)
                          play.mp4  poster.jpg             (video)
                          play.m4a                         (voice)
"""

from __future__ import annotations

import array
import io
import json
import logging
import math
import os
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from PIL import Image, ImageCms, ImageOps

from builder.jsontypes import JsonObject, JsonValue

_LOGGER = logging.getLogger(__name__)


def _register_pillow_heif() -> bool:
    try:
        import pillow_heif
    except ImportError:
        # The server can still start and serve text chat, but app.py uses this
        # capability flag to reject uploads until all media dependencies exist.
        _LOGGER.error("pillow-heif is unavailable; Server chat media uploads are disabled")
        return False
    pillow_heif.register_heif_opener()  # type: ignore[attr-defined]  # no stubs for pillow_heif
    return True


PILLOW_HEIF_AVAILABLE = _register_pillow_heif()

AttachmentKind = Literal["photo", "video", "voice"]

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class MediaProcessingError(Exception):
    """Any rejected or failed input. `.reason` is a short machine code a caller
    can store verbatim (e.g. in `AttachmentRow.failure`): "unsupported",
    "kind_mismatch", "decompression_bomb", "duration_exceeded", "corrupt",
    "timeout", or "media_unavailable" (a required media dependency is missing
    or unrunnable)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason}: {detail}" if detail else reason)


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PhotoResult:
    mime: str
    width: int
    height: int
    renditions: dict[str, Path]
    bytes_on_disk: int


@dataclass(frozen=True, slots=True)
class VoiceResult:
    mime: str
    duration_s: float
    peaks: list[float]
    renditions: dict[str, Path]
    bytes_on_disk: int


@dataclass(frozen=True, slots=True)
class VideoResult:
    mime: str
    width: int
    height: int
    duration_s: float
    renditions: dict[str, Path]
    bytes_on_disk: int


ProcessResult = PhotoResult | VoiceResult | VideoResult

# ---------------------------------------------------------------------------
# Sniffing (§7 magic-byte table)
# ---------------------------------------------------------------------------

_PILLOW_IMAGE_TAGS = frozenset({"jpeg", "png", "gif", "webp", "heif"})

# ffmpeg demuxer short names; ffmpeg's own alias matching (registered names are
# comma-lists, e.g. "mov,mp4,m4a,3gp,3g2,mj2") accepts any one of these.
_FFMPEG_DEMUXERS: dict[str, str] = {
    "isobmff": "mp4",
    "ebml": "matroska",
    "ogg": "ogg",
    "wav": "wav",
    "mp3": "mp3",
    "adts": "aac",
}

# ISO-BMFF `ftyp` brands that mean "this is a HEIC/HEIF image", not an mp4/mov
# video/audio container — both share the ftyp@4 magic, so the brand is the only
# way to tell them apart at the sniff stage.
_HEIF_BRANDS = frozenset({b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"})

_SNIFF_READ_BYTES = 64


def sniff(data: bytes) -> str:
    """Returns a short container tag: one of `_PILLOW_IMAGE_TAGS` or a key of
    `_FFMPEG_DEMUXERS`. Raises `MediaProcessingError("unsupported")` for
    anything else — deliberately BEFORE any ffmpeg/ffprobe call, so a text
    playlist (HLS `.m3u8`, an ffconcat script) renamed to a media extension is
    rejected here and never reaches a subprocess."""
    if len(data) < 12:
        raise MediaProcessingError("unsupported", "file too small to sniff")
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp":
        return "heif" if data[8:12] in _HEIF_BRANDS else "isobmff"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "ebml"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:3] == b"ID3":
        return "mp3"
    # ADTS's 12-bit sync word (FFF1/FFF9) is a subset of the broader 11-bit
    # MPEG-audio frame sync (FFEx) bit pattern, so the more specific ADTS
    # check must run first or every ADTS file would sniff as "mp3" instead.
    if data[0] == 0xFF and data[1] in (0xF1, 0xF9):
        return "adts"
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "mp3"
    raise MediaProcessingError("unsupported", "unrecognised magic bytes")


def sniff_path(path: Path) -> str:
    with path.open("rb") as handle:
        head = handle.read(_SNIFF_READ_BYTES)
    return sniff(head)


def _validate_photo_container(container: str) -> None:
    if container not in _PILLOW_IMAGE_TAGS:
        raise MediaProcessingError("kind_mismatch", f"photo claimed but sniffed '{container}'")


def _demuxer_for(container: str, *, kind: Literal["video", "voice"]) -> str:
    """Validates the sniffed container against the claimed kind's FAMILY
    (it must be an ffmpeg-recognised container, not a Pillow image) and
    returns the ffmpeg demuxer name. Stream-level validation (video-has-a-
    video-stream, voice-has-no-video-stream) happens later, once ffprobe can
    look inside the container."""
    demuxer = _FFMPEG_DEMUXERS.get(container)
    if demuxer is None:
        raise MediaProcessingError("kind_mismatch", f"{kind} claimed but sniffed '{container}'")
    return demuxer


# ---------------------------------------------------------------------------
# Subprocess hygiene
# ---------------------------------------------------------------------------

_VIDEO_TIMEOUT_S = 30 * 60.0
_DEFAULT_TIMEOUT_S = 5 * 60.0


def _run(argv: list[str], *, timeout_s: float) -> subprocess.CompletedProcess[bytes]:
    def invoke() -> subprocess.CompletedProcess[bytes]:
        if sys.platform == "win32":
            return subprocess.run(
                argv,
                capture_output=True,
                timeout=timeout_s,
                check=False,
                creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW,
            )
        return subprocess.run(
            ["nice", "-n", "10", *argv], capture_output=True, timeout=timeout_s, check=False
        )

    try:
        return invoke()
    except subprocess.TimeoutExpired as exc:
        raise MediaProcessingError("timeout", f"{argv[0]} exceeded {timeout_s:.0f}s") from exc
    except FileNotFoundError as exc:
        raise MediaProcessingError("media_unavailable", str(exc)) from exc


def _as_object(value: JsonValue) -> JsonObject:
    return value if isinstance(value, dict) else {}


def _as_list(value: JsonValue) -> list[JsonValue]:
    return value if isinstance(value, list) else []


def _str_field(obj: JsonObject, key: str) -> str | None:
    value = obj.get(key)
    return value if isinstance(value, str) else None


def _int_field(obj: JsonObject, key: str) -> int | None:
    value = obj.get(key)
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) else None


def _probe(
    path: Path, *, demuxer: str, ffprobe: str, timeout_s: float = _DEFAULT_TIMEOUT_S
) -> JsonObject:
    argv = [
        ffprobe,
        "-v",
        "error",
        "-f",
        demuxer,
        "-protocol_whitelist",
        "file",
        "-i",
        str(path),
        "-show_streams",
        "-show_format",
        "-print_format",
        "json",
    ]
    proc = _run(argv, timeout_s=timeout_s)
    if proc.returncode != 0:
        raise MediaProcessingError("corrupt", proc.stderr.decode("utf-8", "replace")[:500])
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise MediaProcessingError("corrupt", "ffprobe produced invalid JSON") from exc
    return _as_object(cast(JsonValue, parsed))


def _probe_duration_s(probed: JsonObject) -> float | None:
    fmt = _as_object(probed.get("format"))
    raw = _str_field(fmt, "duration")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.tmp-{uuid.uuid4().hex}")
    tmp.write_bytes(data)
    os.replace(tmp, dest)


def _atomic_save_image(
    image: Image.Image,
    dest: Path,
    *,
    format: str,
    optimize: bool = True,
    quality: int | None = None,
) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.tmp-{uuid.uuid4().hex}")
    try:
        if quality is None:
            image.save(tmp, format=format, optimize=optimize)
        else:
            image.save(tmp, format=format, optimize=optimize, quality=quality)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, dest)


def _unlink_quietly(*paths: Path) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Photo (§7)
# ---------------------------------------------------------------------------

_PHOTO_PIXEL_CAP = 80_000_000
_PHOTO_LONG_EDGE_CAP = 4096
_THUMB_LONG_EDGE = 480
_GRAY_16_TO_8_LUT = tuple(round(value * 255 / 65535) for value in range(65536))


def _clamp_long_edge(image: Image.Image, cap: int) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= cap:
        return image
    scale = cap / longest
    new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(new_size, Image.LANCZOS)


def _image_has_alpha(image: Image.Image) -> bool:
    return image.mode in {"RGBA", "LA", "PA"} or "transparency" in image.info


def _icc_input_image(image: Image.Image) -> Image.Image:
    """Convert Pillow modes unsupported by ImageCms while retaining color values."""
    if image.mode in {"P", "PA", "RGBA", "LA"}:
        return image.convert("RGB")
    if image.mode == "I" or image.mode.startswith("I;16"):
        return _scale_16bit_gray_to_l(image)
    if image.mode in {"RGB", "CMYK", "L"}:
        return image
    return image.convert("RGB")


def _scale_16bit_gray_to_l(image: Image.Image) -> Image.Image:
    return image.convert("I").point(_GRAY_16_TO_8_LUT, mode="L")


def _convert_to_srgb(image: Image.Image, *, has_alpha: bool) -> Image.Image:
    icc_profile = image.info.get("icc_profile")
    if not isinstance(icc_profile, bytes) or not icc_profile:
        return image
    try:
        color_image = _icc_input_image(image)
        source_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
        srgb_profile = ImageCms.createProfile("sRGB")
        converted = ImageCms.profileToProfile(
            color_image,
            source_profile,
            srgb_profile,
            renderingIntent=ImageCms.Intent.PERCEPTUAL,
            outputMode="RGB",
        )
    except Exception:
        _LOGGER.warning("Could not convert Server chat photo ICC profile to sRGB", exc_info=True)
        return image
    if has_alpha:
        converted.putalpha(image.convert("RGBA").getchannel("A"))
    return cast(Image.Image, converted)


def _normalize_photo_mode(image: Image.Image, *, has_alpha: bool) -> Image.Image:
    """Normalize all still-photo pixels to 8-bit RGB/RGBA before metadata removal."""
    if image.mode == "I" or image.mode.startswith("I;16"):
        image = _scale_16bit_gray_to_l(image)
    return image.convert("RGBA" if has_alpha else "RGB")


def _strip_image_metadata(image: Image.Image) -> Image.Image:
    """Rebuild normalized RGB/RGBA pixels without any source metadata."""
    return Image.frombytes(image.mode, image.size, image.tobytes())


def process_photo(src: Path, *, output_dir: Path) -> PhotoResult:
    container = sniff_path(src)
    _validate_photo_container(container)
    if container == "heif" and not PILLOW_HEIF_AVAILABLE:
        raise MediaProcessingError("media_unavailable", "pillow-heif is unavailable")
    try:
        with Image.open(src) as probe:
            width, height = probe.size
            if width * height > _PHOTO_PIXEL_CAP:
                raise MediaProcessingError(
                    "decompression_bomb", f"{width}x{height} exceeds the {_PHOTO_PIXEL_CAP}px cap"
                )
            probe_format = probe.format
            is_animated_gif = probe_format == "GIF" and bool(getattr(probe, "is_animated", False))

            if is_animated_gif:
                # Keep the original bytes untouched: re-encoding a multi-frame
                # animation is lossy/complex, and GIF carries no EXIF/GPS to
                # strip in the first place, so there's no privacy win to buy.
                full_path = output_dir / "full.gif"
                _atomic_write_bytes(full_path, src.read_bytes())
                mime = "image/gif"
                final_width, final_height = width, height
            image = ImageOps.exif_transpose(probe) or probe
            has_alpha = _image_has_alpha(image)
            image = _convert_to_srgb(image, has_alpha=has_alpha)
            normalized = _normalize_photo_mode(image, has_alpha=has_alpha)
            stripped = _clamp_long_edge(_strip_image_metadata(normalized), _PHOTO_LONG_EDGE_CAP)

            if is_animated_gif:
                thumb_source = stripped
            elif has_alpha:
                full_path = output_dir / "full.png"
                _atomic_save_image(stripped, full_path, format="PNG", optimize=True)
                mime = "image/png"
                final_width, final_height = stripped.size
                thumb_source = stripped
            elif probe_format in {"PNG", "GIF"}:
                full_path = output_dir / "full.png"
                _atomic_save_image(stripped, full_path, format="PNG", optimize=True)
                mime = "image/png"
                final_width, final_height = stripped.size
                thumb_source = stripped
            else:
                full_path = output_dir / "full.jpg"
                _atomic_save_image(stripped, full_path, format="JPEG", quality=88, optimize=True)
                mime = "image/jpeg"
                final_width, final_height = stripped.size
                thumb_source = stripped

            thumb = _clamp_long_edge(thumb_source, _THUMB_LONG_EDGE)
            if has_alpha:
                thumb_path = output_dir / "thumb.png"
                _atomic_save_image(thumb, thumb_path, format="PNG", optimize=True)
            else:
                thumb_path = output_dir / "thumb.jpg"
                _atomic_save_image(thumb, thumb_path, format="JPEG", quality=80, optimize=True)
    except MediaProcessingError:
        raise
    except Exception as exc:
        raise MediaProcessingError("corrupt", str(exc)) from exc

    renditions = {"full": full_path, "thumb": thumb_path}
    bytes_on_disk = sum(p.stat().st_size for p in renditions.values())
    return PhotoResult(
        mime=mime,
        width=final_width,
        height=final_height,
        renditions=renditions,
        bytes_on_disk=bytes_on_disk,
    )


# ---------------------------------------------------------------------------
# Voice (§7)
# ---------------------------------------------------------------------------

_VOICE_DURATION_CAP_S = 15 * 60.0
VOICE_DURATION_CAP_S = _VOICE_DURATION_CAP_S
"""R11's 15-minute voice cap, exported for the transcription job's own bounds."""
_VOICE_PEAK_BUCKETS = 64
_VOICE_PEAK_SAMPLE_RATE = 8000
_DURATION_TOLERANCE_S = 0.5


def _rms_peaks(pcm_s16le: bytes, *, buckets: int) -> list[float]:
    samples = array.array("h")
    samples.frombytes(pcm_s16le[: len(pcm_s16le) - (len(pcm_s16le) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    total = len(samples)
    if total == 0:
        return [0.0] * buckets
    raw: list[float] = []
    for i in range(buckets):
        start = (i * total) // buckets
        end = ((i + 1) * total) // buckets
        if end <= start:
            raw.append(0.0)
            continue
        chunk = samples[start:end]
        mean_sq = sum(s * s for s in chunk) / len(chunk)
        raw.append(math.sqrt(mean_sq) / 32768.0)
    peak = max(raw)
    if peak <= 1e-9:
        return [0.0] * buckets
    return [round(min(1.0, v / peak), 3) for v in raw]


def process_voice(src: Path, *, output_dir: Path, ffmpeg: str, ffprobe: str) -> VoiceResult:
    container = sniff_path(src)
    demuxer = _demuxer_for(container, kind="voice")

    input_probe = _probe(src, demuxer=demuxer, ffprobe=ffprobe)
    streams = [_as_object(s) for s in _as_list(input_probe.get("streams"))]
    has_audio = any(_str_field(s, "codec_type") == "audio" for s in streams)
    has_video = any(_str_field(s, "codec_type") == "video" for s in streams)
    if has_video or not has_audio:
        raise MediaProcessingError(
            "kind_mismatch", "voice requires an audio stream and no video stream"
        )

    input_duration = _probe_duration_s(input_probe)
    if (
        input_duration is not None
        and input_duration > _VOICE_DURATION_CAP_S + _DURATION_TOLERANCE_S
    ):
        raise MediaProcessingError(
            "duration_exceeded", f"{input_duration:.1f}s exceeds the voice cap"
        )

    play_path = output_dir / "play.m4a"
    play_path.parent.mkdir(parents=True, exist_ok=True)
    # ffmpeg picks the muxer from the output extension, so the temp name keeps
    # ".m4a" as its suffix (the "ipod"/m4a muxer) rather than getting a bare
    # ".tmp-<hex>" that would make it default to some other container.
    tmp_play = play_path.with_name(f"play.tmp-{uuid.uuid4().hex}.m4a")
    argv = [
        ffmpeg,
        "-y",
        "-f",
        demuxer,
        "-protocol_whitelist",
        "file",
        "-i",
        str(src),
        "-map_metadata",
        "-1",
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        str(tmp_play),
    ]
    proc = _run(argv, timeout_s=_DEFAULT_TIMEOUT_S)
    if proc.returncode != 0:
        _unlink_quietly(tmp_play)
        raise MediaProcessingError("corrupt", proc.stderr.decode("utf-8", "replace")[:500])
    os.replace(tmp_play, play_path)

    output_probe = _probe(play_path, demuxer="mp4", ffprobe=ffprobe)
    duration_s = _probe_duration_s(output_probe)
    if duration_s is None:
        _unlink_quietly(play_path)
        raise MediaProcessingError("corrupt", "produced m4a has no readable duration")
    if duration_s > _VOICE_DURATION_CAP_S + _DURATION_TOLERANCE_S:
        _unlink_quietly(play_path)
        raise MediaProcessingError("duration_exceeded", f"{duration_s:.1f}s exceeds the voice cap")

    pcm_argv = [
        ffmpeg,
        "-f",
        "mp4",
        "-protocol_whitelist",
        "file",
        "-i",
        str(play_path),
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        str(_VOICE_PEAK_SAMPLE_RATE),
        "-f",
        "s16le",
        "-",
    ]
    pcm_proc = _run(pcm_argv, timeout_s=_DEFAULT_TIMEOUT_S)
    if pcm_proc.returncode != 0:
        _unlink_quietly(play_path)
        raise MediaProcessingError("corrupt", pcm_proc.stderr.decode("utf-8", "replace")[:500])
    peaks = _rms_peaks(pcm_proc.stdout, buckets=_VOICE_PEAK_BUCKETS)

    renditions = {"play": play_path}
    bytes_on_disk = play_path.stat().st_size
    return VoiceResult(
        mime="audio/mp4",
        duration_s=duration_s,
        peaks=peaks,
        renditions=renditions,
        bytes_on_disk=bytes_on_disk,
    )


# ---------------------------------------------------------------------------
# Video (§7)
# ---------------------------------------------------------------------------

_VIDEO_DURATION_CAP_S = 600.0
_VIDEO_LONG_EDGE_CAP = 1920
_POSTER_LONG_EDGE_CAP = 960


def _parse_frame_rate(raw: str | None) -> float | None:
    if raw is None:
        return None
    if "/" in raw:
        num_s, _, den_s = raw.partition("/")
        try:
            num, den = float(num_s), float(den_s)
        except ValueError:
            return None
        return num / den if den else None
    try:
        return float(raw)
    except ValueError:
        return None


def _scale_filter(cap: int) -> str:
    # Caps the LONG edge at `cap`, preserving aspect ratio and never upscaling,
    # for either orientation (landscape drives width, portrait drives height).
    return f"scale=w='if(gt(iw,ih),min({cap},iw),-2)':h='if(gt(iw,ih),-2,min({cap},ih))'"


def _can_remux(video_stream: JsonObject, audio_stream: JsonObject | None) -> bool:
    codec_ok = _str_field(video_stream, "codec_name") == "h264"
    pix_fmt_ok = _str_field(video_stream, "pix_fmt") == "yuv420p"
    width = _int_field(video_stream, "width") or 0
    height = _int_field(video_stream, "height") or 0
    long_edge_ok = max(width, height) <= _VIDEO_LONG_EDGE_CAP
    fps = _parse_frame_rate(_str_field(video_stream, "r_frame_rate"))
    fps_ok = fps is not None and fps <= 60.0 + 1e-6
    audio_ok = audio_stream is None or _str_field(audio_stream, "codec_name") == "aac"
    return codec_ok and pix_fmt_ok and long_edge_ok and fps_ok and audio_ok


def process_video(src: Path, *, output_dir: Path, ffmpeg: str, ffprobe: str) -> VideoResult:
    container = sniff_path(src)
    demuxer = _demuxer_for(container, kind="video")

    input_probe = _probe(src, demuxer=demuxer, ffprobe=ffprobe)
    streams = [_as_object(s) for s in _as_list(input_probe.get("streams"))]
    video_streams = [s for s in streams if _str_field(s, "codec_type") == "video"]
    audio_streams = [s for s in streams if _str_field(s, "codec_type") == "audio"]
    if not video_streams:
        raise MediaProcessingError("kind_mismatch", "video requires a video stream")
    video_stream = video_streams[0]
    audio_stream = audio_streams[0] if audio_streams else None

    input_duration = _probe_duration_s(input_probe)
    if (
        input_duration is not None
        and input_duration > _VIDEO_DURATION_CAP_S + _DURATION_TOLERANCE_S
    ):
        raise MediaProcessingError(
            "duration_exceeded", f"{input_duration:.1f}s exceeds the video cap"
        )

    play_path = output_dir / "play.mp4"
    poster_path = output_dir / "poster.jpg"
    play_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_play = play_path.with_name(f"play.tmp-{uuid.uuid4().hex}.mp4")

    if _can_remux(video_stream, audio_stream):
        argv = [
            ffmpeg,
            "-y",
            "-f",
            demuxer,
            "-protocol_whitelist",
            "file",
            "-i",
            str(src),
            "-map_metadata",
            "-1",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(tmp_play),
        ]
    else:
        argv = [
            ffmpeg,
            "-y",
            "-f",
            demuxer,
            "-protocol_whitelist",
            "file",
            "-i",
            str(src),
            "-map_metadata",
            "-1",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            # ffmpeg auto-applies rotation side-data/tags to the decoded frames
            # by default (no `-noautorotate` passed), so this scale filter runs
            # on already-upright pixels — that's what makes rotation "survive"
            # the transcode path (the remux path instead just copies the
            # bitstream's own display-matrix side data, untouched by
            # `-map_metadata -1`, which only strips format/stream metadata tags).
            "-vf",
            _scale_filter(_VIDEO_LONG_EDGE_CAP),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-threads",
            "2",
            str(tmp_play),
        ]
    proc = _run(argv, timeout_s=_VIDEO_TIMEOUT_S)
    if proc.returncode != 0:
        _unlink_quietly(tmp_play)
        raise MediaProcessingError("corrupt", proc.stderr.decode("utf-8", "replace")[:500])
    os.replace(tmp_play, play_path)

    output_probe = _probe(play_path, demuxer="mp4", ffprobe=ffprobe)
    duration_s = _probe_duration_s(output_probe)
    if duration_s is None:
        _unlink_quietly(play_path)
        raise MediaProcessingError("corrupt", "produced mp4 has no readable duration")
    if duration_s > _VIDEO_DURATION_CAP_S + _DURATION_TOLERANCE_S:
        _unlink_quietly(play_path)
        raise MediaProcessingError("duration_exceeded", f"{duration_s:.1f}s exceeds the video cap")

    output_streams = [_as_object(s) for s in _as_list(output_probe.get("streams"))]
    output_video = next(
        (s for s in output_streams if _str_field(s, "codec_type") == "video"), video_stream
    )
    final_width = _int_field(output_video, "width") or (_int_field(video_stream, "width") or 0)
    final_height = _int_field(output_video, "height") or (_int_field(video_stream, "height") or 0)

    poster_ss = min(1.0, duration_s / 2.0)
    tmp_poster = poster_path.with_name(f"poster.tmp-{uuid.uuid4().hex}.jpg")
    poster_argv = [
        ffmpeg,
        "-y",
        "-f",
        "mp4",
        "-protocol_whitelist",
        "file",
        "-ss",
        f"{poster_ss:.3f}",
        "-i",
        str(play_path),
        "-frames:v",
        "1",
        "-vf",
        _scale_filter(_POSTER_LONG_EDGE_CAP),
        str(tmp_poster),
    ]
    poster_proc = _run(poster_argv, timeout_s=_DEFAULT_TIMEOUT_S)
    if poster_proc.returncode != 0:
        _unlink_quietly(tmp_poster, play_path)
        raise MediaProcessingError("corrupt", poster_proc.stderr.decode("utf-8", "replace")[:500])
    os.replace(tmp_poster, poster_path)

    renditions = {"play": play_path, "poster": poster_path}
    bytes_on_disk = sum(p.stat().st_size for p in renditions.values())
    return VideoResult(
        mime="video/mp4",
        width=final_width,
        height=final_height,
        duration_s=duration_s,
        renditions=renditions,
        bytes_on_disk=bytes_on_disk,
    )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


def process(
    kind: AttachmentKind, src: Path, *, output_dir: Path, ffmpeg: str, ffprobe: str
) -> ProcessResult:
    """Dispatches to `process_photo`/`process_voice`/`process_video`, writing
    renditions into `output_dir` (the storage layout's own per-attachment
    directory, §4). Raises `MediaProcessingError`; never returns a
    partial/failed result — a caller that gets an exception writes nothing
    it needs to clean up beyond `output_dir` itself."""
    if kind == "photo":
        return process_photo(src, output_dir=output_dir)
    if kind == "voice":
        return process_voice(src, output_dir=output_dir, ffmpeg=ffmpeg, ffprobe=ffprobe)
    if kind == "video":
        return process_video(src, output_dir=output_dir, ffmpeg=ffmpeg, ffprobe=ffprobe)
    raise MediaProcessingError("unsupported", f"unknown kind {kind!r}")
