"""Provision ca.cinnamons.uk on Cloudflare — DNS + tunnel ingress + a PATH-SCOPED
Access app (spec/07-hosting-deploy.md §3).

Adapted from `D:\\Servers\\Tenna\\Storage\\provision_cf.py` (itself a faithful replica of
Biosphere's `engine/infra.py:provision_subdomain()`, the sanctioned path used for every
existing `*.cinnamons.uk` site) — same DNS/ingress/restart shape, same backup-then-
sanity-check-then-write discipline for the tunnel config. The one deliberate divergence
(spec/07 §3 point 4): the template scopes an Access app to the WHOLE hostname; this
script must NOT — `ca.cinnamons.uk` serves a PUBLIC site at `/`, so the Access app covers
only `/admin` and `/api/admin`, via `self_hosted_domains` (a list) rather than the
template's single `domain` string, with two policies (an operator email-OTP allow list,
mirrored from an existing app rather than hardcoded, plus a `non_identity` service-token
policy for automated probes, also mirrored) instead of the template's one.

Idempotent: DNS/Access "already exists" is success; ingress upserts the port. Run
elevated (admin gate) so it can read/write the LocalSystem cloudflared config and
restart the Cloudflared service — see the global CLAUDE.md's admin-gate mechanics.

Usage:
    python tooling/provision_ca_cloudflare.py            # full run: dns, ingress,
                                                           # restart, access
    python tooling/provision_ca_cloudflare.py --restart-only
        # spec/07 §3 point 3: the Cloudflared stop can report "starting or stopping —
        # try again" — submit the full run and this flag as TWO separate gate scripts
        # and expect to run this one once or twice if the full run's restart step
        # reports that transient failure.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

SUBDOMAIN = "ca"
LOCAL_PORT = 9380
DOMAIN = "cinnamons.uk"
HOSTNAME = f"{SUBDOMAIN}.{DOMAIN}"
ADMIN_PATH_DOMAINS = [f"{HOSTNAME}/admin", f"{HOSTNAME}/api/admin"]
ACCESS_APP_NAME = "Wixy Admin (ca)"
SESSION_DURATION = "720h"

# A currently-provisioned app whose policies we mirror (spec/07 §3: "copy the
# allow-list emails from the existing apps' policy... the provision template shows the
# pattern") — looked up dynamically at run time rather than hardcoding email addresses
# or a service-token id that would go stale the moment either changes.
REFERENCE_APP_HOSTNAME = "tenna.cinnamons.uk"

ENV_FILE = Path(r"D:\Servers\Wixy\Storage\.env")
CLOUDFLARED_CONFIG = Path(r"C:\Windows\System32\config\systemprofile\.cloudflared\config.yml")
CF_API = "https://api.cloudflare.com/client/v4"

RESTART_RETRY_ATTEMPTS = 3
RESTART_RETRY_DELAY_S = 5.0


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def dns_cname(cfg: dict[str, str], client: httpx.Client) -> dict:
    target = f"{cfg['CF_TUNNEL_ID']}.cfargotunnel.com"
    r = client.post(
        f"{CF_API}/zones/{cfg['CF_ZONE_ID']}/dns_records",
        headers={
            "Authorization": f"Bearer {cfg['CF_API_TOKEN']}",
            "Content-Type": "application/json",
        },
        json={"type": "CNAME", "name": HOSTNAME, "content": target, "ttl": 1, "proxied": True},
    )
    data = r.json()
    if data.get("success"):
        return {"ok": True, "id": data["result"]["id"], "target": target}
    errs = data.get("errors", [])
    if any("already" in str(e).lower() and "exist" in str(e).lower() for e in errs):
        return {"ok": True, "existing": True, "target": target}
    return {"ok": False, "errors": errs}


def add_ingress() -> dict:
    content = CLOUDFLARED_CONFIG.read_text(encoding="utf-8")
    lines = content.splitlines()
    service_line = f"http://localhost:{LOCAL_PORT}"
    marker = f"- hostname: {HOSTNAME}"

    prior_hostnames = [ln.strip() for ln in lines if ln.strip().startswith("- hostname:")]
    had_catchall = any("http_status:404" in ln for ln in lines)
    if not had_catchall:
        return {"ok": False, "error": "catch-all rule not found; refusing to edit"}

    # Backup first.
    ts = time.strftime("%Y%m%d-%H%M%S")
    backup = CLOUDFLARED_CONFIG.with_name(f"config.yml.bak.{ts}.pre-ca")
    backup.write_text(content, encoding="utf-8")

    updated = False
    inserted = False
    for i, line in enumerate(lines):
        if line.strip() == marker:
            for j in range(i + 1, len(lines)):
                if not lines[j].strip():
                    continue
                if not lines[j].lstrip().startswith("service:"):
                    return {"ok": False, "error": f"{HOSTNAME} has no service line"}
                indent = lines[j][: len(lines[j]) - len(lines[j].lstrip())]
                new_line = f"{indent}service: {service_line}"
                if lines[j] != new_line:
                    lines[j] = new_line
                    updated = True
                break
            break
    else:
        insert_idx = next(i for i, ln in enumerate(lines) if "http_status:404" in ln)
        lines[insert_idx:insert_idx] = [f"  - hostname: {HOSTNAME}", f"    service: {service_line}"]
        inserted = True

    # Sanity check the new content BEFORE writing/restarting — every prior hostname
    # (incl. every OTHER fleet subdomain sharing this tunnel) must still be present,
    # plus the catch-all, plus exactly the one new hostname.
    new_hostnames = [ln.strip() for ln in lines if ln.strip().startswith("- hostname:")]
    still_catchall = any("http_status:404" in ln for ln in lines)
    expected = set(prior_hostnames) | {marker}
    if not still_catchall or set(new_hostnames) != expected:
        return {
            "ok": False,
            "error": "sanity check failed; not writing",
            "prior": prior_hostnames,
            "new": new_hostnames,
            "catchall": still_catchall,
        }

    CLOUDFLARED_CONFIG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "inserted": inserted,
        "updated": updated,
        "backup": str(backup),
        "hostnames_after": len(new_hostnames),
    }


def restart_cloudflared() -> dict:
    """Retries the stop/start pair (spec/07 §3 point 3: a stop can report "starting or
    stopping — try again" — precedent from provisioning other fleet subdomains onto
    this same shared tunnel)."""
    last_error: str | None = None
    for attempt in range(1, RESTART_RETRY_ATTEMPTS + 1):
        subprocess.run(["net", "stop", "Cloudflared"], capture_output=True, text=True)
        r = subprocess.run(["net", "start", "Cloudflared"], capture_output=True, text=True)
        if r.returncode == 0:
            return {"ok": True, "attempt": attempt}
        last_error = (r.stderr or r.stdout)[:300]
        if attempt < RESTART_RETRY_ATTEMPTS:
            time.sleep(RESTART_RETRY_DELAY_S)
    return {"ok": False, "error": last_error, "attempts": RESTART_RETRY_ATTEMPTS}


def _find_reference_app(cfg: dict[str, str], client: httpx.Client) -> dict | None:
    hdrs = {"Authorization": f"Bearer {cfg['CF_ACCESS_TOKEN']}"}
    acct = cfg["CF_ACCOUNT_ID"]
    r = client.get(f"{CF_API}/accounts/{acct}/access/apps", headers=hdrs, params={"per_page": 50})
    data = r.json()
    if not data.get("success"):
        return None
    for app in data.get("result", []):
        domains = app.get("self_hosted_domains") or ([app["domain"]] if app.get("domain") else [])
        if any(REFERENCE_APP_HOSTNAME in d for d in domains):
            return app
    return None


def _mirror_reference_policies(
    cfg: dict[str, str], client: httpx.Client, reference_app_id: str
) -> tuple[list[dict], dict]:
    """Returns `(policies_to_create, debug_info)` — an email-allow policy and a
    non_identity service-token policy, each copied verbatim from the reference app's
    own policies rather than reconstructed from a hardcoded email/token id (spec/07 §3:
    "copy the allow-list emails from the existing apps' policy")."""
    hdrs = {"Authorization": f"Bearer {cfg['CF_ACCESS_TOKEN']}"}
    acct = cfg["CF_ACCOUNT_ID"]
    r = client.get(
        f"{CF_API}/accounts/{acct}/access/apps/{reference_app_id}/policies", headers=hdrs
    )
    data = r.json()
    if not data.get("success"):
        return [], {"error": data.get("errors")}

    policies: list[dict] = []
    debug: dict = {"reference_policies_seen": []}
    for pol in data.get("result", []):
        debug["reference_policies_seen"].append(pol.get("name"))
        if pol.get("decision") == "non_identity":
            policies.append(
                {
                    "name": "Service token access",
                    "decision": "non_identity",
                    "include": pol.get("include", []),
                }
            )
        elif pol.get("decision") == "allow" and any(
            "email" in inc for inc in pol.get("include", [])
        ):
            policies.append(
                {
                    "name": "Authorized users",
                    "decision": "allow",
                    "include": pol.get("include", []),
                }
            )
    return policies, debug


def team_domain(cfg: dict[str, str], client: httpx.Client) -> str | None:
    hdrs = {"Authorization": f"Bearer {cfg['CF_ACCESS_TOKEN']}"}
    acct = cfg["CF_ACCOUNT_ID"]
    r = client.get(f"{CF_API}/accounts/{acct}/access/organizations", headers=hdrs)
    data = r.json()
    if not data.get("success"):
        return None
    auth_domain = data.get("result", {}).get("auth_domain")
    return auth_domain if isinstance(auth_domain, str) else None


def access_app(cfg: dict[str, str], client: httpx.Client) -> dict:
    hdrs = {
        "Authorization": f"Bearer {cfg['CF_ACCESS_TOKEN']}",
        "Content-Type": "application/json",
    }
    acct = cfg["CF_ACCOUNT_ID"]

    reference = _find_reference_app(cfg, client)
    if reference is None:
        return {
            "ok": False,
            "error": f"reference app for {REFERENCE_APP_HOSTNAME!r} not found — cannot "
            "safely mirror its allow-list/service-token policies",
        }
    policies, policy_debug = _mirror_reference_policies(cfg, client, reference["id"])
    if not policies:
        return {
            "ok": False,
            "error": "no mirrorable policies found on reference app",
            **policy_debug,
        }

    # self_hosted_domains (a LIST), NOT the template's single `domain` string — the
    # critical divergence (spec/07 §3 point 4): no app may cover `/`, so the public
    # site loads with zero auth.
    r = client.post(
        f"{CF_API}/accounts/{acct}/access/apps",
        headers=hdrs,
        json={
            "name": ACCESS_APP_NAME,
            "type": "self_hosted",
            "self_hosted_domains": ADMIN_PATH_DOMAINS,
            "session_duration": SESSION_DURATION,
        },
    )
    data = r.json()
    if not data.get("success"):
        errs = data.get("errors", [])
        if any("already" in str(e).lower() and "exist" in str(e).lower() for e in errs):
            return {"ok": True, "existing": True}
        return {"ok": False, "errors": errs}

    app_id = data["result"]["id"]
    aud = data["result"].get("aud")

    policy_results = []
    for pol in policies:
        pr = client.post(
            f"{CF_API}/accounts/{acct}/access/apps/{app_id}/policies", headers=hdrs, json=pol
        )
        policy_results.append({"name": pol["name"], "ok": pr.json().get("success")})

    return {"ok": True, "app_id": app_id, "aud": aud, "policies": policy_results}


def _write_back_env(aud: str, domain: str) -> None:
    """Appends/updates WIXY_CF_ACCESS_AUD + WIXY_CF_TEAM_DOMAIN in Storage\\.env — the
    JWT middleware (spec/04 §9) reads these two."""
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    seen = {"WIXY_CF_ACCESS_AUD": False, "WIXY_CF_TEAM_DOMAIN": False}
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key == "WIXY_CF_ACCESS_AUD":
            lines[i] = f"WIXY_CF_ACCESS_AUD={aud}"
            seen[key] = True
        elif key == "WIXY_CF_TEAM_DOMAIN":
            lines[i] = f"WIXY_CF_TEAM_DOMAIN={domain}"
            seen[key] = True
    if not seen["WIXY_CF_ACCESS_AUD"]:
        lines.append(f"WIXY_CF_ACCESS_AUD={aud}")
    if not seen["WIXY_CF_TEAM_DOMAIN"]:
        lines.append(f"WIXY_CF_TEAM_DOMAIN={domain}")
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--restart-only",
        action="store_true",
        help="only retry the Cloudflared restart (spec/07 §3 point 3's two-gate-script split)",
    )
    args = parser.parse_args()

    cfg = load_env()
    missing = [
        k
        for k in ("CF_API_TOKEN", "CF_ACCESS_TOKEN", "CF_ZONE_ID", "CF_ACCOUNT_ID", "CF_TUNNEL_ID")
        if not cfg.get(k)
    ]
    if missing:
        print(json.dumps({"ok": False, "error": f"missing CF vars in {ENV_FILE}: {missing}"}))
        return 1

    if args.restart_only:
        result = restart_cloudflared()
        print("PROVISION_RESULT " + json.dumps({"restart": result, "overall_ok": result["ok"]}))
        return 0 if result["ok"] else 2

    results: dict = {"hostname": HOSTNAME, "port": LOCAL_PORT, "admin_domains": ADMIN_PATH_DOMAINS}
    with httpx.Client(timeout=30) as client:
        results["dns"] = dns_cname(cfg, client)
        results["ingress"] = add_ingress()
        if results["ingress"].get("ok"):
            results["restart"] = restart_cloudflared()
        else:
            results["restart"] = {"ok": False, "skipped": "ingress failed"}
        results["access"] = access_app(cfg, client)
        if results["access"].get("ok") and results["access"].get("aud"):
            domain = team_domain(cfg, client)
            if domain is not None:
                _write_back_env(results["access"]["aud"], domain)
                results["env_written"] = {"aud": results["access"]["aud"], "team_domain": domain}
            else:
                results["env_written"] = {"ok": False, "error": "could not resolve team domain"}

    ok = all(results[k].get("ok") for k in ("dns", "ingress", "restart", "access") if k in results)
    results["overall_ok"] = ok
    print("PROVISION_RESULT " + json.dumps(results))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
