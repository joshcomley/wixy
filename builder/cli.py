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
from builder.theme import load_theme
from builder.validate import validate_site


def _load_source(root: Path, project_path: Path) -> SiteSource:
    project = load_project_config(project_path)
    theme = load_theme(root / "theme" / "theme.json")
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

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    result: int = args.func(args)
    return result


if __name__ == "__main__":
    sys.exit(main())
