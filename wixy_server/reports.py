"""Diagnostic report bundle (spec/04-server.md §9, decisions/00095).

`POST /api/admin/report` — the owner's "Send a report" button, reached from
the publish drawer's blocked state (before or after trying "Fix it for me")
and from a failed publish. It's the deliberate escape hatch for whatever
this engine's deterministic tools (normalize, the structural write gate,
`draft_repair`) can't fix themselves — a template/binding problem baked into
the checkout, or anything genuinely unexpected — routed to the OPERATOR
(Josh), never shown to the owner.

Gathers the same facts a human would ask for first when picking up a "the
site editor is stuck" report: the current publish-preview validate result,
the raw draft overlay, the last publish job snapshot, the live pointer,
recent ledger history, upstream status, and engine version. Always SAVED to
`Storage/projects/<slug>/reports/<UTC timestamp>.json` regardless of
anything else; email (plain SMTP, optional) is a best-effort convenience
notification on top, never the record of truth — a send failure is logged,
never surfaced to the caller as an error.
"""

from __future__ import annotations

import json
import logging
import smtplib
from dataclasses import dataclass
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

from builder.config import ProjectConfig
from builder.content import atomic_write_json, load_json_object
from builder.jsontypes import JsonObject, JsonValue
from wixy_server.checkout import CheckoutError, commits_ahead
from wixy_server.draft_validate import validate_merged_for_publish
from wixy_server.ledger import read_ledger
from wixy_server.live_pointer import load_live_pointer
from wixy_server.merged_content import merge_overlay
from wixy_server.overlay import load_overlay
from wixy_server.publisher import PublishJob
from wixy_server.routes_version import resolve_engine_sha
from wixy_server.settings import Settings
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths

logger = logging.getLogger(__name__)

_LEDGER_TAIL = 5
_SMTP_TIMEOUT_S = 10


@dataclass(frozen=True, slots=True)
class ReportResult:
    saved: bool
    emailed: bool


def _publish_job_snapshot(job: PublishJob | None) -> JsonValue:
    if job is None:
        return None
    return {
        "id": job.id,
        "stage": job.stage,
        "log": list(job.log),
        "version": job.version,
        "error": job.error,
        "isRunning": job.is_running,
    }


def _settings_summary(settings: Settings) -> JsonObject:
    """Deliberately excludes every secret (`engine_pat`, SMTP credentials,
    CF Access identifiers) and the local filesystem `storage_root` — just
    enough deployment-mode context to be useful without being a secret
    dump a report bundle then has to be handled carefully."""
    return {
        "env": settings.env,
        "edition": settings.edition,
        "aiBackend": settings.ai_backend,
        "slot": settings.slot,
        "containerized": settings.containerized,
    }


def _upstream_summary(paths: ProjectPaths) -> JsonObject:
    pointer = load_live_pointer(paths)
    if pointer is None or not (paths.repo / ".git").exists():
        return {"aheadOfPublished": []}
    try:
        ahead = commits_ahead(paths.repo, pointer.sha)
    except CheckoutError:
        return {"aheadOfPublished": []}
    return {
        "aheadOfPublished": [
            {"sha": c.sha, "subject": c.subject, "author": c.author, "when": c.when} for c in ahead
        ]
    }


def build_report_bundle(
    project: ProjectConfig,
    paths: ProjectPaths,
    wixy_repo_root: Path,
    settings: Settings,
    publish_job: PublishJob | None,
    *,
    context: str,
    note: str | None,
    now: str,
) -> JsonObject:
    overlay_raw: JsonObject = (
        load_json_object(paths.draft_overlay) if paths.draft_overlay.exists() else {}
    )

    validate_summary: JsonObject = {"ok": True, "errors": []}
    if (paths.repo / ".git").exists():
        try:
            source = build_site_source(project, paths.repo)
            overlay = load_overlay(paths.draft_overlay, default_base_sha="")
            merged = merge_overlay(source, overlay)
            result = validate_merged_for_publish(merged, paths)
            validate_summary = {
                "ok": result.ok,
                "errors": [{k: v for k, v in e.to_dict().items()} for e in result.errors],
            }
        except CheckoutError:
            validate_summary = {
                "ok": False,
                "errors": [{"code": "checkout-error", "message": "site checkout is not ready"}],
            }

    live_pointer = load_live_pointer(paths)
    ledger_tail: list[JsonValue] = [
        e.to_dict() for e in reversed(read_ledger(paths)[-_LEDGER_TAIL:])
    ]

    return {
        "timestamp": now,
        "context": context,
        "note": note,
        "project": {"slug": project.slug, "name": project.name},
        "validate": validate_summary,
        "overlay": overlay_raw,
        "publishJob": _publish_job_snapshot(publish_job),
        "live": (
            {"sha": live_pointer.sha, "version": live_pointer.version}
            if live_pointer is not None
            else None
        ),
        "recentPublishes": ledger_tail,
        "upstream": _upstream_summary(paths),
        "engine": {"sha": resolve_engine_sha(wixy_repo_root)},
        "settings": _settings_summary(settings),
    }


def _filename_timestamp(iso_timestamp: str) -> str:
    """`<UTC yyyymmddTHHMMSSZ>` — a filesystem-safe, sortable name distinct
    from the bundle's own ISO `timestamp` field. Falls back to a literal
    "report" prefix (never raises) if `iso_timestamp` is somehow malformed —
    a report must always save successfully even if its own clock-stamping
    is off."""
    try:
        parsed = datetime.fromisoformat(iso_timestamp)
    except ValueError:
        return "report"
    return parsed.strftime("%Y%m%dT%H%M%SZ")


def save_report(bundle: JsonObject, paths: ProjectPaths) -> Path:
    stamp = _filename_timestamp(str(bundle.get("timestamp", "")))
    target = paths.reports_dir / f"{stamp}.json"
    atomic_write_json(target, bundle)
    return target


def _report_email_body(bundle: JsonObject, context: str) -> str:
    return (
        f"A report was sent from the Wixy site editor for '{bundle.get('project', {})}'.\n"
        f"Context: {context}\n"
        f"Note: {bundle.get('note') or '(none)'}\n\n"
        "Full diagnostic bundle:\n"
        f"{json.dumps(bundle, indent=2, sort_keys=True, ensure_ascii=False)}\n"
    )


def send_report_email(settings: Settings, bundle: JsonObject, context: str) -> bool:
    """Best-effort — returns whether it was actually sent. Never raises: a
    send failure is logged and reported as `emailed: false`, which is a
    normal (200) outcome for the caller — the bundle is already saved to
    disk regardless, so a report is never "lost" over an SMTP hiccup."""
    if not settings.report_smtp_host or not settings.report_email_to:
        return False
    slug = bundle.get("project")
    slug_label = slug.get("slug") if isinstance(slug, dict) else "wixy"
    message = EmailMessage()
    message["Subject"] = f"[wixy/{slug_label}] Report from the site editor — {context}"
    message["From"] = settings.report_email_from or settings.report_smtp_user
    message["To"] = settings.report_email_to
    message.set_content(_report_email_body(bundle, context))

    try:
        with smtplib.SMTP(
            settings.report_smtp_host, settings.report_smtp_port, timeout=_SMTP_TIMEOUT_S
        ) as smtp:
            smtp.starttls()
            if settings.report_smtp_user:
                smtp.login(settings.report_smtp_user, settings.report_smtp_password)
            smtp.send_message(message)
        return True
    except OSError as exc:
        logger.warning("report email send failed: %s", exc)
        return False


def submit_report(
    project: ProjectConfig,
    paths: ProjectPaths,
    wixy_repo_root: Path,
    settings: Settings,
    publish_job: PublishJob | None,
    *,
    context: str,
    note: str | None,
    now: str,
) -> ReportResult:
    bundle = build_report_bundle(
        project, paths, wixy_repo_root, settings, publish_job, context=context, note=note, now=now
    )
    save_report(bundle, paths)
    emailed = send_report_email(settings, bundle, context)
    return ReportResult(saved=True, emailed=emailed)
