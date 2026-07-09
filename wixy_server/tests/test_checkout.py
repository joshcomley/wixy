from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from wixy_server.checkout import CheckoutError, current_sha, ensure_checkout


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    """A real local git repo to clone from — no network dependency in this suite."""
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


class TestEnsureCheckout:
    def test_clones_when_absent(self, origin_repo: Path, tmp_path: Path) -> None:
        dest = tmp_path / "checkout"
        ensure_checkout(str(origin_repo), "main", dest)
        assert (dest / ".git").exists()
        assert (dest / "README.md").exists()

    def test_fetches_and_fast_forwards_when_present(
        self, origin_repo: Path, tmp_path: Path
    ) -> None:
        dest = tmp_path / "checkout"
        ensure_checkout(str(origin_repo), "main", dest)
        first_sha = current_sha(dest)

        (origin_repo / "NEW.md").write_text("new file\n", encoding="utf-8")
        _git(["add", "."], origin_repo)
        _git(["commit", "-m", "second commit"], origin_repo)

        ensure_checkout(str(origin_repo), "main", dest)
        second_sha = current_sha(dest)

        assert second_sha != first_sha
        assert (dest / "NEW.md").exists()

    def test_second_call_is_a_noop_when_nothing_changed(
        self, origin_repo: Path, tmp_path: Path
    ) -> None:
        dest = tmp_path / "checkout"
        ensure_checkout(str(origin_repo), "main", dest)
        first_sha = current_sha(dest)
        ensure_checkout(str(origin_repo), "main", dest)
        assert current_sha(dest) == first_sha

    def test_clone_failure_raises_checkout_error(self, tmp_path: Path) -> None:
        dest = tmp_path / "checkout"
        with pytest.raises(CheckoutError):
            ensure_checkout(str(tmp_path / "does-not-exist"), "main", dest)


class TestCurrentSha:
    def test_returns_a_40_char_hex_sha(self, origin_repo: Path, tmp_path: Path) -> None:
        dest = tmp_path / "checkout"
        ensure_checkout(str(origin_repo), "main", dest)
        sha = current_sha(dest)
        assert len(sha) == 40
        assert all(c in "0123456789abcdef" for c in sha)
