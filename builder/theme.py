"""Theme loading + `theme.css` / Google Fonts URL generation (spec/02-content-model.md §4).

The loader is structurally strict (wrong shapes raise `BuildError`) but lexically lenient
about which color keys / font roles exist — knowing the exact v1 vocabulary (colors must
be hex, fonts must have serif/sans/script) is `validate.py`'s job, so a hand-edited
theme.json with an extra token or a typo'd role still *builds*, it just fails validate.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from builder.content import load_json_object
from builder.errors import BuildError
from builder.jsontypes import JsonObject

_GENERIC_FONT_FALLBACK: dict[str, str] = {
    "serif": "serif",
    "sans": "system-ui,sans-serif",
    "script": "cursive",
}


@dataclass(frozen=True, slots=True)
class FontSpec:
    family: str
    weights: list[str]
    italics: bool


@dataclass(frozen=True, slots=True)
class Theme:
    colors: dict[str, str]
    shadow: str
    fonts: dict[str, FontSpec]


def load_theme(path: Path) -> Theme:
    data = load_json_object(path)
    return theme_from_dict(data, location=str(path))


def theme_from_dict(data: JsonObject, *, location: str = "<theme>") -> Theme:
    """Parse an already-loaded theme dict (spec/02 §4).

    Split out from `load_theme` so the server's merged-content service (spec/04
    §3-4, once the draft overlay lands) can apply overlay ops to a theme dict and
    re-parse it without a round trip through a file — `theme_to_dict` is its
    inverse.
    """
    colors_raw = data.get("colors", {})
    if not isinstance(colors_raw, dict):
        raise BuildError("theme.json 'colors' must be an object", location=location)
    colors: dict[str, str] = {}
    for key, val in colors_raw.items():
        if not isinstance(val, str):
            raise BuildError(f"theme.json colors.{key} must be a string", location=location)
        colors[key] = val

    shadow = data.get("shadow", "")
    if not isinstance(shadow, str):
        raise BuildError("theme.json 'shadow' must be a string", location=location)

    fonts_raw = data.get("fonts", {})
    if not isinstance(fonts_raw, dict):
        raise BuildError("theme.json 'fonts' must be an object", location=location)
    fonts: dict[str, FontSpec] = {}
    for role, spec_raw in fonts_raw.items():
        if not isinstance(spec_raw, dict):
            raise BuildError(f"theme.json fonts.{role} must be an object", location=location)
        family = spec_raw.get("family")
        weights_raw = spec_raw.get("weights", [])
        italics = spec_raw.get("italics", False)
        if (
            not isinstance(family, str)
            or not isinstance(weights_raw, list)
            or not isinstance(italics, bool)
        ):
            raise BuildError(f"theme.json fonts.{role} has an invalid shape", location=location)
        weights = [w for w in weights_raw if isinstance(w, str)]
        fonts[role] = FontSpec(family=family, weights=weights, italics=italics)

    return Theme(colors=colors, shadow=shadow, fonts=fonts)


def theme_to_dict(theme: Theme) -> JsonObject:
    """The inverse of `theme_from_dict` — round-trips through `theme.json`'s own shape."""
    return {
        "colors": dict(theme.colors),
        "shadow": theme.shadow,
        "fonts": {
            role: {
                "family": spec.family,
                "weights": list(spec.weights),
                "italics": spec.italics,
            }
            for role, spec in theme.fonts.items()
        },
    }


def generate_theme_css(theme: Theme) -> str:
    """Emit `:root{ --<color>:…; --shadow:…; --font-<role>:'Family',fallback; }` (02 §4)."""
    lines = [":root{"]
    for key, value in theme.colors.items():
        lines.append(f"  --{key}:{value};")
    lines.append(f"  --shadow:{theme.shadow};")
    for role, spec in theme.fonts.items():
        fallback = _GENERIC_FONT_FALLBACK.get(role, "")
        quoted = f"'{spec.family}'"
        value = f"{quoted},{fallback}" if fallback else quoted
        lines.append(f"  --font-{role}:{value};")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _weight_sort_key(weight: str) -> int:
    return int(weight) if weight.isdigit() else 0


def _font_css2_param(spec: FontSpec) -> str:
    name = spec.family.replace(" ", "+")
    weights = sorted(dict.fromkeys(spec.weights), key=_weight_sort_key)
    if not weights:
        return f"family={name}"
    if spec.italics:
        pairs = [f"0,{w}" for w in weights] + [f"1,{w}" for w in weights]
        axis = "ital,wght@" + ";".join(pairs)
    else:
        axis = "wght@" + ";".join(weights)
    return f"family={name}:{axis}"


def generate_fonts_url(theme: Theme) -> str:
    """A single combined Google Fonts `css2?family=…` URL (02 §4).

    Not required to byte-match any prior hand-written URL — only that it renders the
    right families/weights/italics; the parity harness gates rendering, not this string.
    """
    params = [_font_css2_param(spec) for spec in theme.fonts.values()]
    return "https://fonts.googleapis.com/css2?" + "&".join(params) + "&display=swap"
