"""Pure unit tests for `livechat.tokens` (spec/server-chat/00-brief.md §5.1/§5.6):
unlock-token mint/verify (tamper, expiry, email binding) and signed media URLs.
HTTP-level `require_server_token` behavior (through a real app, with a real CF
Access JWT) lives in `test_routes_livechat.py` instead — this file never
constructs a fake `Request`."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from wixy_server.livechat.tokens import (
    InvalidTokenError,
    MediaSigner,
    load_or_create_secret,
    mint_unlock_token,
    sign_media_url,
    verify_media_signature,
    verify_unlock_token,
)


class TestLoadOrCreateSecret:
    def test_creates_a_32_byte_secret(self, tmp_path: Path) -> None:
        secret = load_or_create_secret(tmp_path / "server" / "secret.key")
        assert len(secret) == 32

    def test_reuses_an_existing_secret(self, tmp_path: Path) -> None:
        path = tmp_path / "server" / "secret.key"
        first = load_or_create_secret(path)
        second = load_or_create_secret(path)
        assert first == second

    def test_concurrent_creators_agree_on_one_secret(self, tmp_path: Path) -> None:
        """§4: "created O_EXCL (race-safe across slot processes)" — simulates two
        blue/green processes racing the first-ever unlock at (near-)the same time."""
        path = tmp_path / "server" / "secret.key"
        results: list[bytes] = []
        lock = threading.Lock()

        def _load() -> None:
            secret = load_or_create_secret(path)
            with lock:
                results.append(secret)

        threads = [threading.Thread(target=_load) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(results) == 8
        assert len(set(results)) == 1


class TestUnlockToken:
    def test_mint_then_verify_round_trip(self) -> None:
        secret = b"x" * 32
        token, expires_at = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        auth = verify_unlock_token(secret, token, email="josh@example.com", now=1000.5)
        assert auth.email == "josh@example.com"
        assert auth.exp == int(expires_at)

    def test_wrong_secret_is_rejected(self) -> None:
        token, _exp = mint_unlock_token(b"x" * 32, email="josh@example.com", now=1000.0)
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(b"y" * 32, token, email="josh@example.com", now=1000.5)

    def test_tampered_payload_is_rejected(self) -> None:
        secret = b"x" * 32
        token, _exp = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        payload_b64, signature_b64 = token.split(".", 1)
        # Flip the first character of the payload — hmac.compare_digest must
        # reject this, not just "the JSON happens to still parse."
        tampered_char = "A" if payload_b64[0] != "A" else "B"
        tampered = tampered_char + payload_b64[1:] + "." + signature_b64
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(secret, tampered, email="josh@example.com", now=1000.5)

    def test_garbage_token_is_rejected(self) -> None:
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(b"x" * 32, "not-a-real-token", email="josh@example.com", now=1000.0)

    def test_missing_separator_is_rejected(self) -> None:
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(b"x" * 32, "nosignaturehere", email="josh@example.com", now=1000.0)

    def test_expired_token_is_rejected(self) -> None:
        secret = b"x" * 32
        token, expires_at = mint_unlock_token(
            secret, email="josh@example.com", now=1000.0, ttl_s=10.0
        )
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(secret, token, email="josh@example.com", now=expires_at + 1.0)

    def test_exactly_at_expiry_is_rejected(self) -> None:
        """§5.1's `exp` is exclusive: `verify_unlock_token`'s own contract is
        "require exp > now" — a check at exactly `exp` must fail, not pass."""
        secret = b"x" * 32
        token, expires_at = mint_unlock_token(
            secret, email="josh@example.com", now=1000.0, ttl_s=10.0
        )
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(secret, token, email="josh@example.com", now=expires_at)

    def test_wrong_email_is_rejected(self) -> None:
        secret = b"x" * 32
        token, _exp = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(secret, token, email="someone-else@example.com", now=1000.5)

    def test_ttl_defaults_to_twelve_hours(self) -> None:
        secret = b"x" * 32
        _token, expires_at = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        assert expires_at == 1000.0 + 12 * 60 * 60

    def test_two_mints_produce_different_tokens(self) -> None:
        """The `n` nonce (§5.1 token format) means two tokens minted for the same
        email at the same instant are still distinct strings."""
        secret = b"x" * 32
        token1, _ = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        token2, _ = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        assert token1 != token2

    def test_an_unbound_mint_verifies_with_no_grant_id(self) -> None:
        secret = b"x" * 32
        token, _exp = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        auth = verify_unlock_token(secret, token, email="josh@example.com", now=1000.5)
        assert auth.grant_id is None

    def test_a_bound_mint_round_trips_the_grant_id(self) -> None:
        """§9 (audit F4): a token minted for a device grant carries its id, so
        `require_server_token` can re-check the grant is still live on every request."""
        secret = b"x" * 32
        grant_id = "a" * 32
        token, _exp = mint_unlock_token(
            secret, email="josh@example.com", now=1000.0, grant_id=grant_id
        )
        auth = verify_unlock_token(secret, token, email="josh@example.com", now=1000.5)
        assert auth.grant_id == grant_id

    @pytest.mark.parametrize(
        "bad_g", ["not-hex-at-all-000000000000000", "A" * 32, "a" * 31, "a" * 33, ""]
    )
    def test_a_malformed_g_is_rejected(self, bad_g: str) -> None:
        """A hand-crafted token cannot smuggle a malformed grant id past the format check —
        `require_server_token` must never hand a route a `ServerAuth.grant_id` that isn't
        exactly the shape `is_device_grant_live`'s store lookup expects."""
        import json

        from wixy_server.livechat.tokens import _b64url_decode, _b64url_encode

        secret = b"x" * 32
        token, _exp = mint_unlock_token(secret, email="josh@example.com", now=1000.0)
        payload_b64, signature_b64 = token.split(".", 1)
        payload = json.loads(_b64url_decode(payload_b64))
        payload["g"] = bad_g
        tampered_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
        # Re-sign with the same secret — this proves the REJECTION is the `g`-shape check
        # itself, not just a signature mismatch from tampering.
        import hashlib
        import hmac

        tampered_sig = hmac.new(
            secret, b"unlock|" + tampered_b64.encode("ascii"), hashlib.sha256
        ).digest()
        tampered_token = f"{tampered_b64}.{_b64url_encode(tampered_sig)}"
        with pytest.raises(InvalidTokenError):
            verify_unlock_token(secret, tampered_token, email="josh@example.com", now=1000.5)


class TestMediaSignature:
    def test_valid_signature_verifies(self) -> None:
        secret = b"x" * 32
        sig = sign_media_url(
            secret, attachment_id="att-1", rendition="full", exp=2000, email="josh@example.com"
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
            )
            is True
        )

    def test_expired_signature_is_rejected(self) -> None:
        secret = b"x" * 32
        sig = sign_media_url(
            secret, attachment_id="att-1", rendition="full", exp=2000, email="josh@example.com"
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=2001.0,
            )
            is False
        )

    def test_wrong_email_is_rejected(self) -> None:
        secret = b"x" * 32
        sig = sign_media_url(
            secret, attachment_id="att-1", rendition="full", exp=2000, email="josh@example.com"
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="someone-else@example.com",
                signature=sig,
                now=1000.0,
            )
            is False
        )

    def test_wrong_rendition_is_rejected(self) -> None:
        """A signature minted for `full` must not verify for `thumb` — otherwise
        one signed URL would unlock every rendition of an attachment."""
        secret = b"x" * 32
        sig = sign_media_url(
            secret, attachment_id="att-1", rendition="full", exp=2000, email="josh@example.com"
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="thumb",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
            )
            is False
        )

    def test_tampered_signature_is_rejected(self) -> None:
        secret = b"x" * 32
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature="not-a-real-signature",
                now=1000.0,
            )
            is False
        )

    def test_a_bound_signature_round_trips_the_grant_id(self) -> None:
        """§9 (audit F4): the grant id is part of the signed message, so `GET /media` can
        re-check the grant's liveness for a URL minted from a bound session."""
        secret = b"x" * 32
        grant_id = "a" * 32
        sig = sign_media_url(
            secret,
            attachment_id="att-1",
            rendition="full",
            exp=2000,
            email="josh@example.com",
            grant_id=grant_id,
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
                grant_id=grant_id,
            )
            is True
        )

    def test_a_caller_cannot_add_g_to_an_unbound_url(self) -> None:
        """The signature is over `email|exp` WITHOUT `g` for an unbound mint — appending
        `&g=` at the URL layer must not verify, since it changes the signed message."""
        secret = b"x" * 32
        sig = sign_media_url(
            secret, attachment_id="att-1", rendition="full", exp=2000, email="josh@example.com"
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
                grant_id="a" * 32,
            )
            is False
        )

    def test_a_caller_cannot_strip_g_from_a_bound_url(self) -> None:
        secret = b"x" * 32
        sig = sign_media_url(
            secret,
            attachment_id="att-1",
            rendition="full",
            exp=2000,
            email="josh@example.com",
            grant_id="a" * 32,
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
                grant_id=None,
            )
            is False
        )

    def test_a_caller_cannot_swap_one_grant_id_for_another(self) -> None:
        secret = b"x" * 32
        sig = sign_media_url(
            secret,
            attachment_id="att-1",
            rendition="full",
            exp=2000,
            email="josh@example.com",
            grant_id="a" * 32,
        )
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="full",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
                grant_id="b" * 32,
            )
            is False
        )


class TestMediaSigner:
    def test_url_for_includes_attachment_id_rendition_exp_and_a_verifying_sig(self) -> None:
        secret = b"x" * 32
        signer = MediaSigner(secret=secret, email="josh@example.com", exp=2000)
        url = signer.url_for("att-1", "thumb")
        assert url.startswith("/api/admin/server/media/att-1/thumb?exp=2000&sig=")
        assert "&g=" not in url
        sig = url.rsplit("sig=", 1)[1]
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="thumb",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
            )
            is True
        )

    def test_url_for_a_bound_signer_appends_g_and_verifies_bound(self) -> None:
        secret = b"x" * 32
        grant_id = "c" * 32
        signer = MediaSigner(secret=secret, email="josh@example.com", exp=2000, grant_id=grant_id)
        url = signer.url_for("att-1", "thumb")
        assert f"&g={grant_id}" in url
        sig = url.split("sig=", 1)[1].split("&", 1)[0]
        assert (
            verify_media_signature(
                secret,
                attachment_id="att-1",
                rendition="thumb",
                exp=2000,
                email="josh@example.com",
                signature=sig,
                now=1000.0,
                grant_id=grant_id,
            )
            is True
        )

    def test_for_auth_binds_secret_email_exp_and_grant_id_from_a_server_auth(self) -> None:
        from wixy_server.livechat.tokens import ServerAuth

        secret = b"x" * 32
        auth = ServerAuth(email="josh@example.com", exp=2000, grant_id="d" * 32)
        signer = MediaSigner.for_auth(secret, auth)
        assert signer.email == "josh@example.com"
        assert signer.exp == 2000
        assert signer.grant_id == "d" * 32
