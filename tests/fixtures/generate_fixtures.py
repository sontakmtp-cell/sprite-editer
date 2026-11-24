#!/usr/bin/env python3
"""
Deterministic synthetic test fixture generator for Sprite Sheet Builder V2.0 (Spec §13).
Zero dependency on user images or AI images.
"""

import io
import json
import os
import struct
import zipfile
import zlib
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
GEN = ROOT / "generated"
GEN.mkdir(parents=True, exist_ok=True)


def save_png(img: Image.Image, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", compress_level=1)


def make_t02_rect():
    # T02: 400x200 solid blue RGBA
    img = Image.new("RGBA", (400, 200), (20, 120, 240, 255))
    save_png(img, GEN / "t02_rect_400x200.png")


def make_t04_bleed_strip():
    # T04: 200x100 strip, left 100x100 pure red, right 100x100 pure lime, touching directly (0 gap)
    img = Image.new("RGBA", (200, 100), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, 99, 99], fill=(255, 0, 0, 255))
    draw.rectangle([100, 0, 199, 99], fill=(0, 255, 0, 255))
    save_png(img, GEN / "t04_bleed_strip_200x100.png")


def make_t05_alpha_levels():
    # T05: 90x60 with 3 bands: x=0..29 alpha=0, x=30..59 alpha=128, x=60..89 alpha=255
    img = Image.new("RGBA", (90, 60), (0, 0, 0, 0))
    px = img.load()
    for y in range(60):
        for x in range(30, 60):
            px[x, y] = (200, 100, 50, 128)
        for x in range(60, 90):
            px[x, y] = (40, 220, 180, 255)
    save_png(img, GEN / "t05_alpha_levels_90x60.png")


def make_t11_slice_atlas():
    # T11: 2x2 atlas with margin=4 all sides, gapX=4, gapY=2, cell=50x40, plus remainder 5px on right & bottom
    # Total width = 4 + 50 + 4 + 50 + 4 + 5 = 117; height = 4 + 40 + 2 + 40 + 4 + 5 = 95
    # Cell (0,0)=red, (0,1)=green, (1,0)=completely transparent alpha=0, (1,1)=blue
    img = Image.new("RGBA", (117, 95), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle([4, 4, 53, 43], fill=(255, 20, 20, 255))        # (0,0)
    draw.rectangle([58, 4, 107, 43], fill=(20, 255, 20, 255))      # (0,1)
    # (1,0) at (4,46..53,85) stays alpha=0
    draw.rectangle([58, 46, 107, 85], fill=(20, 20, 255, 255))     # (1,1)
    save_png(img, GEN / "t11_slice_atlas_117x95.png")


def make_t12_t13_characters():
    # Char A: 200x200 with character bbox x=60..139 (w=80), y=40..159 (h=120), plus low-alpha (a=4) pixel at (5,5)
    img_a = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    draw_a = ImageDraw.Draw(img_a)
    draw_a.rectangle([60, 40, 139, 159], fill=(240, 80, 60, 255))
    img_a.putpixel((5, 5), (255, 255, 255, 4))  # Low alpha pixel (< threshold 8)
    save_png(img_a, GEN / "t12_char_a.png")

    # Char B: 200x200 with smaller character bbox x=70..129 (w=60), y=100..159 (h=60) -> half height of A
    img_b = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    draw_b = ImageDraw.Draw(img_b)
    draw_b.rectangle([70, 100, 129, 159], fill=(60, 200, 240, 255))
    save_png(img_b, GEN / "t12_char_b.png")

    # Char Tiny: 200x200 with 10x10 pixel content (sync scale to A requires >400% zoom!)
    img_t = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    draw_t = ImageDraw.Draw(img_t)
    draw_t.rectangle([95, 95, 104, 104], fill=(250, 220, 40, 255))
    save_png(img_t, GEN / "t13_char_tiny.png")

    # Completely transparent 64x64
    img_empty = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    save_png(img_empty, GEN / "t12_all_transparent.png")


def make_t26_exif_jpeg():
    # Real JPEG 100x200 raw (top 100x100 red, bottom 100x100 blue) with EXIF Orientation 6 (90° CW)
    # When rotated 90° CW -> displayed as 200x100 with left 100x100 blue, right 100x100 red!
    img = Image.new("RGB", (100, 200), (0, 0, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, 99, 99], fill=(255, 0, 0))
    exif = img.getexif()
    exif[0x0112] = 6  # Rotate 90 CW
    out = GEN / "t26_exif_rot6.jpg"
    img.save(out, format="JPEG", quality=95, exif=exif.tobytes())


def make_t06_invalid_files():
    bad_dir = GEN / "bad_files"
    bad_dir.mkdir(parents=True, exist_ok=True)

    # 1. Corrupt PNG
    (bad_dir / "corrupt.png").write_bytes(b"\x89PNG\r\n\x1a\nCORRUPT_DATA_BYTES")

    # 2. Fake PNG (actually SVG)
    (bad_dir / "fake_svg.png").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', encoding="utf-8")

    # 3. APNG (inject valid acTL chunk before IDAT)
    base = Image.new("RGBA", (16, 16), (255, 0, 0, 255))
    buf = io.BytesIO()
    base.save(buf, format="PNG")
    png_bytes = buf.getvalue()
    # Insert acTL right after IHDR (byte 33)
    actl_data = struct.pack(">II", 2, 0)
    actl_crc = zlib.crc32(b"acTL" + actl_data) & 0xFFFFFFFF
    actl_chunk = struct.pack(">I", 8) + b"acTL" + actl_data + struct.pack(">I", actl_crc)
    (bad_dir / "animated_apng.png").write_bytes(png_bytes[:33] + actl_chunk + png_bytes[33:])

    # 4. Animated WebP using Pillow
    f1 = Image.new("RGBA", (16, 16), (255, 0, 0, 255))
    f2 = Image.new("RGBA", (16, 16), (0, 255, 0, 255))
    f1.save(bad_dir / "animated.webp", format="WEBP", save_all=True, append_images=[f2], duration=100, loop=0)

    # 5. Oversized header PNG (9000x100 declared in IHDR -> exceeds 8192 limit)
    ihdr = struct.pack(">IIBBBBB", 9000, 100, 8, 6, 0, 0, 0)
    ihdr_crc = zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF
    iend_crc = zlib.crc32(b"IEND") & 0xFFFFFFFF
    oversized = (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13) + b"IHDR" + ihdr + struct.pack(">I", ihdr_crc)
        + struct.pack(">I", 0) + b"IEND" + struct.pack(">I", iend_crc)
    )
    (bad_dir / "oversized_9000x100.png").write_bytes(oversized)


def make_t10_batch_natural():
    bdir = GEN / "t10_batch"
    bdir.mkdir(parents=True, exist_ok=True)
    colors = {
        "frame1.png": (255, 0, 0, 255),
        "frame2.png": (0, 255, 0, 255),
        "frame10.png": (0, 0, 255, 255),
    }
    for name, col in colors.items():
        img = Image.new("RGBA", (64, 64), col)
        save_png(img, bdir / name)


def make_hatch_73_fixtures():
    # T07: 73 distinct 192x208 frames encoding unique RGB index (r=i*3, g=255-i*3, b=50+i*2)
    small_dir = GEN / "hatch_73_small"
    small_dir.mkdir(parents=True, exist_ok=True)
    for i in range(1, 74):
        r = (i * 3) % 256
        g = (255 - i * 3) % 256
        b = (50 + i * 2) % 256
        img = Image.new("RGBA", (192, 208), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle([36, 34, 155, 173], fill=(r, g, b, 255))
        save_png(img, small_dir / f"pet_{i:02d}.png")

    # T22 & T28: 73 distinct 1024x1024 RGBA PNGs (>64 Mi px decode cache, <=100 MiB on disk)
    big_dir = GEN / "hatch_73_1024"
    big_dir.mkdir(parents=True, exist_ok=True)
    for i in range(1, 74):
        p = big_dir / f"hd_{i:02d}.png"
        if p.exists():
            continue
        r = (i * 3) % 256
        g = (255 - i * 3) % 256
        b = (40 + i * 2) % 256
        img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle([200, 180, 820, 860], fill=(r, g, b, 255))
        save_png(img, p)


def make_t17_bad_archives():
    adir = GEN / "bad_archives"
    adir.mkdir(parents=True, exist_ok=True)

    # 1. Corrupt non-ZIP
    (adir / "not_a_zip.ssb").write_bytes(b"NOT A VALID SSB ARCHIVE")

    # 2. Missing source file referenced by manifest
    manifest_missing = {
        "format": "sprite-sheet-builder-project",
        "schemaVersion": 2,
        "projectId": "p1",
        "name": "MissingSource",
        "grid": {"cols": 2, "rows": 2, "cellWidth": 64, "cellHeight": 64},
        "presetId": None,
        "sources": [{"id": "s1", "name": "a.png", "path": "sources/s1.png", "mime": "image/png", "width": 64, "height": 64, "byteLength": 100}],
        "assets": [{"id": "a1", "sourceId": "s1", "name": "a", "region": {"x": 0, "y": 0, "w": 64, "h": 64}}],
        "cells": {},
        "animations": [],
        "settings": {"smoothing": True, "guides": {"x": 0.5, "y": 0.9}, "defaultAlphaThreshold": 8, "webpQuality": 0.92},
        "customPresets": []
    }
    with zipfile.ZipFile(adir / "missing_source.ssb", "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest_missing))

    # 3. Unsupported future schemaVersion 99
    manifest_v99 = dict(manifest_missing, schemaVersion=99, sources=[], assets=[])
    with zipfile.ZipFile(adir / "future_v99.ssb", "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest_v99))

    # 4. Path traversal entry
    with zipfile.ZipFile(adir / "path_traversal.ssb", "w") as zf:
        zf.writestr("../evil.txt", "boom")

    # 5. Region out of bounds
    png_small = io.BytesIO()
    Image.new("RGBA", (32, 32), (255, 0, 0, 255)).save(png_small, format="PNG")
    png_bytes = png_small.getvalue()
    manifest_oob = dict(
        manifest_missing,
        sources=[{"id": "s1", "name": "a.png", "path": "sources/s1.png", "mime": "image/png", "width": 32, "height": 32, "byteLength": len(png_bytes)}],
        assets=[{"id": "a1", "sourceId": "s1", "name": "a", "region": {"x": 0, "y": 0, "w": 64, "h": 64}}]
    )
    with zipfile.ZipFile(adir / "region_oob.ssb", "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest_oob))
        zf.writestr("sources/s1.png", png_bytes)


def make_eraser_12frame_fixture():
    # E01 & E05: 12-frame horizontal strip (768x64 = 12 frames of 64x64, 0 margin/gap).
    # Each frame has a distinct body at local x=14..45, y=14..51 (32x38).
    # Frame 1 (col 0) ALSO has an unwanted artifact speck from Frame 2 placed INSIDE Frame 1's crop
    # at local x=54..61, y=24..37 (extends Frame 1 alpha bounds horizontally to x=14..61, w=48).
    img = Image.new("RGBA", (12 * 64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    frame_colors = []
    for i in range(12):
        col = (40 + i * 18, 220 - i * 14, 80 + ((i * 29) % 140), 255)
        frame_colors.append(col)
        ox = i * 64
        draw.rectangle([ox + 14, 14, ox + 45, 51], fill=col)
    # Place Frame 2's color speck inside Frame 1's crop (local x=54..61, y=24..37)
    draw.rectangle([54, 24, 61, 37], fill=frame_colors[1])
    save_png(img, GEN / "e01_strip_12frames_768x64.png")


def main():
    make_t02_rect()
    make_t04_bleed_strip()
    make_t05_alpha_levels()
    make_t11_slice_atlas()
    make_t12_t13_characters()
    make_t26_exif_jpeg()
    make_t06_invalid_files()
    make_t10_batch_natural()
    make_hatch_73_fixtures()
    make_t17_bad_archives()
    make_eraser_12frame_fixture()
    total_hd = sum(p.stat().st_size for p in (GEN / "hatch_73_1024").glob("*.png"))
    print(f"Fixtures generated in {GEN} (73x 1024x1024 total = {total_hd / (1024*1024):.2f} MiB)")


if __name__ == "__main__":
    main()
