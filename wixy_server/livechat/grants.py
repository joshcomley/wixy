"""Device grants — the credential behind "Keep this device unlocked"
(spec/server-chat/03-permanent-unlock.md §2/§3, Inv 48).

A grant is a separate, revocable credential that replaces *typing the PIN* on one
device; it never replaces the unlock token. The server keeps only `sha256(secret)`; the
32-byte secret reaches the browser once, base64url-encoded, in the response that created
it. The secret is high-entropy random, so a slow password hash would add nothing.
"""

from __future__ import annotations

import base64
import hashlib
import math
import re
import secrets
import threading
import uuid
from collections import deque
from dataclasses import dataclass

MAX_LIVE_GRANTS_PER_IDENTITY = 5
GRANT_IDLE_EXPIRY_S = 30 * 24 * 60 * 60.0
REVOKED_ROW_RETENTION_S = 7 * 24 * 60 * 60.0
FAILURE_LIMIT = 10
FAILURE_WINDOW_S = 60.0
MAX_LABEL_CHARS = 80

_SECRET_BYTES = 32
_SECRET_B64_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
GRANT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True, slots=True)
class NewGrant:
    grant_id: str
    secret: str
    """base64url, no padding — the wire form handed to the client exactly once."""
    secret_hash: str
    """sha256 hex of the raw secret bytes — the only thing the store keeps."""


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def new_grant() -> NewGrant:
    raw = secrets.token_bytes(_SECRET_BYTES)
    return NewGrant(
        grant_id=uuid.uuid4().hex,
        secret=_b64url_encode(raw),
        secret_hash=hashlib.sha256(raw).hexdigest(),
    )


def secret_hash_from_wire(secret: object) -> str | None:
    """Hash a client-presented secret, or `None` when it is not a canonical 32-byte
    base64url string. Strict on purpose: `urlsafe_b64decode` alone silently drops stray
    characters, which would let several strings stand for one secret."""
    if not isinstance(secret, str) or not _SECRET_B64_RE.fullmatch(secret):
        return None
    raw = base64.urlsafe_b64decode(secret + "=")
    if len(raw) != _SECRET_BYTES or _b64url_encode(raw) != secret:
        return None
    return hashlib.sha256(raw).hexdigest()


class InvalidLabelError(ValueError):
    """The client's device label is not text, or is longer than `MAX_LABEL_CHARS`."""


def clean_label(label: object) -> str | None:
    """A display-only device label: control characters dropped, whitespace trimmed, at
    most `MAX_LABEL_CHARS`. `None`/blank means "no label"; anything else that is not a
    short string raises `InvalidLabelError`."""
    if label is None:
        return None
    if not isinstance(label, str):
        raise InvalidLabelError("label must be text")
    cleaned = _CONTROL_CHAR_RE.sub("", label).strip()
    if len(cleaned) > MAX_LABEL_CHARS:
        raise InvalidLabelError(f"label is longer than {MAX_LABEL_CHARS} characters")
    return cleaned or None


class GrantFailureLimiter:
    """`unlock-with-grant` noise limit (spec §3): `limit` failures per identity per
    `window_s`, after which further attempts are refused until the oldest failure ages
    out. Per process, in memory: a 256-bit secret cannot be guessed, so this only stops
    a misbehaving client from hammering the database — it is not the security control."""

    def __init__(self, *, limit: int = FAILURE_LIMIT, window_s: float = FAILURE_WINDOW_S) -> None:
        self._limit = limit
        self._window_s = window_s
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float] | None:
        failures = self._failures.get(key)
        if failures is None:
            return None
        while failures and failures[0] <= now - self._window_s:
            failures.popleft()
        if not failures:
            del self._failures[key]
            return None
        return failures

    def retry_after_s(self, key: str, now: float) -> int | None:
        """Whole seconds until `key` may try again, or `None` when it may try now."""
        with self._lock:
            failures = self._prune(key, now)
            if failures is None or len(failures) < self._limit:
                return None
            return max(1, math.ceil(failures[0] + self._window_s - now))

    def record_failure(self, key: str, now: float) -> None:
        with self._lock:
            self._prune(key, now)
            self._failures.setdefault(key, deque()).append(now)
