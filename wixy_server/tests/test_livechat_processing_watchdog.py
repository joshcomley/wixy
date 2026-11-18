"""The transcode progress watchdog (decisions/00209).

On 2026-11-12 a 15-minute voice note failed with `timeout`: the hub sat at 100% CPU,
the below-normal-priority ffmpeg was starved, and a fixed 5-minute wall clock killed
an encode that takes 10 s on an idle box. A transcode is now bounded by PROGRESS — it
is killed only when it stops moving, or passes a generous ceiling — so a busy machine
slows a long note down but never fails it.

The watchdog tests drive `_run_transcode` with tiny stand-in Python children that
write ffmpeg-style `out_time_us=` lines into the progress file, so each scenario
(slow but moving, stalled, endless trickle, megabytes of stdout) is exact and fast.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from wixy_server.livechat import processing

_PROGRESSING_CHILD = """
import sys, time
path, steps, delay = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
with open(path, "a") as fh:
    fh.write("out_time_us=N/A\\nprogress=continue\\n"); fh.flush()
    for i in range(steps):
        time.sleep(delay)
        fh.write(f"out_time_us={(i + 1) * 1000}\\nprogress=continue\\n"); fh.flush()
sys.stdout.write("done")
"""

_STALLING_CHILD = """
import sys, time
with open(sys.argv[1], "a") as fh:
    fh.write("out_time_us=1000\\nprogress=continue\\n"); fh.flush()
time.sleep(60)
"""

_BIG_STDOUT_CHILD = """
import sys
with open(sys.argv[1], "a") as fh:
    fh.write("out_time_us=1000\\n"); fh.flush()
chunk = b"x" * (1024 * 1024)
for _ in range(20):
    sys.stdout.buffer.write(chunk)
"""


def _child(script: str, progress: Path, *args: str) -> list[str]:
    return [sys.executable, "-c", script, str(progress), *args]


def _clock_from_first_write(progress: Path) -> Callable[[], float]:
    """A clock that stands still until the child has written its first progress line, then
    runs in real time — so interpreter start-up on a saturated test host (which can take
    longer than the stall window) is not mistaken for a stall. The watchdog's own handling of
    start-up is ffmpeg's 120 s `_STALL_S`, far above any interpreter launch."""
    started: list[float] = []

    def now() -> float:
        if not started:
            if not progress.exists():
                return 0.0
            started.append(time.monotonic())
        return time.monotonic() - started[0]

    return now


def test_slow_but_progressing_transcode_runs_to_completion(tmp_path: Path) -> None:
    progress = tmp_path / ".progress.txt"
    clock = _clock_from_first_write(progress)
    proc = processing._run_transcode(
        _child(_PROGRESSING_CHILD, progress, "20", "0.4"),
        progress_path=progress,
        ceiling_s=120.0,
        stall_s=5.0,
        poll_s=0.05,
        clock=clock,
    )
    # It ran well past the stall window in total, yet was never killed: only a
    # gap with NO progress counts, not the overall duration.
    assert clock() > 5.0
    assert proc.returncode == 0
    assert proc.stdout == b"done"
    assert not progress.exists()


def test_stalled_transcode_is_killed_as_timeout(tmp_path: Path) -> None:
    progress = tmp_path / ".progress.txt"
    started = time.monotonic()
    with pytest.raises(processing.MediaProcessingError) as exc:
        processing._run_transcode(
            _child(_STALLING_CHILD, progress),
            progress_path=progress,
            ceiling_s=600.0,
            stall_s=5.0,
            poll_s=0.05,
        )
    assert exc.value.reason == "timeout"
    assert "no progress" in exc.value.detail
    assert time.monotonic() - started < 40.0  # killed, not waited out (child sleeps 60 s)
    assert not progress.exists()


def test_ceiling_bounds_a_transcode_that_only_trickles(tmp_path: Path) -> None:
    progress = tmp_path / ".progress.txt"
    with pytest.raises(processing.MediaProcessingError) as exc:
        processing._run_transcode(
            _child(_PROGRESSING_CHILD, progress, "1000", "0.05"),
            progress_path=progress,
            ceiling_s=1.0,
            stall_s=30.0,
            poll_s=0.05,
        )
    assert exc.value.reason == "timeout"
    assert "ceiling" in exc.value.detail


def test_megabytes_of_stdout_never_deadlock_the_child(tmp_path: Path) -> None:
    progress = tmp_path / ".progress.txt"
    proc = processing._run_transcode(
        _child(_BIG_STDOUT_CHILD, progress),
        progress_path=progress,
        ceiling_s=60.0,
        stall_s=30.0,
        poll_s=0.05,
    )
    assert proc.returncode == 0
    assert len(proc.stdout) == 20 * 1024 * 1024


def test_missing_binary_is_media_unavailable(tmp_path: Path) -> None:
    with pytest.raises(processing.MediaProcessingError) as exc:
        processing._run_transcode(
            [str(tmp_path / "no-such-ffmpeg"), "-version"],
            progress_path=tmp_path / ".progress.txt",
            ceiling_s=10.0,
        )
    assert exc.value.reason == "media_unavailable"


# ---------------------------------------------------------------------------
# The path the user hit: a voice note whose encode outlasts a fixed budget.
# ---------------------------------------------------------------------------


@pytest.fixture
def ffmpeg_bin() -> str:
    found = shutil.which("ffmpeg")
    if found is None:
        pytest.skip("ffmpeg not on PATH")
    return found


@pytest.fixture
def ffprobe_bin() -> str:
    found = shutil.which("ffprobe")
    if found is None:
        pytest.skip("ffprobe not on PATH")
    return found


def _make_webm_voice(ffmpeg: str, dest: Path, *, duration: float) -> Path:
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=300:duration={duration}",
            "-c:a",
            "libopus",
            "-f",
            "webm",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
    return dest


def test_voice_note_outlasting_the_fixed_budget_still_processes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ffmpeg_bin: str, ffprobe_bin: str
) -> None:
    """Before decisions/00209 the voice encode ran under `_DEFAULT_TIMEOUT_S` (5 min
    of wall clock). Shrinking that budget to a sliver stands in for a starved encode
    that takes longer than it: the note failed `timeout`. Now the encode and the
    peaks pass are bounded by progress, so it processes."""
    monkeypatch.setattr(processing, "_DEFAULT_TIMEOUT_S", 1e-6)
    src = _make_webm_voice(ffmpeg_bin, tmp_path / "note.webm", duration=20.0)
    result = processing.process_voice(
        src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
    )
    assert result.duration_s == pytest.approx(20.0, abs=0.5)
    assert sorted(p.name for p in (tmp_path / "out").iterdir()) == ["play.m4a"]


@pytest.mark.parametrize("code", [126, 127])
def test_posix_nice_could_not_run_is_media_unavailable(
    monkeypatch: pytest.MonkeyPatch, code: int
) -> None:
    """On POSIX every child is launched through `nice`, which exits 127 (missing) or 126
    (not executable) instead of raising — that is an unavailable binary, not corrupt media."""
    monkeypatch.setattr(sys, "platform", "linux")
    done = subprocess.CompletedProcess(["nice"], code, b"", b"nice: 'ffmpeg': No such file")
    with pytest.raises(processing.MediaProcessingError) as exc:
        processing._checked(done, ["ffmpeg"])
    assert exc.value.reason == "media_unavailable"
    ok = subprocess.CompletedProcess(["nice"], 1, b"", b"Invalid data")
    assert processing._checked(ok, ["ffmpeg"]) is ok  # an ordinary ffmpeg failure passes through
