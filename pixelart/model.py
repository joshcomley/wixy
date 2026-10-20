"""The .pxl data model, parser and serialiser (FORMAT.md is normative)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

RGB = tuple[int, int, int]
MODES = ("loop", "once", "pingpong")
NAME_RE = re.compile(r"^[a-z0-9-]+(\.model)?$")
ROLE_RE = re.compile(r"^[a-z0-9-]+$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_INLINE_COMMENT_RE = re.compile(r"\s#\s.*$")
_OVERRIDE_RE = re.compile(r"^\s*(\d+)\|(.*)$")
MAX_MODEL_DEPTH = 8


class PxlError(Exception):
    """A .pxl parse/validation error, carrying the 1-based line number."""

    def __init__(self, message: str, line: int | None = None, path: str | None = None) -> None:
        self.message = message
        self.line = line
        self.path = path
        where = path or "<pxl>"
        if line is not None:
            where = f"{where}:{line}"
        super().__init__(f"{where}: {message}")


@dataclass
class PaletteEntry:
    key: str
    rgb: RGB | None  # None = transparent
    role: str | None = None
    inherited: bool = False


@dataclass
class Palette:
    entries: dict[str, PaletteEntry] = field(default_factory=dict)
    ramps: dict[str, list[str]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if "." not in self.entries:
            self.entries = {".": PaletteEntry(".", None), **self.entries}

    def rgba(self, key: str) -> tuple[int, int, int, int]:
        e = self.entries[key]
        if e.rgb is None:
            return (0, 0, 0, 0)
        return (e.rgb[0], e.rgb[1], e.rgb[2], 255)

    def role_of(self, key: str) -> str | None:
        e = self.entries.get(key)
        return e.role if e else None

    def keys_with_role(self, prefix: str) -> list[str]:
        """Keys whose role is `prefix` or starts with `prefix-`."""
        return [
            k
            for k, e in self.entries.items()
            if e.role is not None and (e.role == prefix or e.role.startswith(prefix + "-"))
        ]

    def opaque_keys(self) -> list[str]:
        return [k for k, e in self.entries.items() if e.rgb is not None]


@dataclass(frozen=True)
class Anchor:
    name: str
    x: int
    y: int


@dataclass
class Frame:
    name: str
    ms: int = 100
    like: str | None = None
    shift: tuple[int, int] = (0, 0)
    rows: list[str] | None = None  # full grid for non-derived frames
    overrides: dict[int, str] = field(default_factory=dict)
    anchors: dict[str, Anchor] = field(default_factory=dict)  # explicit, per-frame
    line: int = 0


@dataclass
class Anim:
    name: str
    frames: list[str]
    mode: str = "loop"
    line: int = 0


@dataclass
class Requirements:
    anchors: list[str] = field(default_factory=list)
    height: tuple[int, int] | None = None
    width: tuple[int, int] | None = None

    def is_empty(self) -> bool:
        return not self.anchors and self.height is None and self.width is None


@dataclass
class Model:
    name: str
    path: str
    w: int
    h: int
    palette: Palette
    requires: Requirements


@dataclass
class Sprite:
    name: str
    w: int
    h: int
    palette: Palette
    frames: dict[str, Frame] = field(default_factory=dict)
    anims: dict[str, Anim] = field(default_factory=dict)
    anchors: dict[str, Anchor] = field(default_factory=dict)  # defaults
    tags: list[str] = field(default_factory=list)
    maxcolors: int | None = None
    uses: str | None = None
    model: Model | None = None
    palette_extend: bool = False
    requires: Requirements = field(default_factory=Requirements)
    path: str | None = None

    @classmethod
    def blank(cls, name: str, w: int, h: int, palette: Palette | None = None) -> Sprite:
        sp = cls(name=name, w=w, h=h, palette=palette or Palette())
        sp.frames["main"] = Frame("main", rows=["." * w for _ in range(h)])
        return sp

    def requirements(self) -> list[tuple[str, Requirements]]:
        """Every requirement set that applies, tagged with where it came from."""
        out: list[tuple[str, Requirements]] = []
        if self.model is not None and not self.model.requires.is_empty():
            out.append((self.model.name, self.model.requires))
        if not self.requires.is_empty():
            out.append((self.name, self.requires))
        return out


# ---------------------------------------------------------------------------
# parsing


def _hex_to_rgb(v: str) -> RGB:
    return (int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16))


def _parse_range(tok: str, line: int, path: str | None) -> tuple[int, int]:
    m = re.fullmatch(r"(\d+)\.\.(\d+)", tok)
    if not m:
        raise PxlError(f"expected a range like 26..28, got {tok!r}", line, path)
    lo, hi = int(m.group(1)), int(m.group(2))
    if lo > hi:
        raise PxlError(f"range {tok} has low > high", line, path)
    return (lo, hi)


def _parse_xy(tok: str, what: str, line: int, path: str | None) -> tuple[int, int]:
    m = re.fullmatch(r"(-?\d+),(-?\d+)", tok)
    if not m:
        raise PxlError(f"{what} must be written x,y (got {tok!r})", line, path)
    return (int(m.group(1)), int(m.group(2)))


def _parse_palette_entry(
    line: str, lineno: int, path: str | None
) -> tuple[str, RGB | None, str | None]:
    toks = line.split()
    if len(toks) < 2 or len(toks) > 3:
        raise PxlError("palette entry must be 'key #rrggbb [role]'", lineno, path)
    key, val = toks[0], toks[1]
    if len(key) != 1 or key == "|" or not (33 <= ord(key) <= 126):
        raise PxlError(
            f"invalid palette key {key!r} (one printable ASCII char, not '|')", lineno, path
        )
    role: str | None = None
    if len(toks) == 3:
        role = toks[2]
        if not ROLE_RE.match(role):
            raise PxlError(f"invalid role name {role!r} (use [a-z0-9-]+)", lineno, path)
    if val == "transparent":
        if key != ".":
            raise PxlError("only '.' may be transparent", lineno, path)
        return key, None, role
    if not HEX_RE.match(val):
        raise PxlError(f"invalid colour {val!r} (use #rrggbb or transparent)", lineno, path)
    if key == ".":
        raise PxlError("'.' is always transparent", lineno, path)
    return key, _hex_to_rgb(val), role


def _load_model(rel: str, base: str | None, chain: tuple[str, ...], line: int) -> Model:
    if base is None:
        raise PxlError("'uses model=' needs the sprite's file path to locate the model", line)
    mpath = (Path(base).parent / rel).resolve()
    if str(mpath) in chain:
        raise PxlError(f"model cycle through {rel}", line, base)
    if len(chain) >= MAX_MODEL_DEPTH:
        raise PxlError("models nested too deeply", line, base)
    try:
        text = mpath.read_text(encoding="utf-8")
    except OSError as e:
        raise PxlError(f"cannot read model {rel}: {e.strerror or e}", line, base) from e
    msp = _parse(text, str(mpath), (*chain, str(mpath)))
    reqs = Requirements(
        anchors=list(msp.requires.anchors), height=msp.requires.height, width=msp.requires.width
    )
    if msp.model is not None:  # a model that itself uses a model carries its requirements
        for a in msp.model.requires.anchors:
            if a not in reqs.anchors:
                reqs.anchors.append(a)
        reqs.height = reqs.height or msp.model.requires.height
        reqs.width = reqs.width or msp.model.requires.width
    return Model(msp.name, str(mpath), msp.w, msp.h, msp.palette, reqs)


def parse(text: str, path: str | None = None) -> Sprite:
    """Parse .pxl text. `path` locates `uses model=` files and labels errors."""
    resolved = str(Path(path).resolve()) if path else None
    return _parse(text, path, (resolved,) if resolved else ())


def _parse_palette_block(
    lines: list[str],
    start: int,
    palette: Palette,
    model: Model | None,
    extend: bool,
    own_ramps: set[str],
    header_line: int,
    path: str | None,
) -> int:
    """Parse palette lines after the header; returns the index after 'end'."""
    n = len(lines)
    i = start
    while i < n:
        pln = i + 1
        ps = lines[i].strip()
        i += 1
        if not ps:
            continue
        if ps == "end":
            for rname, keys in palette.ramps.items():
                for k in keys:
                    if k not in palette.entries or palette.entries[k].rgb is None:
                        raise PxlError(
                            f"ramp {rname!r} uses undefined/transparent key {k!r}", pln, path
                        )
            return i
        ptoks = ps.split()
        is_hash_key = (
            ptoks[0] == "#"
            and len(ptoks) >= 2
            and (HEX_RE.match(ptoks[1]) is not None or ptoks[1] == "transparent")
        )
        if ps.startswith("#") and not is_hash_key:
            continue
        ps = _INLINE_COMMENT_RE.sub("", ps)
        if ps.split()[0] == "ramp":
            m = re.fullmatch(r"ramp\s+([a-z0-9-]+)\s*=\s*(.+)", ps)
            if not m:
                raise PxlError("ramp must be 'ramp <name> = k1 k2 ...'", pln, path)
            rname = m.group(1)
            if rname in own_ramps or rname in palette.ramps:
                raise PxlError(f"duplicate ramp {rname!r}", pln, path)
            palette.ramps[rname] = m.group(2).split()
            own_ramps.add(rname)
            continue
        key, rgb, role = _parse_palette_entry(ps, pln, path)
        if key == ".":
            if role:
                palette.entries["."] = PaletteEntry(".", None, role)
            continue
        if key in palette.entries:
            old = palette.entries[key]
            if old.inherited:
                if old.rgb != rgb:
                    what = "redefines the model's colour" if extend else "differs from the model"
                    raise PxlError(f"key {key!r} {what}", pln, path)
                continue
            raise PxlError(f"duplicate palette key {key!r}", pln, path)
        if model is not None and not extend:
            raise PxlError(
                f"key {key!r} is not in the model palette; use 'palette extend'", pln, path
            )
        palette.entries[key] = PaletteEntry(key, rgb, role)
    raise PxlError("palette block is missing 'end'", header_line, path)


def _parse(text: str, path: str | None, chain: tuple[str, ...]) -> Sprite:
    lines = text.lstrip("﻿").splitlines()
    n = len(lines)
    i = 0

    def err(msg: str, ln: int) -> PxlError:
        return PxlError(msg, ln, path)

    name: str | None = None
    size: tuple[int, int] | None = None
    palette = Palette()
    seen_pxl = False
    palette_seen = False
    current: Frame | None = None
    maxcolors: int | None = None
    uses: str | None = None
    model: Model | None = None
    extend = False
    tags: list[str] = []
    requires = Requirements()
    default_anchors: dict[str, Anchor] = {}
    frames: dict[str, Frame] = {}
    anims: dict[str, Anim] = {}
    own_ramps: set[str] = set()

    def need_size(ln: int) -> tuple[int, int]:
        if size is None:
            raise err("'size WxH' must come before palette and frames", ln)
        return size

    def check_row(row: str, ln: int) -> None:
        w, _ = need_size(ln)
        if len(row) != w:
            raise err(f"row has {len(row)} keys, expected {w}", ln)
        for ch in row:
            if ch not in palette.entries:
                raise err(f"unknown palette key {ch!r}", ln)

    while i < n:
        raw = lines[i]
        ln = i + 1
        i += 1
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m_ov = _OVERRIDE_RE.match(raw)
        if m_ov and current is not None:
            if current.like is None:
                raise err("override rows are only valid in a frame with like=", ln)
            idx = int(m_ov.group(1))
            body = m_ov.group(2)
            if body.startswith(" "):
                body = body[1:]
            body = body.strip()
            _, h = need_size(ln)
            if idx >= h:
                raise err(f"override row {idx} out of range 0..{h - 1}", ln)
            check_row(body, ln)
            if idx in current.overrides:
                raise err(f"row {idx} overridden twice in frame {current.name}", ln)
            current.overrides[idx] = body
            continue
        line_nc = _INLINE_COMMENT_RE.sub("", stripped)
        toks = line_nc.split()
        if not seen_pxl:
            if toks != ["pxl", "1"]:
                raise err("first directive must be 'pxl 1'", ln)
            seen_pxl = True
            continue
        d = toks[0]
        if d == "pxl":
            raise err("duplicate 'pxl' directive", ln)
        elif d == "name":
            if len(toks) != 2 or not NAME_RE.match(toks[1]):
                raise err("name must be one token matching [a-z0-9-]+", ln)
            name = toks[1]
        elif d == "size":
            m = re.fullmatch(r"(\d+)x(\d+)", toks[1]) if len(toks) == 2 else None
            if not m:
                raise err("size must be written WxH", ln)
            sw, sh = int(m.group(1)), int(m.group(2))
            if not (1 <= sw <= 256 and 1 <= sh <= 256):
                raise err("size dimensions must each be 1..256", ln)
            if frames or palette_seen:
                raise err("'size' must come before palette and frames", ln)
            size = (sw, sh)
        elif d == "maxcolors":
            if len(toks) != 2 or not toks[1].isdigit() or int(toks[1]) < 1:
                raise err("maxcolors needs a positive integer", ln)
            maxcolors = int(toks[1])
        elif d == "uses":
            if len(toks) != 2 or not toks[1].startswith("model=") or len(toks[1]) <= 6:
                raise err("expected 'uses model=<file>'", ln)
            if palette_seen:
                raise err("'uses' must come before the palette block", ln)
            uses = toks[1][6:]
            try:
                model = _load_model(uses, path, chain, ln)
            except PxlError as e:
                if e.line is not None and e.path != path:
                    raise err(f"in model {uses}: {e.message} (line {e.line})", ln) from e
                raise
            for k, e2 in model.palette.entries.items():
                if k != ".":
                    palette.entries[k] = PaletteEntry(k, e2.rgb, e2.role, inherited=True)
            palette.ramps = {rn: list(r) for rn, r in model.palette.ramps.items()}
        elif d == "tag":
            if len(toks) != 2:
                raise err("tag takes exactly one word", ln)
            tags.append(toks[1])
        elif d == "palette":
            need_size(ln)
            if palette_seen:
                raise err("duplicate palette block", ln)
            if len(toks) == 2 and toks[1] == "extend":
                if model is None:
                    raise err("'palette extend' requires 'uses model='", ln)
                extend = True
            elif len(toks) != 1:
                raise err("expected 'palette' or 'palette extend'", ln)
            palette_seen = True
            i = _parse_palette_block(lines, i, palette, model, extend, own_ramps, ln, path)
        elif d == "end":
            raise err("'end' without a palette block", ln)
        elif d == "anchor":
            if len(toks) != 3 or not ROLE_RE.match(toks[1]):
                raise err("anchor must be 'anchor <name> x,y'", ln)
            w, h = need_size(ln)
            x, y = _parse_xy(toks[2], "anchor position", ln, path)
            if not (0 <= x < w and 0 <= y < h):
                raise err(f"anchor {toks[1]} at {x},{y} is outside the {w}x{h} canvas", ln)
            a = Anchor(toks[1], x, y)
            if current is not None:
                current.anchors[a.name] = a
            else:
                if frames:
                    raise err("default anchors must come before the first frame", ln)
                default_anchors[a.name] = a
        elif d == "frame":
            w, h = need_size(ln)
            if len(toks) < 2:
                raise err("frame needs a name", ln)
            fname = toks[1]
            if not ROLE_RE.match(fname):
                raise err(f"invalid frame name {fname!r} (use [a-z0-9-]+)", ln)
            if fname in frames:
                raise err(f"duplicate frame {fname!r}", ln)
            fr = Frame(fname, line=ln)
            seen_opts: set[str] = set()
            for opt in toks[2:]:
                if "=" not in opt:
                    raise err(f"unknown frame option {opt!r}", ln)
                k, v = opt.split("=", 1)
                if k in seen_opts:
                    raise err(f"duplicate frame option {k!r}", ln)
                seen_opts.add(k)
                if k == "ms":
                    if not v.isdigit() or not (10 <= int(v) <= 10000):
                        raise err("ms must be an integer 10..10000", ln)
                    fr.ms = int(v)
                elif k == "like":
                    if v not in frames:
                        raise err(f"like={v} must name an earlier frame", ln)
                    fr.like = v
                elif k == "shift":
                    fr.shift = _parse_xy(v, "shift", ln, path)
                else:
                    raise err(f"unknown frame option {k!r}", ln)
            if "shift" in seen_opts and fr.like is None:
                raise err("shift= requires like=", ln)
            frames[fname] = fr
            current = fr
            if fr.like is None:
                rows: list[str] = []
                while len(rows) < h:
                    if i >= n:
                        raise err(f"frame {fname} has {len(rows)} rows, expected {h}", ln)
                    rline = lines[i].strip()
                    rln = i + 1
                    i += 1
                    if not rline:
                        continue
                    check_row(rline, rln)
                    rows.append(rline)
                fr.rows = rows
        elif d == "anim":
            m = re.fullmatch(r"anim\s+([a-z0-9-]+)\s*=\s*(.+)", line_nc)
            if not m:
                raise err("anim must be 'anim <name> = f1 f2 ... [loop|once|pingpong]'", ln)
            aname, seq = m.group(1), m.group(2).split()
            mode = "loop"
            if seq[-1] in MODES:
                mode = seq.pop()
            if not seq:
                raise err("anim needs at least one frame", ln)
            if aname in anims:
                raise err(f"duplicate anim {aname!r}", ln)
            for f in seq:
                if f not in frames:
                    raise err(f"anim {aname} references missing frame {f!r}", ln)
            anims[aname] = Anim(aname, seq, mode, ln)
            current = None
        elif d == "require":
            usage = "require needs 'anchors ...', 'height lo..hi' or 'width lo..hi'"
            if len(toks) < 3:
                raise err(usage, ln)
            if toks[1] == "anchors":
                for an in toks[2:]:
                    if not ROLE_RE.match(an):
                        raise err(f"invalid anchor name {an!r}", ln)
                    if an not in requires.anchors:
                        requires.anchors.append(an)
            elif toks[1] in ("height", "width") and len(toks) == 3:
                rng = _parse_range(toks[2], ln, path)
                if toks[1] == "height":
                    requires.height = rng
                else:
                    requires.width = rng
            else:
                raise err(usage, ln)
        else:
            raise err(f"unknown directive {d!r}", ln)

    if not seen_pxl:
        raise PxlError("empty file: missing 'pxl 1'", 1, path)
    if name is None:
        raise PxlError("missing required 'name'", None, path)
    if size is None:
        raise PxlError("missing required 'size'", None, path)
    return Sprite(
        name=name,
        w=size[0],
        h=size[1],
        palette=palette,
        frames=frames,
        anims=anims,
        anchors=default_anchors,
        tags=tags,
        maxcolors=maxcolors,
        uses=uses,
        model=model,
        palette_extend=extend,
        requires=requires,
        path=path,
    )


# ---------------------------------------------------------------------------
# resolution


def resolve_frames(sprite: Sprite) -> dict[str, list[str]]:
    """Full H-row grid for every frame (like=/shift=/overrides applied)."""
    out: dict[str, list[str]] = {}
    w, h = sprite.w, sprite.h
    for name, fr in sprite.frames.items():
        if fr.like is None:
            assert fr.rows is not None
            out[name] = list(fr.rows)
            continue
        base = out[fr.like]
        dx, dy = fr.shift
        grid = [["."] * w for _ in range(h)]
        for y in range(h):
            ny = y + dy
            if not 0 <= ny < h:
                continue
            row = base[y]
            for x in range(w):
                nx = x + dx
                if 0 <= nx < w:
                    grid[ny][nx] = row[x]
        rows = ["".join(r) for r in grid]
        for idx, body in fr.overrides.items():
            rows[idx] = body
        out[name] = rows
    return out


def resolve_anchors(sprite: Sprite) -> dict[str, dict[str, Anchor]]:
    """Effective anchors per frame: defaults, overlaid by the frame's own.

    A derived frame inherits its parent's per-frame anchors (moved by its
    shift=); its own anchors then override them.
    """
    explicit: dict[str, dict[str, Anchor]] = {}
    out: dict[str, dict[str, Anchor]] = {}
    for name, fr in sprite.frames.items():
        ex: dict[str, Anchor] = {}
        if fr.like is not None:
            dx, dy = fr.shift
            for a in explicit[fr.like].values():
                ex[a.name] = Anchor(a.name, a.x + dx, a.y + dy)
        ex.update(fr.anchors)
        explicit[name] = ex
        out[name] = {**sprite.anchors, **ex}
    return out


def anim_sequence(anim: Anim) -> list[str]:
    """Frame names in playback order (pingpong expanded without repeating the ends)."""
    seq = list(anim.frames)
    if anim.mode == "pingpong" and len(seq) > 2:
        seq = seq + seq[-2:0:-1]
    return seq


# ---------------------------------------------------------------------------
# serialisation


def dump(sprite: Sprite) -> str:
    """Serialise to .pxl text with every frame written out in full."""
    grids = resolve_frames(sprite)
    anchors = resolve_anchors(sprite)
    out: list[str] = ["pxl 1", f"name {sprite.name}", f"size {sprite.w}x{sprite.h}"]
    if sprite.maxcolors is not None:
        out.append(f"maxcolors {sprite.maxcolors}")
    if sprite.uses is not None:
        out.append(f"uses model={sprite.uses}")
    for t in sprite.tags:
        out.append(f"tag {t}")
    if sprite.requires.anchors:
        out.append("require anchors " + " ".join(sprite.requires.anchors))
    if sprite.requires.height:
        out.append("require height {}..{}".format(*sprite.requires.height))
    if sprite.requires.width:
        out.append("require width {}..{}".format(*sprite.requires.width))
    own = [e for e in sprite.palette.entries.values() if e.key != "." and not e.inherited]
    own_ramps = {
        k: v
        for k, v in sprite.palette.ramps.items()
        if sprite.model is None or k not in sprite.model.palette.ramps
    }
    if sprite.model is None or own or own_ramps:
        out.append("palette extend" if sprite.model is not None else "palette")
        out.append("  .  transparent")
        for e in own:
            assert e.rgb is not None
            role = f"  {e.role}" if e.role else ""
            r, g, b = e.rgb
            out.append(f"  {e.key}  #{r:02x}{g:02x}{b:02x}{role}")
        for rn, keys in own_ramps.items():
            out.append(f"  ramp {rn} = {' '.join(keys)}")
        out.append("end")
    for a in sprite.anchors.values():
        out.append(f"anchor {a.name} {a.x},{a.y}")
    for fname, fr in sprite.frames.items():
        out.append(f"frame {fname} ms={fr.ms}")
        out.extend(grids[fname])
        for a in anchors[fname].values():
            if sprite.anchors.get(a.name) != a:
                out.append(f"anchor {a.name} {a.x},{a.y}")
    for an in sprite.anims.values():
        out.append(f"anim {an.name} = {' '.join(an.frames)} {an.mode}")
    return "\n".join(out) + "\n"
