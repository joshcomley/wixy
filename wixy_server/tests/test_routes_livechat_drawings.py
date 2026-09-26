"""`/api/admin/server/drawings*` and `GET /messages/{seq}/drawings`
(spec/server-chat/07-live-drawing.md) through a real app: auth, the full validation
matrix, idempotency, limits, the live relay's rate limit and SSE `drawing_live` frame
shape, per-connection broker isolation, and cascade erasure through the DELETE routes.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat.drawing_broker import DrawingBroker, LiveDrawingQueue
from wixy_server.livechat.drawings import (
    DRAWING_COLORS,
    DRAWING_WIDTHS,
    MAX_DRAWINGS_PER_ANCHOR,
    MAX_STROKES_PER_DRAWING,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE, ServerAuth
from wixy_server.livechat.transcription import SlidingWindowRateLimiter
from wixy_server.routes_livechat import _stream_events
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": str(origin_repo),
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "engine commit"], root)
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    return state


@pytest.fixture
def pin_verifier(fake_cmd_state: FakeCmdState) -> CmdPinVerifier:
    fake_app = create_fake_cmd_app(fake_cmd_state)
    return CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app))


def _unlock(client: TestClient, *, pin: str = TEST_PIN) -> Any:
    return client.post(
        "/api/admin/server/unlock",
        json={"pin": pin},
        headers={UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE},
    )


def _unlocked_client(
    storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
) -> tuple[TestClient, dict[str, str]]:
    app = create_app(
        storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
    )
    client = TestClient(app)
    client.__enter__()
    token = _unlock(client).json()["token"]
    return client, {"X-Wixy-Server-Token": token}


def _send_anchor(client: TestClient, headers: dict[str, str], *, client_id: str) -> int:
    response = client.post(
        "/api/admin/server/messages",
        json={
            "clientId": client_id,
            "sender": "Josh",
            "deviceId": "device-anchor-seed",
            "text": "anchor message",
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return int(response.json()["message"]["seq"])


def _create_body(
    *,
    client_id: str = "draw-route-client",
    anchor_seq: int,
    column_width: float = 390.0,
    sender: str = "Josh",
    device_id: str = "device-route-aaaa",
    stroke_id: str = "stroke-route-aaaa",
    color: str = DRAWING_COLORS[0],
    width: int = DRAWING_WIDTHS[0],
    points: list[list[int]] | None = None,
) -> dict[str, Any]:
    return {
        "clientId": client_id,
        "anchorSeq": anchor_seq,
        "columnWidth": column_width,
        "sender": sender,
        "deviceId": device_id,
        "stroke": {
            "strokeId": stroke_id,
            "color": color,
            "width": width,
            "points": points if points is not None else [[1, 2], [3, 4]],
        },
    }


class TestAuthIsRequiredOnEveryRoute:
    def test_create_without_a_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-auth-anchor")
            response = client.post("/api/admin/server/drawings", json=_create_body(anchor_seq=seq))
            assert response.status_code == 401
            assert response.json() == {"error": "locked"}
        finally:
            client.__exit__(None, None, None)

    def test_append_stroke_without_a_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-auth-anchor-2")
            created = client.post(
                "/api/admin/server/drawings", json=_create_body(anchor_seq=seq), headers=headers
            )
            drawing_id = created.json()["id"]
            response = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes",
                json={
                    "strokeId": "stroke-noauth",
                    "color": DRAWING_COLORS[0],
                    "width": DRAWING_WIDTHS[0],
                    "points": [[1, 2], [3, 4]],
                },
            )
            assert response.status_code == 401
        finally:
            client.__exit__(None, None, None)

    def test_delete_without_a_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-auth-anchor-3")
            created = client.post(
                "/api/admin/server/drawings", json=_create_body(anchor_seq=seq), headers=headers
            )
            drawing_id = created.json()["id"]
            response = client.delete(f"/api/admin/server/drawings/{drawing_id}")
            assert response.status_code == 401
        finally:
            client.__exit__(None, None, None)

    def test_get_drawings_without_a_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-auth-anchor-4")
            response = client.get(f"/api/admin/server/messages/{seq}/drawings")
            assert response.status_code == 401
        finally:
            client.__exit__(None, None, None)

    def test_live_without_a_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-auth-anchor-5")
            response = client.post(
                "/api/admin/server/drawings/live",
                json={
                    "drawingClientId": "draw-client-live-noauth",
                    "anchorSeq": seq,
                    "columnWidth": 390.0,
                    "strokeId": "stroke-live-noauth",
                    "batch": 0,
                    "color": DRAWING_COLORS[0],
                    "width": DRAWING_WIDTHS[0],
                    "points": [[1, 2]],
                },
            )
            assert response.status_code == 401
        finally:
            client.__exit__(None, None, None)


class TestCreateDrawingRoute:
    def test_creates_and_returns_201_with_id_and_rev(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-1")
            response = client.post(
                "/api/admin/server/drawings", json=_create_body(anchor_seq=seq), headers=headers
            )
            assert response.status_code == 201, response.text
            body = response.json()
            assert body["rev"] == 1
            assert isinstance(body["id"], int)
        finally:
            client.__exit__(None, None, None)

    def test_a_repeated_client_id_is_200_with_the_same_drawing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-2")
            body = _create_body(anchor_seq=seq, client_id="draw-client-repeat-route")
            first = client.post("/api/admin/server/drawings", json=body, headers=headers)
            second = client.post("/api/admin/server/drawings", json=body, headers=headers)
            assert first.status_code == 201
            assert second.status_code == 200
            assert first.json() == second.json()
        finally:
            client.__exit__(None, None, None)

    def test_an_unknown_anchor_seq_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/drawings",
                json=_create_body(anchor_seq=999999),
                headers=headers,
            )
            assert response.status_code == 404
            assert response.json() == {"error": "not_found"}
        finally:
            client.__exit__(None, None, None)

    def test_a_deleted_anchor_seq_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-deleted")
            deleted = client.delete(f"/api/admin/server/messages/{seq}", headers=headers)
            assert deleted.status_code == 204
            response = client.post(
                "/api/admin/server/drawings", json=_create_body(anchor_seq=seq), headers=headers
            )
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("clientId", "short"),
            ("clientId", "x" * 65),
            ("deviceId", "short"),
            ("deviceId", "x" * 65),
            ("sender", ""),
            ("sender", "   "),
            ("sender", "x" * 33),
            ("columnWidth", 199.0),
            ("columnWidth", 4001.0),
        ],
    )
    def test_top_level_field_validation_is_422(
        self,
        field: str,
        value: object,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-validation")
            body = _create_body(anchor_seq=seq)
            body[field] = value
            response = client.post("/api/admin/server/drawings", json=body, headers=headers)
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("strokeId", "short"),
            ("strokeId", "x" * 65),
            ("color", "#000000"),
            ("color", ""),
            ("width", 1),
            ("width", 3),
        ],
    )
    def test_stroke_field_validation_is_422(
        self,
        field: str,
        value: object,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-stroke-validation")
            body = _create_body(anchor_seq=seq)
            body["stroke"][field] = value
            response = client.post("/api/admin/server/drawings", json=body, headers=headers)
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        "points",
        [
            [[1, 2]],  # only one point
            [[1, 2]] * 1001,  # over the 1000-pair cap
            [[-51, 2], [3, 4]],  # x below -50
            [[1, 2, 3], [4, 5]],  # not a pair
            [[1, -20001], [2, 3]],  # y below -20000
            [[1, 20001], [2, 3]],  # y above 20000
        ],
    )
    def test_stroke_points_validation_is_422(
        self,
        points: list[list[int]],
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-points-validation")
            body = _create_body(anchor_seq=seq, points=points)
            response = client.post("/api/admin/server/drawings", json=body, headers=headers)
            assert response.status_code == 422, response.text
        finally:
            client.__exit__(None, None, None)

    def test_a_non_integer_point_is_422_not_500(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Path data must be built only from validated numbers (spec §3) — a float
        smuggled past `StrictInt` must 422, never coerce or crash."""
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-float-point")
            body = _create_body(anchor_seq=seq, points=[[1.5, 2], [3, 4]])  # type: ignore[list-item]
            response = client.post("/api/admin/server/drawings", json=body, headers=headers)
            assert response.status_code == 422, response.text
        finally:
            client.__exit__(None, None, None)

    def test_the_twenty_first_drawing_on_one_anchor_is_409_full(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-create-limit")
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            for i in range(MAX_DRAWINGS_PER_ANCHOR):
                store.create_drawing(
                    client_id=f"draw-limit-seed-{i}",
                    anchor_seq=seq,
                    column_width=390.0,
                    sender="Josh",
                    device_id="device-1",
                    by_email=None,
                    stroke_id="s0",
                    color=DRAWING_COLORS[0],
                    width=DRAWING_WIDTHS[0],
                    points=[(1, 2)] * 2,
                    now=100.0 + i,
                )
            response = client.post(
                "/api/admin/server/drawings",
                json=_create_body(anchor_seq=seq, client_id="draw-limit-overflow"),
                headers=headers,
            )
            assert response.status_code == 409
            assert response.json() == {"error": "full"}
        finally:
            client.__exit__(None, None, None)


class TestAppendStrokeRoute:
    def _seed_drawing(
        self, client: TestClient, headers: dict[str, str], *, anchor_client_id: str
    ) -> int:
        seq = _send_anchor(client, headers, client_id=anchor_client_id)
        created = client.post(
            "/api/admin/server/drawings",
            json=_create_body(anchor_seq=seq, client_id=f"draw-{anchor_client_id}"),
            headers=headers,
        )
        return int(created.json()["id"])

    def test_appends_and_returns_the_new_rev(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            drawing_id = self._seed_drawing(client, headers, anchor_client_id="client-append-1")
            response = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes",
                json={
                    "strokeId": "stroke-append-aaaa",
                    "color": DRAWING_COLORS[1],
                    "width": DRAWING_WIDTHS[1],
                    "points": [[5, 6], [7, 8]],
                },
                headers=headers,
            )
            assert response.status_code == 200, response.text
            assert response.json() == {"rev": 2}
        finally:
            client.__exit__(None, None, None)

    def test_a_repeated_stroke_id_is_200_and_a_no_op(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            drawing_id = self._seed_drawing(client, headers, anchor_client_id="client-append-2")
            body = {
                "strokeId": "stroke-repeat-aaaa",
                "color": DRAWING_COLORS[1],
                "width": DRAWING_WIDTHS[1],
                "points": [[5, 6], [7, 8]],
            }
            first = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes", json=body, headers=headers
            )
            second = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes", json=body, headers=headers
            )
            assert first.status_code == second.status_code == 200
            assert first.json() == second.json() == {"rev": 2}
        finally:
            client.__exit__(None, None, None)

    def test_an_unknown_drawing_id_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/drawings/999999/strokes",
                json={
                    "strokeId": "stroke-unknown-aaaa",
                    "color": DRAWING_COLORS[0],
                    "width": DRAWING_WIDTHS[0],
                    "points": [[1, 2], [3, 4]],
                },
                headers=headers,
            )
            assert response.status_code == 404
            assert response.json() == {"error": "not_found"}
        finally:
            client.__exit__(None, None, None)

    def test_a_deleted_drawing_id_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            drawing_id = self._seed_drawing(client, headers, anchor_client_id="client-append-del")
            client.delete(f"/api/admin/server/drawings/{drawing_id}", headers=headers)
            response = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes",
                json={
                    "strokeId": "stroke-after-delete-aaaa",
                    "color": DRAWING_COLORS[0],
                    "width": DRAWING_WIDTHS[0],
                    "points": [[1, 2], [3, 4]],
                },
                headers=headers,
            )
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("strokeId", "short"),
            ("color", "#not-a-color"),
            ("width", 100),
            ("points", [[1, 2]]),
        ],
    )
    def test_field_validation_is_422(
        self,
        field: str,
        value: object,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            drawing_id = self._seed_drawing(client, headers, anchor_client_id="client-append-val")
            body: dict[str, Any] = {
                "strokeId": "stroke-valid-base-aaaa",
                "color": DRAWING_COLORS[0],
                "width": DRAWING_WIDTHS[0],
                "points": [[1, 2], [3, 4]],
            }
            body[field] = value
            response = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes", json=body, headers=headers
            )
            assert response.status_code == 422, response.text
        finally:
            client.__exit__(None, None, None)

    def test_the_two_hundredth_stroke_succeeds_and_the_next_is_409_full(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            drawing_id = self._seed_drawing(client, headers, anchor_client_id="client-append-cap")
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            for i in range(1, MAX_STROKES_PER_DRAWING):
                store.append_stroke(
                    drawing_id=drawing_id,
                    stroke_id=f"stroke-cap-seed-{i}",
                    color=DRAWING_COLORS[0],
                    width=DRAWING_WIDTHS[0],
                    points=[(1, 2)] * 2,
                    now=100.0 + i,
                )
            response = client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes",
                json={
                    "strokeId": "stroke-cap-overflow",
                    "color": DRAWING_COLORS[0],
                    "width": DRAWING_WIDTHS[0],
                    "points": [[1, 2], [3, 4]],
                },
                headers=headers,
            )
            assert response.status_code == 409
            assert response.json() == {"error": "full"}
        finally:
            client.__exit__(None, None, None)


class TestDeleteDrawingRoute:
    def test_deletes_and_returns_204(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-del-1")
            created = client.post(
                "/api/admin/server/drawings",
                json=_create_body(anchor_seq=seq, client_id="draw-del-1"),
                headers=headers,
            )
            drawing_id = created.json()["id"]
            response = client.delete(f"/api/admin/server/drawings/{drawing_id}", headers=headers)
            assert response.status_code == 204
            after = client.get(f"/api/admin/server/messages/{seq}/drawings", headers=headers)
            assert after.json()["drawings"] == []
        finally:
            client.__exit__(None, None, None)

    def test_a_second_delete_is_still_204_idempotent(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-del-2")
            created = client.post(
                "/api/admin/server/drawings",
                json=_create_body(anchor_seq=seq, client_id="draw-del-2"),
                headers=headers,
            )
            drawing_id = created.json()["id"]
            first = client.delete(f"/api/admin/server/drawings/{drawing_id}", headers=headers)
            second = client.delete(f"/api/admin/server/drawings/{drawing_id}", headers=headers)
            assert first.status_code == second.status_code == 204
        finally:
            client.__exit__(None, None, None)

    def test_an_unknown_drawing_id_is_still_204(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.delete("/api/admin/server/drawings/999999", headers=headers)
            assert response.status_code == 204
        finally:
            client.__exit__(None, None, None)

    def test_either_person_may_delete_any_drawing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Inv 46's "Delete for everyone" pattern: the deleting client's own headers
        carry no notion of "sender" at all — there is no ownership check."""
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-del-other")
            created = client.post(
                "/api/admin/server/drawings",
                json=_create_body(
                    anchor_seq=seq,
                    client_id="draw-del-other",
                    sender="Purdy",
                    device_id="device-purdy-aaaa",
                ),
                headers=headers,
            )
            drawing_id = created.json()["id"]
            response = client.delete(f"/api/admin/server/drawings/{drawing_id}", headers=headers)
            assert response.status_code == 204
        finally:
            client.__exit__(None, None, None)


class TestGetDrawingsRoute:
    def test_returns_every_drawing_with_its_strokes(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Regression test for the client builder's real-browser finding: this route
        500'd on EVERY call (`response_model=None` was missing, so FastAPI tried to
        infer a Pydantic model from `-> JsonObject` and raised `PydanticUserError`)."""
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-get-1")
            created = client.post(
                "/api/admin/server/drawings",
                json=_create_body(anchor_seq=seq, client_id="draw-get-1"),
                headers=headers,
            )
            drawing_id = created.json()["id"]
            client.post(
                f"/api/admin/server/drawings/{drawing_id}/strokes",
                json={
                    "strokeId": "stroke-get-second",
                    "color": DRAWING_COLORS[1],
                    "width": DRAWING_WIDTHS[1],
                    "points": [[5, 6], [7, 8]],
                },
                headers=headers,
            )
            response = client.get(f"/api/admin/server/messages/{seq}/drawings", headers=headers)
            assert response.status_code == 200, response.text
            body = response.json()
            assert len(body["drawings"]) == 1
            drawing = body["drawings"][0]
            assert drawing["id"] == drawing_id
            assert drawing["rev"] == 2
            assert drawing["sender"] == "Josh"
            assert drawing["columnWidth"] == 390.0
            assert [s["strokeId"] for s in drawing["strokes"]] == [
                "stroke-route-aaaa",
                "stroke-get-second",
            ]
            assert drawing["strokes"][0]["points"] == [[1, 2], [3, 4]]
        finally:
            client.__exit__(None, None, None)

    def test_a_message_with_no_drawings_returns_an_empty_list(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-get-empty")
            response = client.get(f"/api/admin/server/messages/{seq}/drawings", headers=headers)
            assert response.status_code == 200
            assert response.json() == {"drawings": []}
        finally:
            client.__exit__(None, None, None)


def _live_body(
    *,
    drawing_client_id: str = "draw-client-live-aaaa",
    anchor_seq: int,
    column_width: float = 390.0,
    stroke_id: str = "stroke-live-aaaa",
    batch: int = 0,
    color: str = DRAWING_COLORS[0],
    width: int = DRAWING_WIDTHS[0],
    points: list[list[int]] | None = None,
    cancel: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "drawingClientId": drawing_client_id,
        "anchorSeq": anchor_seq,
        "columnWidth": column_width,
        "strokeId": stroke_id,
        "batch": batch,
        "color": color,
        "width": width,
        "points": points if points is not None else [[1, 2]],
        "cancel": cancel,
    }
    return body


class TestLiveDrawingRoute:
    def test_a_valid_batch_is_relayed_and_never_persisted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-live-1")
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            broker: DrawingBroker = client.app.state.livechat_drawing_broker  # type: ignore[attr-defined]
            conn_id, queue = broker.register()
            try:
                response = client.post(
                    "/api/admin/server/drawings/live",
                    json=_live_body(anchor_seq=seq),
                    headers=headers,
                )
                assert response.status_code == 200, response.text
                assert response.json() == {"ok": True}
                frames = queue.drain()
                assert len(frames) == 1
                assert frames[0]["anchorSeq"] == seq
                assert frames[0]["points"] == [[1, 2]]
            finally:
                broker.unregister(conn_id)
            # Nothing about the live batch reached the database.
            assert store.get_drawings_for_message(seq=seq) == []
            assert store.events_after(0) == [
                e for e in store.events_after(0) if e.type == "message"
            ]
        finally:
            client.__exit__(None, None, None)

    def test_cancel_true_skips_stroke_validation(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-live-cancel")
            response = client.post(
                "/api/admin/server/drawings/live",
                json=_live_body(
                    anchor_seq=seq, cancel=True, color="not-a-real-colour", width=999, points=[]
                ),
                headers=headers,
            )
            assert response.status_code == 200, response.text
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("columnWidth", 199.0),
            ("color", "#not-a-colour"),
            ("width", 999),
        ],
    )
    def test_field_validation_is_422_when_not_cancelling(
        self,
        field: str,
        value: object,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-live-validation")
            body = _live_body(anchor_seq=seq)
            body[field] = value
            response = client.post("/api/admin/server/drawings/live", json=body, headers=headers)
            assert response.status_code == 422, response.text
        finally:
            client.__exit__(None, None, None)

    def test_too_many_points_in_one_batch_is_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-live-too-many-points")
            response = client.post(
                "/api/admin/server/drawings/live",
                json=_live_body(anchor_seq=seq, points=[[1, 2]] * 201),
                headers=headers,
            )
            assert response.status_code == 422, response.text
        finally:
            client.__exit__(None, None, None)

    def test_rate_limit_returns_429_with_retry_after(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-live-rate-limit")
            client.app.state.livechat_drawing_live_limiter = SlidingWindowRateLimiter(  # type: ignore[attr-defined]
                max_events=2, window_s=60.0
            )
            body = _live_body(anchor_seq=seq, drawing_client_id="draw-client-rate-limited")
            first = client.post("/api/admin/server/drawings/live", json=body, headers=headers)
            second = client.post("/api/admin/server/drawings/live", json=body, headers=headers)
            third = client.post("/api/admin/server/drawings/live", json=body, headers=headers)
            assert first.status_code == second.status_code == 200
            assert third.status_code == 429
            assert third.json()["error"] == "rate_limited"
            assert int(third.headers["Retry-After"]) >= 1
        finally:
            client.__exit__(None, None, None)

    def test_rate_limit_is_keyed_per_drawing_client_id(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """spec §4: 30 batches/second is a per-drawer budget — a second drawer on the
        same anchor must not be throttled by the first one's usage."""
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            seq = _send_anchor(client, headers, client_id="client-live-per-key")
            client.app.state.livechat_drawing_live_limiter = SlidingWindowRateLimiter(  # type: ignore[attr-defined]
                max_events=1, window_s=60.0
            )
            first_drawer = client.post(
                "/api/admin/server/drawings/live",
                json=_live_body(anchor_seq=seq, drawing_client_id="draw-client-a"),
                headers=headers,
            )
            second_drawer = client.post(
                "/api/admin/server/drawings/live",
                json=_live_body(anchor_seq=seq, drawing_client_id="draw-client-b"),
                headers=headers,
            )
            assert first_drawer.status_code == 200
            assert second_drawer.status_code == 200
        finally:
            client.__exit__(None, None, None)


_FIXED_AUTH = ServerAuth(email="", exp=int(time.time()) + 3600)
_SECRET = b"x" * 32


async def _next_frame(generator: Any, *, timeout_s: float = 2.0) -> dict[str, Any]:
    with anyio.fail_after(timeout_s):
        raw = await generator.__anext__()
    frame: dict[str, Any] = {"id": None, "event": None, "data": None}
    for line in raw.rstrip("\n").split("\n"):
        if line.startswith("id: "):
            frame["id"] = int(line[len("id: ") :])
        elif line.startswith("event: "):
            frame["event"] = line[len("event: ") :]
        elif line.startswith("data: "):
            frame["data"] = json.loads(line[len("data: ") :])
    return frame


class TestStreamDrawingLiveFrame:
    """spec §4: live frames ride the SSE stream as id-less `drawing_live` events —
    never advancing the replay cursor — interleaved with the ordinary persisted
    events on the SAME connection."""

    @pytest.mark.asyncio
    async def test_a_pushed_frame_is_emitted_with_no_id_line(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        notifier = LiveChatNotifier()
        queue = LiveDrawingQueue()
        queue.push({"drawingClientId": "draw-x", "anchorSeq": 1, "batch": 0, "points": [[1, 2]]})
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0, live_queue=queue)
        try:
            frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert frame["event"] == "drawing_live"
        assert frame["id"] is None
        assert frame["data"]["anchorSeq"] == 1

    @pytest.mark.asyncio
    async def test_a_live_frame_never_disturbs_the_persisted_event_cursor(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="one",
            attachment_ids=(),
            now=1000.0,
        )
        notifier = LiveChatNotifier()
        queue = LiveDrawingQueue()
        queue.push({"drawingClientId": "draw-x", "anchorSeq": 1, "batch": 0, "points": [[1, 2]]})
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0, live_queue=queue)
        try:
            live_frame = await _next_frame(gen)
            persisted_frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert live_frame["event"] == "drawing_live"
        assert live_frame["id"] is None
        assert persisted_frame["event"] == "message"
        assert persisted_frame["id"] == 1

    @pytest.mark.asyncio
    async def test_two_registered_connections_each_get_their_own_frames(
        self, tmp_path: Path
    ) -> None:
        """Per-connection isolation: `DrawingBroker.publish` fans out to every
        registered queue, but each connection drains only its OWN queue — one
        connection's drain never empties another's."""
        broker = DrawingBroker()
        _id_a, queue_a = broker.register()
        _id_b, queue_b = broker.register()
        broker.publish({"drawingClientId": "draw-x", "anchorSeq": 1, "batch": 0, "points": []})
        frames_a = queue_a.drain()
        assert len(frames_a) == 1
        # queue_b still holds its own copy — draining `a` didn't touch it.
        frames_b = queue_b.drain()
        assert len(frames_b) == 1
        assert queue_a.drain() == []
        assert queue_b.drain() == []

    def test_the_queue_drops_the_oldest_frame_past_capacity(self) -> None:
        queue = LiveDrawingQueue()
        from wixy_server.livechat.drawing_broker import QUEUE_MAX_FRAMES

        for i in range(QUEUE_MAX_FRAMES + 5):
            queue.push({"batch": i})
        frames = queue.drain()
        assert len(frames) == QUEUE_MAX_FRAMES
        assert frames[0]["batch"] == 5  # the first 5 were dropped, oldest first
        assert frames[-1]["batch"] == QUEUE_MAX_FRAMES + 4

    def test_unregistering_stops_further_delivery(self) -> None:
        broker = DrawingBroker()
        conn_id, queue = broker.register()
        broker.unregister(conn_id)
        broker.publish({"batch": 0})
        assert queue.drain() == []
        assert broker.connection_count == 0
