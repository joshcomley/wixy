"""Device grants (spec/server-chat/03-permanent-unlock.md §2/§3, Inv 48) — the helper
module, the failure limiter, the store's grant methods (create/redeem/revoke/cap), the
v6 -> v7 migration and the janitor's two sweeps. Every clock is an explicit `now`."""

from __future__ import annotations

import base64
import hashlib
import sqlite3
from pathlib import Path

import pytest

from wixy_server.livechat import janitor
from wixy_server.livechat.grants import (
    FAILURE_LIMIT,
    FAILURE_WINDOW_S,
    GRANT_IDLE_EXPIRY_S,
    MAX_LABEL_CHARS,
    MAX_LIVE_GRANTS_PER_IDENTITY,
    REVOKED_ROW_RETENTION_S,
    GrantFailureLimiter,
    InvalidLabelError,
    clean_label,
    new_grant,
    secret_hash_from_wire,
)
from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore
from wixy_server.storage import ProjectPaths

_DAY_S = 24 * 60 * 60.0
_NOW = 5_000_000.0


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")


def _rows(db_path: Path) -> list[sqlite3.Row]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM device_grants ORDER BY created_at, rowid").fetchall()
    finally:
        conn.close()


def _enroll(
    store: LiveChatStore, *, email: str = "owner@example.com", now: float = _NOW
) -> tuple[str, str]:
    """Create a grant the way the route does; returns `(grant_id, wire secret)`."""
    grant = new_grant()
    store.create_device_grant(
        grant_id=grant.grant_id,
        secret_hash=grant.secret_hash,
        email=email,
        label="Android · Chrome",
        now=now,
        max_live=MAX_LIVE_GRANTS_PER_IDENTITY,
    )
    return grant.grant_id, grant.secret


def _redeem(
    store: LiveChatStore,
    grant_id: str,
    secret: str,
    *,
    email: str = "owner@example.com",
    now: float = _NOW,
) -> bool:
    secret_hash = secret_hash_from_wire(secret)
    assert secret_hash is not None
    return store.redeem_device_grant(
        grant_id=grant_id,
        secret_hash=secret_hash,
        email=email,
        now=now,
        max_idle_s=GRANT_IDLE_EXPIRY_S,
    )


class TestNewGrant:
    def test_secret_is_32_bytes_and_the_stored_hash_is_its_sha256(self) -> None:
        grant = new_grant()
        raw = base64.urlsafe_b64decode(grant.secret + "=")
        assert len(raw) == 32
        assert grant.secret_hash == hashlib.sha256(raw).hexdigest()

    def test_secret_is_unpadded_base64url(self) -> None:
        grant = new_grant()
        assert len(grant.secret) == 43
        assert "=" not in grant.secret and "+" not in grant.secret and "/" not in grant.secret

    def test_id_is_lowercase_hex32_and_nothing_repeats(self) -> None:
        grants = [new_grant() for _ in range(50)]
        assert all(len(g.grant_id) == 32 and int(g.grant_id, 16) >= 0 for g in grants)
        assert all(g.grant_id == g.grant_id.lower() for g in grants)
        assert len({g.grant_id for g in grants}) == 50
        assert len({g.secret for g in grants}) == 50

    def test_the_hash_never_contains_the_secret(self) -> None:
        grant = new_grant()
        assert grant.secret not in grant.secret_hash


class TestSecretHashFromWire:
    def test_round_trips_a_real_secret(self) -> None:
        grant = new_grant()
        assert secret_hash_from_wire(grant.secret) == grant.secret_hash

    @pytest.mark.parametrize(
        "bad",
        [
            None,
            42,
            b"x" * 43,
            "",
            "short",
            "A" * 42,
            "A" * 44,
            "A" * 42 + "=",
            "A" * 43 + "=",
            "A" * 42 + "+",
            "A" * 42 + "/",
            "A" * 42 + " ",
            " " + "A" * 42,
            "A" * 42 + "\n",
            "A" * 42 + "é",
        ],
    )
    def test_anything_but_a_canonical_32_byte_secret_is_refused(self, bad: object) -> None:
        assert secret_hash_from_wire(bad) is None

    def test_a_non_canonical_encoding_of_a_real_secret_is_refused(self) -> None:
        # 43 base64url chars carry 258 bits for 256 real ones: the last character has two
        # spare bits, so a second spelling of the same 32 bytes exists and must not pass.
        grant = new_grant()
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        last = alphabet.index(grant.secret[-1])
        twin = alphabet[last ^ 1]
        assert secret_hash_from_wire(grant.secret[:-1] + twin) is None


class TestCleanLabel:
    def test_none_and_blank_mean_no_label(self) -> None:
        assert clean_label(None) is None
        assert clean_label("   ") is None
        assert clean_label("\x00\x1f") is None

    def test_control_characters_are_dropped_and_whitespace_trimmed(self) -> None:
        assert clean_label("  Android\x00 · Chrome\n") == "Android · Chrome"

    def test_the_length_limit_is_inclusive(self) -> None:
        assert clean_label("x" * MAX_LABEL_CHARS) == "x" * MAX_LABEL_CHARS
        with pytest.raises(InvalidLabelError):
            clean_label("x" * (MAX_LABEL_CHARS + 1))

    @pytest.mark.parametrize("bad", [7, ["a"], {"a": 1}, True])
    def test_a_non_string_label_is_refused(self, bad: object) -> None:
        with pytest.raises(InvalidLabelError):
            clean_label(bad)


class TestGrantFailureLimiter:
    def test_allows_up_to_the_limit_then_refuses(self) -> None:
        limiter = GrantFailureLimiter()
        for i in range(FAILURE_LIMIT):
            assert limiter.retry_after_s("owner", 100.0 + i * 0.1) is None
            limiter.record_failure("owner", 100.0 + i * 0.1)
        retry = limiter.retry_after_s("owner", 101.0)
        assert retry is not None and 1 <= retry <= FAILURE_WINDOW_S

    def test_one_failure_short_of_the_limit_is_still_allowed(self) -> None:
        limiter = GrantFailureLimiter()
        for _ in range(FAILURE_LIMIT - 1):
            limiter.record_failure("owner", 100.0)
        assert limiter.retry_after_s("owner", 100.0) is None

    def test_retry_after_counts_down_to_the_oldest_failure_aging_out(self) -> None:
        limiter = GrantFailureLimiter()
        for _ in range(FAILURE_LIMIT):
            limiter.record_failure("owner", 100.0)
        assert limiter.retry_after_s("owner", 100.0) == 60
        assert limiter.retry_after_s("owner", 130.0) == 30
        assert limiter.retry_after_s("owner", 159.5) == 1
        assert limiter.retry_after_s("owner", 160.0) is None

    def test_the_window_slides(self) -> None:
        limiter = GrantFailureLimiter()
        for i in range(FAILURE_LIMIT):
            limiter.record_failure("owner", 100.0 + i)
        assert limiter.retry_after_s("owner", 110.0) is not None
        # The oldest failure (t=100) ages out at 160; one slot is free again.
        assert limiter.retry_after_s("owner", 160.0) is None

    def test_identities_are_independent(self) -> None:
        limiter = GrantFailureLimiter()
        for _ in range(FAILURE_LIMIT):
            limiter.record_failure("a@example.com", 100.0)
        assert limiter.retry_after_s("a@example.com", 100.0) is not None
        assert limiter.retry_after_s("b@example.com", 100.0) is None

    def test_an_idle_identity_leaves_no_state_behind(self) -> None:
        limiter = GrantFailureLimiter()
        limiter.record_failure("owner", 100.0)
        assert limiter.retry_after_s("owner", 100.0 + FAILURE_WINDOW_S) is None
        assert limiter._failures == {}


class TestCreateAndRedeem:
    def test_a_fresh_grant_redeems(self, store: LiveChatStore) -> None:
        grant_id, secret = _enroll(store)
        assert _redeem(store, grant_id, secret) is True

    def test_redeeming_stamps_last_used_at(self, store: LiveChatStore, db_path: Path) -> None:
        grant_id, secret = _enroll(store, now=_NOW)
        assert _redeem(store, grant_id, secret, now=_NOW + 3600) is True
        assert _rows(db_path)[0]["last_used_at"] == _NOW + 3600

    def test_a_failed_redeem_stamps_nothing(self, store: LiveChatStore, db_path: Path) -> None:
        grant_id, _secret = _enroll(store, now=_NOW)
        assert _redeem(store, grant_id, new_grant().secret, now=_NOW + 3600) is False
        assert _rows(db_path)[0]["last_used_at"] == _NOW

    def test_a_wrong_secret_is_refused(self, store: LiveChatStore) -> None:
        grant_id, _secret = _enroll(store)
        assert _redeem(store, grant_id, new_grant().secret) is False

    def test_an_unknown_id_is_refused(self, store: LiveChatStore) -> None:
        _grant_id, secret = _enroll(store)
        assert _redeem(store, "0" * 32, secret) is False

    def test_a_revoked_grant_is_refused(self, store: LiveChatStore) -> None:
        grant_id, secret = _enroll(store)
        assert store.revoke_device_grant(grant_id=grant_id, email="owner@example.com", now=_NOW)
        assert _redeem(store, grant_id, secret) is False

    def test_another_identitys_grant_is_refused(self, store: LiveChatStore) -> None:
        grant_id, secret = _enroll(store, email="owner@example.com")
        assert _redeem(store, grant_id, secret, email="intruder@example.com") is False
        assert _redeem(store, grant_id, secret, email="") is False

    def test_the_idle_window_is_thirty_days_inclusive(self, store: LiveChatStore) -> None:
        grant_id, secret = _enroll(store, now=_NOW)
        assert _redeem(store, grant_id, secret, now=_NOW + GRANT_IDLE_EXPIRY_S) is True
        # That redeem restarted the clock; measure from it.
        used_at = _NOW + GRANT_IDLE_EXPIRY_S
        assert _redeem(store, grant_id, secret, now=used_at + GRANT_IDLE_EXPIRY_S + 1) is False

    def test_a_grant_unused_for_over_thirty_days_is_refused(self, store: LiveChatStore) -> None:
        grant_id, secret = _enroll(store, now=_NOW)
        assert _redeem(store, grant_id, secret, now=_NOW + GRANT_IDLE_EXPIRY_S + 1) is False

    def test_an_expired_grant_is_not_revived_by_a_later_correct_redeem(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        grant_id, secret = _enroll(store, now=_NOW)
        assert _redeem(store, grant_id, secret, now=_NOW + GRANT_IDLE_EXPIRY_S + 1) is False
        assert _rows(db_path)[0]["last_used_at"] == _NOW

    def test_only_the_hash_is_stored(self, store: LiveChatStore, db_path: Path) -> None:
        grant_id, secret = _enroll(store)
        row = _rows(db_path)[0]
        assert row["id"] == grant_id
        assert row["secret_hash"] == secret_hash_from_wire(secret)
        assert secret not in {str(value) for value in tuple(row)}
        raw = base64.urlsafe_b64decode(secret + "=")
        db_bytes = db_path.read_bytes()
        wal = Path(f"{db_path}-wal")
        if wal.exists():
            db_bytes += wal.read_bytes()
        assert secret.encode("ascii") not in db_bytes
        assert raw not in db_bytes

    def test_the_label_is_stored_for_display_only(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        _enroll(store)
        assert _rows(db_path)[0]["label"] == "Android · Chrome"


class TestLiveGrantCap:
    def test_a_sixth_grant_revokes_the_oldest(self, store: LiveChatStore, db_path: Path) -> None:
        ids = [_enroll(store, now=_NOW + i)[0] for i in range(MAX_LIVE_GRANTS_PER_IDENTITY)]
        assert all(row["revoked_at"] is None for row in _rows(db_path))
        sixth_id, _secret = _enroll(store, now=_NOW + 100)
        revoked = {row["id"] for row in _rows(db_path) if row["revoked_at"] is not None}
        assert revoked == {ids[0]}
        assert sixth_id not in revoked

    def test_create_reports_which_grants_it_revoked(self, store: LiveChatStore) -> None:
        for i in range(MAX_LIVE_GRANTS_PER_IDENTITY):
            _enroll(store, now=_NOW + i)
        grant = new_grant()
        revoked = store.create_device_grant(
            grant_id=grant.grant_id,
            secret_hash=grant.secret_hash,
            email="owner@example.com",
            label=None,
            now=_NOW + 100,
            max_live=MAX_LIVE_GRANTS_PER_IDENTITY,
        )
        assert len(revoked) == 1

    def test_a_revoked_grant_no_longer_counts_toward_the_cap(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        ids = [_enroll(store, now=_NOW + i)[0] for i in range(MAX_LIVE_GRANTS_PER_IDENTITY)]
        store.revoke_device_grant(grant_id=ids[3], email="owner@example.com", now=_NOW + 50)
        _enroll(store, now=_NOW + 100)  # 4 live + 1 new = 5: nothing else revoked
        revoked = {row["id"] for row in _rows(db_path) if row["revoked_at"] is not None}
        assert revoked == {ids[3]}

    def test_the_cap_is_per_identity(self, store: LiveChatStore, db_path: Path) -> None:
        for i in range(MAX_LIVE_GRANTS_PER_IDENTITY):
            _enroll(store, email="a@example.com", now=_NOW + i)
        for i in range(MAX_LIVE_GRANTS_PER_IDENTITY):
            _enroll(store, email="b@example.com", now=_NOW + i)
        assert all(row["revoked_at"] is None for row in _rows(db_path))
        _enroll(store, email="a@example.com", now=_NOW + 100)
        revoked_emails = [row["email"] for row in _rows(db_path) if row["revoked_at"] is not None]
        assert revoked_emails == ["a@example.com"]

    def test_grants_created_in_the_same_instant_still_lose_the_earliest_first(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        ids = [_enroll(store, now=_NOW)[0] for _ in range(MAX_LIVE_GRANTS_PER_IDENTITY + 1)]
        revoked = {row["id"] for row in _rows(db_path) if row["revoked_at"] is not None}
        assert revoked == {ids[0]}


class TestRevocation:
    def test_revoking_own_grant_stamps_revoked_at(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        grant_id, _secret = _enroll(store)
        assert store.revoke_device_grant(grant_id=grant_id, email="owner@example.com", now=_NOW + 5)
        assert _rows(db_path)[0]["revoked_at"] == _NOW + 5

    def test_revoking_twice_succeeds_and_keeps_the_first_timestamp(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        grant_id, _secret = _enroll(store)
        assert store.revoke_device_grant(grant_id=grant_id, email="owner@example.com", now=_NOW + 5)
        assert store.revoke_device_grant(grant_id=grant_id, email="owner@example.com", now=_NOW + 9)
        assert _rows(db_path)[0]["revoked_at"] == _NOW + 5

    def test_another_identitys_grant_is_not_revoked_and_looks_unknown(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        grant_id, secret = _enroll(store, email="owner@example.com")
        assert not store.revoke_device_grant(
            grant_id=grant_id, email="intruder@example.com", now=_NOW
        )
        assert not store.revoke_device_grant(grant_id="f" * 32, email="owner@example.com", now=_NOW)
        assert _rows(db_path)[0]["revoked_at"] is None
        assert _redeem(store, grant_id, secret) is True

    def test_revoke_all_only_touches_that_identity(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        _enroll(store, email="a@example.com")
        _enroll(store, email="a@example.com")
        keep_id, keep_secret = _enroll(store, email="b@example.com")
        assert store.revoke_all_device_grants(email="a@example.com", now=_NOW + 1) == 2
        assert store.revoke_all_device_grants(email="a@example.com", now=_NOW + 2) == 0
        assert _redeem(store, keep_id, keep_secret, email="b@example.com") is True
        assert sum(1 for row in _rows(db_path) if row["revoked_at"] is not None) == 2


class TestMigration:
    def test_a_v6_database_gains_the_table_and_keeps_its_rows(self, tmp_path: Path) -> None:
        db_path = tmp_path / "server" / "server.db"
        old = LiveChatStore(db_path)
        old.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d1",
            by_email=None,
            text="kept",
            attachment_ids=[],
            now=_NOW,
        )
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("DROP TABLE device_grants")
            conn.execute("PRAGMA user_version = 6")
            conn.commit()
        finally:
            conn.close()

        fresh = LiveChatStore(db_path)
        grant_id, secret = _enroll(fresh)
        assert _redeem(fresh, grant_id, secret) is True
        messages, _more, _cursor = fresh.list_messages(before=None, limit=10)
        assert [m.text for m in messages] == ["kept"]
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
        finally:
            conn.close()

    def test_the_migration_is_idempotent(self, tmp_path: Path) -> None:
        db_path = tmp_path / "server" / "server.db"
        store = LiveChatStore(db_path)
        grant_id, secret = _enroll(store)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA user_version = 6")  # the table already exists
            conn.commit()
        finally:
            conn.close()
        again = LiveChatStore(db_path)
        assert _redeem(again, grant_id, secret) is True
        assert len(_rows(db_path)) == 1

    def test_the_table_holds_ids_and_hashes_only(self, store: LiveChatStore, db_path: Path) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(device_grants)")]
        finally:
            conn.close()
        assert columns == [
            "id",
            "secret_hash",
            "email",
            "label",
            "created_at",
            "last_used_at",
            "revoked_at",
        ]


class TestJanitorGrants:
    def test_grants_unused_for_over_thirty_days_are_revoked(
        self, store: LiveChatStore, paths: ProjectPaths, db_path: Path
    ) -> None:
        stale_id, _s = _enroll(store, now=_NOW)
        fresh_id, fresh_secret = _enroll(store, now=_NOW + 10 * _DAY_S)
        now = _NOW + 31 * _DAY_S
        report = janitor.run_once(store=store, paths=paths, now=now)
        assert report.revoked_grants == 1
        by_id = {row["id"]: row for row in _rows(db_path)}
        assert by_id[stale_id]["revoked_at"] == now
        assert by_id[fresh_id]["revoked_at"] is None
        assert _redeem(store, fresh_id, fresh_secret, now=now) is True

    def test_a_grant_used_recently_survives_an_old_creation_date(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        grant_id, secret = _enroll(store, now=_NOW)
        assert _redeem(store, grant_id, secret, now=_NOW + 25 * _DAY_S) is True
        report = janitor.run_once(store=store, paths=paths, now=_NOW + 40 * _DAY_S)
        assert report.revoked_grants == 0
        assert _redeem(store, grant_id, secret, now=_NOW + 40 * _DAY_S) is True

    def test_revoked_rows_are_deleted_a_week_after_revocation(
        self, store: LiveChatStore, paths: ProjectPaths, db_path: Path
    ) -> None:
        gone_id, _s = _enroll(store, now=_NOW)
        recent_id, _s2 = _enroll(store, now=_NOW)
        live_id, live_secret = _enroll(store, now=_NOW)
        store.revoke_device_grant(grant_id=gone_id, email="owner@example.com", now=_NOW)
        store.revoke_device_grant(
            grant_id=recent_id, email="owner@example.com", now=_NOW + 2 * _DAY_S
        )
        now = _NOW + REVOKED_ROW_RETENTION_S + 1
        report = janitor.run_once(store=store, paths=paths, now=now)
        assert report.deleted_grants == 1
        assert {row["id"] for row in _rows(db_path)} == {recent_id, live_id}
        assert _redeem(store, live_id, live_secret, now=now) is True

    def test_a_grant_revoked_by_the_sweep_is_deleted_a_week_later(
        self, store: LiveChatStore, paths: ProjectPaths, db_path: Path
    ) -> None:
        _enroll(store, now=_NOW)
        first = _NOW + 31 * _DAY_S
        janitor.run_once(store=store, paths=paths, now=first)
        assert len(_rows(db_path)) == 1
        janitor.run_once(store=store, paths=paths, now=first + REVOKED_ROW_RETENTION_S - 1)
        assert len(_rows(db_path)) == 1
        janitor.run_once(store=store, paths=paths, now=first + REVOKED_ROW_RETENTION_S + 1)
        assert _rows(db_path) == []

    def test_a_deleted_grant_leaves_no_secret_hash_behind(
        self, store: LiveChatStore, paths: ProjectPaths, db_path: Path
    ) -> None:
        grant_id, secret = _enroll(store, now=_NOW)
        secret_hash = secret_hash_from_wire(secret)
        assert secret_hash is not None
        store.revoke_device_grant(grant_id=grant_id, email="owner@example.com", now=_NOW)
        janitor.run_once(store=store, paths=paths, now=_NOW + REVOKED_ROW_RETENTION_S + 1)
        raw = db_path.read_bytes()
        wal = Path(f"{db_path}-wal")
        if wal.exists():
            raw += wal.read_bytes()
        assert secret_hash.encode("ascii") not in raw
