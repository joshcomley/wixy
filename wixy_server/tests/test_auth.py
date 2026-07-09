from __future__ import annotations

import json
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from wixy_server.auth import (
    AccessVerificationError,
    JwksCache,
    is_admin_path,
    jwks_url,
    verify_access_jwt,
)

_TEAM_DOMAIN = "example.cloudflareaccess.com"
_AUDIENCE = "test-aud-123"
_KID = "test-key-1"


@pytest.fixture(scope="module")
def keypair() -> tuple[Any, Any]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


def _jwk_dict(public_key: Any, kid: str) -> dict[str, Any]:
    jwk: dict[str, Any] = json.loads(RSAAlgorithm(RSAAlgorithm.SHA256).to_jwk(public_key))
    jwk["kid"] = kid
    return jwk


def _sign(private_key: Any, *, kid: str = _KID, **claim_overrides: Any) -> str:
    now = int(time.time())
    claims = {
        "aud": _AUDIENCE,
        "iss": f"https://{_TEAM_DOMAIN}",
        "exp": now + 3600,
        "iat": now,
        "sub": "user@example.com",
        **claim_overrides,
    }
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": kid})


class TestIsAdminPath:
    @pytest.mark.parametrize(
        "path",
        ["/admin", "/admin/", "/admin/preview/index.html", "/api/admin", "/api/admin/state"],
    )
    def test_matches_admin_prefixes(self, path: str) -> None:
        assert is_admin_path(path) is True

    @pytest.mark.parametrize(
        "path", ["/", "/about.html", "/api/version", "/healthz", "/internal/ready", "/admin2"]
    )
    def test_does_not_match_other_paths(self, path: str) -> None:
        assert is_admin_path(path) is False


class TestJwksUrl:
    def test_builds_the_cdn_cgi_certs_url(self) -> None:
        assert jwks_url(_TEAM_DOMAIN) == f"https://{_TEAM_DOMAIN}/cdn-cgi/access/certs"


class TestJwksCache:
    def test_fetches_once_and_caches_within_ttl(self, keypair: tuple[Any, Any]) -> None:
        _private, public = keypair
        call_count = 0

        def fetch() -> dict[str, Any]:
            nonlocal call_count
            call_count += 1
            return {"keys": [_jwk_dict(public, _KID)]}

        cache = JwksCache(fetch=fetch, ttl_s=100.0)
        cache.signing_key_for(_KID, now=1000.0)
        cache.signing_key_for(_KID, now=1050.0)  # within TTL — no refetch
        assert call_count == 1

    def test_refetches_after_ttl_elapses(self, keypair: tuple[Any, Any]) -> None:
        _private, public = keypair
        call_count = 0

        def fetch() -> dict[str, Any]:
            nonlocal call_count
            call_count += 1
            return {"keys": [_jwk_dict(public, _KID)]}

        cache = JwksCache(fetch=fetch, ttl_s=100.0)
        cache.signing_key_for(_KID, now=1000.0)
        cache.signing_key_for(_KID, now=1101.0)  # 101s later — past the 100s TTL
        assert call_count == 2

    def test_unknown_kid_raises(self, keypair: tuple[Any, Any]) -> None:
        _private, public = keypair
        cache = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        with pytest.raises(AccessVerificationError, match="no known signing key"):
            cache.signing_key_for("some-other-kid", now=1000.0)


class TestVerifyAccessJwt:
    def test_valid_token_is_accepted_and_claims_returned(self, keypair: tuple[Any, Any]) -> None:
        private, public = keypair
        token = _sign(private)
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        claims = verify_access_jwt(token, jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN)
        assert claims["sub"] == "user@example.com"

    def test_wrong_audience_is_rejected(self, keypair: tuple[Any, Any]) -> None:
        private, public = keypair
        token = _sign(private, aud="someone-elses-aud")
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        with pytest.raises(AccessVerificationError):
            verify_access_jwt(token, jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN)

    def test_wrong_issuer_is_rejected(self, keypair: tuple[Any, Any]) -> None:
        private, public = keypair
        token = _sign(private, iss="https://someone-elses-team.cloudflareaccess.com")
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        with pytest.raises(AccessVerificationError):
            verify_access_jwt(token, jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN)

    def test_expired_token_is_rejected(self, keypair: tuple[Any, Any]) -> None:
        private, public = keypair
        now = int(time.time())
        token = _sign(private, exp=now - 60, iat=now - 3660)
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        with pytest.raises(AccessVerificationError):
            verify_access_jwt(token, jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN)

    def test_token_signed_by_an_unrelated_key_is_rejected(self) -> None:
        """A token whose `kid` matches, but was actually signed by a DIFFERENT private
        key than the one published in the JWKS, must fail signature verification —
        the real attack a JWKS check defends against."""
        real_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        attacker_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = _sign(attacker_private)  # signed by the attacker's key...
        # ...but the JWKS only knows about the real key, under the same kid.
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(real_private.public_key(), _KID)]})
        with pytest.raises(AccessVerificationError):
            verify_access_jwt(token, jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN)

    def test_unknown_kid_is_rejected(self, keypair: tuple[Any, Any]) -> None:
        private, public = keypair
        token = _sign(private, kid="a-kid-not-in-the-jwks")
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        with pytest.raises(AccessVerificationError, match="no known signing key"):
            verify_access_jwt(token, jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN)

    def test_malformed_token_is_rejected(self, keypair: tuple[Any, Any]) -> None:
        _private, public = keypair
        jwks = JwksCache(fetch=lambda: {"keys": [_jwk_dict(public, _KID)]})
        with pytest.raises(AccessVerificationError, match="malformed"):
            verify_access_jwt(
                "not-a-real-jwt", jwks=jwks, audience=_AUDIENCE, team_domain=_TEAM_DOMAIN
            )
