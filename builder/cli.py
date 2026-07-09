"""CLI: `python -m builder build|validate|serve` (spec/09-work-plan.md milestone 2)."""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import sys
from pathlib import Path

from builder.build import build_site
from builder.config import load_project_config
from builder.render import SiteSource, load_site_source
from builder.tests.parity.runner import (
    DEFAULT_MOBILE_SLUGS,
    default_baseline_dir,
    rebaseline,
    run_parity_check,
    serve_directory,
)
from builder.theme import load_theme
from builder.validate import validate_site


def _load_source(root: Path, project_path: Path) -> SiteSource:
    project = load_project_config(project_path)
    theme_path = root / "theme" / "theme.json"
    theme = load_theme(theme_path) if theme_path.exists() else None
    return load_site_source(root, project, theme)


def cmd_validate(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    source = _load_source(root, Path(args.project).resolve())
    result = validate_site(source, root)
    if args.json:
        print(json.dumps(result.to_json_dict(), indent=2))
    else:
        for err in result.errors:
            loc = f"{err.file}:{err.key}" if err.key else (err.file or "")
            print(f"[{err.code}] {loc}: {err.message}")
        print("validate: OK" if result.ok else f"validate: {len(result.errors)} error(s)")
    return 0 if result.ok else 1


def cmd_build(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    source = _load_source(root, Path(args.project).resolve())
    out_dir = Path(args.out).resolve()
    build_site(root, source, out_dir)
    print(f"build: wrote {out_dir}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    source = _load_source(root, Path(args.project).resolve())
    out_dir = Path(args.out).resolve()
    build_site(root, source, out_dir)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(out_dir))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"serve: http://127.0.0.1:{args.port}/  (built from {root})")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


def cmd_parity(args: argparse.Namespace) -> int:
    serve_root = Path(args.serve_root).resolve()
    slugs = [s.strip() for s in args.slugs.split(",") if s.strip()]
    baseline_root = Path(args.baseline).resolve() if args.baseline else default_baseline_dir()
    mobile_slugs = (
        tuple(s.strip() for s in args.mobile_slugs.split(",") if s.strip())
        if args.mobile_slugs is not None
        else DEFAULT_MOBILE_SLUGS
    )

    with serve_directory(serve_root) as base_url:
        if args.rebaseline:
            rebaseline(base_url, slugs, baseline_root, mobile_screenshot_slugs=mobile_slugs)
            print(f"parity: rebaselined {len(slugs)} page(s) at {baseline_root}")
            return 0
        issues = run_parity_check(
            base_url,
            slugs,
            baseline_root,
            mobile_screenshot_slugs=mobile_slugs,
            strict_screenshots=args.strict_screenshots,
        )

    hard = [i for i in issues if not i.advisory]
    advisory = [i for i in issues if i.advisory]
    for issue in hard:
        print(f"[FAIL] {issue.page}/{issue.kind}: {issue.detail}")
    for issue in advisory:
        print(f"[advisory] {issue.page}/{issue.kind}: {issue.detail}")
    if hard:
        print(f"parity: {len(hard)} failure(s), {len(advisory)} advisory")
        return 1
    print(f"parity: OK ({len(advisory)} advisory)")
    return 0


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", default=".", help="site repo checkout root (default: cwd)")
    parser.add_argument("--project", required=True, help="path to the project registry JSON")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m builder")
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate", help="validate the site tree (02 §10)")
    _add_common_args(p_validate)
    p_validate.add_argument("--json", action="store_true", help="machine-readable output")
    p_validate.set_defaults(func=cmd_validate)

    p_build = sub.add_parser("build", help="build the site to an output directory")
    _add_common_args(p_build)
    p_build.add_argument("--out", default="_build", help="output directory (default: _build)")
    p_build.set_defaults(func=cmd_build)

    p_serve = sub.add_parser("serve", help="build once and serve over HTTP (dev only)")
    _add_common_args(p_serve)
    p_serve.add_argument("--out", default="_build")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.set_defaults(func=cmd_serve)

    p_parity = sub.add_parser(
        "parity", help="rendered-parity check against the committed baseline (03 §5)"
    )
    p_parity.add_argument(
        "--serve-root",
        required=True,
        help="static directory to serve+probe (a builder "
        "build output, or the raw pre-migration site for the one-time baseline capture)",
    )
    p_parity.add_argument("--slugs", required=True, help="comma-separated page slugs to probe")
    p_parity.add_argument(
        "--mobile-slugs",
        default=None,
        help="comma-separated slugs to also screenshot at "
        "mobile width (default: index,treatments per 03 §5)",
    )
    p_parity.add_argument(
        "--baseline", default=None, help="baseline dir (default: builder/tests/parity/baseline)"
    )
    p_parity.add_argument(
        "--rebaseline", action="store_true", help="capture and overwrite the baseline"
    )
    p_parity.add_argument(
        "--strict-screenshots",
        action="store_true",
        help="treat screenshot pixel-diffs as hard failures (the pinned CI platform only, 03 §5)",
    )
    p_parity.set_defaults(func=cmd_parity)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
