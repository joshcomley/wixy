"""Downscale photos/* to <=1280px JPEGs in photos/ai-downscaled/.

Keeps large source images out of AI context and produces lightweight,
version-controllable style references. Safe to re-run (overwrites outputs).
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "photos")
OUT = os.path.join(SRC, "ai-downscaled")
os.makedirs(OUT, exist_ok=True)
MAXDIM = 1280
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".heic"}

files = sorted(f for f in os.listdir(SRC)
               if os.path.splitext(f)[1].lower() in EXTS and os.path.isfile(os.path.join(SRC, f)))
for f in files:
    p = os.path.join(SRC, f)
    try:
        im = Image.open(p)
        w, h = im.size
        scale = min(1.0, MAXDIM / max(w, h))
        nw, nh = int(w * scale), int(h * scale)
        im2 = im.convert("RGB")
        if scale < 1.0:
            im2 = im2.resize((nw, nh), Image.LANCZOS)
        out = os.path.join(OUT, os.path.splitext(f)[0] + ".jpg")
        im2.save(out, "JPEG", quality=82)
        print(f"{f}: {w}x{h} -> {nw}x{nh}")
    except Exception as e:
        print(f"{f}: ERROR {e}")
print("DONE ->", OUT)
