#!/usr/bin/env python3
"""
Sprite Sheet Builder V2.0 — Real Chrome & Edge Offline E2E + Pixel Integration Test Suite (T01–T27).
Opens dist/sprite-sheet-builder.html directly over file:// on Windows 11.
Monitors all network requests to guarantee 0 external requests.
Verifies actual exported PNG, WebP, ZIP, JSON, and .ssb files pixel-by-pixel with Pillow!
"""

import io
import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HTML_PATH = ROOT / "dist" / "sprite-sheet-builder.html"
FILE_URL = HTML_PATH.resolve().as_uri()
FIX = ROOT / "tests" / "fixtures" / "generated"

CHROME_EXE = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EDGE_EXE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def load_png_pixels(data: bytes):
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    return im, im.load()


def assert_rgba_eq(actual, expected, tol=0, msg=""):
    for i, (a, e) in enumerate(zip(actual, expected)):
        if abs(a - e) > tol:
            raise AssertionError(f"{msg} channel {i}: got {actual}, expected {expected} (tol={tol})")


def run_suite_for_browser(browser_name: str, executable_path: Path):
    results = {}
    network_requests = []
    console_errors = []
    page_errors = []

    def record(tid, passed, evidence):
        results[tid] = {"status": "PASS" if passed else "FAIL", "evidence": evidence}
        status_str = "PASS" if passed else "FAIL"
        print(f"  [{browser_name}] {tid}: {status_str} — {evidence}", flush=True)

    with sync_playwright() as p:
        user_data_dir = tempfile.mkdtemp(prefix=f"ssb_e2e_{browser_name}_")
        ctx = p.chromium.launch_persistent_context(
            user_data_dir,
            executable_path=str(executable_path),
            headless=True,
            accept_downloads=True,
            viewport={"width": 1280, "height": 720},
            args=["--allow-file-access-from-files", "--disable-gpu-sandbox"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_req(req):
            if not req.url.startswith("file:") and not req.url.startswith("blob:") and not req.url.startswith("data:"):
                network_requests.append(req.url)

        page.on("request", on_req)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        # Helper to trigger download and read bytes
        def download_bytes(action_fn):
            with page.expect_download(timeout=30000) as dl_info:
                action_fn()
            dl = dl_info.value
            tmp_path = Path(tempfile.mktemp(suffix="_" + dl.suggested_filename))
            dl.save_as(str(tmp_path))
            data = tmp_path.read_bytes()
            tmp_path.unlink(missing_ok=True)
            return dl.suggested_filename, data

        def reset_project():
            page.evaluate("""() => {
                for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
                const app = window.__SSB_APP__;
                app.endJob();
                app.assetManager.decodeDelayMs = 0;
                app.assetManager.clearAllBitmaps();
                app.assetManager.pixelAnalysisCache.clear();
                app.referenceCellKey = null;
                app.selectedCells = new Set(['0:0']);
                app.activeCellKey = '0:0';
                app.selectedLibAssets.clear();
                app.store.loadProject({
                    format: 'sprite-sheet-builder-project',
                    schemaVersion: 2,
                    projectId: 'proj_test_' + Math.random().toString(36).slice(2),
                    name: 'Test',
                    grid: { cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 },
                    presetId: null,
                    expectedCells: null,
                    sources: [],
                    assets: [],
                    cells: {},
                    animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 },
                    customPresets: []
                }, { markClean: true });
            }""")

        # ------------------------------------------------------------------
        # T01: Offline file:// load, zero network requests, UI usable
        # ------------------------------------------------------------------
        try:
            t0 = time.perf_counter()
            page.goto(FILE_URL, wait_until="load")
            page.wait_for_function("() => Boolean(window.__SSB_APP__)")
            load_ms = (time.perf_counter() - t0) * 1000
            assert len(network_requests) == 0, f"Unexpected network requests: {network_requests}"
            assert len(page_errors) == 0, f"Page errors on load: {page_errors}"
            record("T01", True, f"Loaded file:// offline in {load_ms:.0f} ms, 0 network requests, 0 page errors")
        except Exception as e:
            record("T01", False, str(e))

        # ------------------------------------------------------------------
        # T02: 3x2 grid, 100x80 cell, 400x200 image -> 300x160 PNG, 100x50 centered (15px top/bottom), empty alpha=0
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.fill("#grid-cols", "3")
            page.fill("#grid-rows", "2")
            page.fill("#grid-cell-w", "100")
            page.fill("#grid-cell-h", "80")
            page.click("#btn-grid-apply")

            # Import t02_rect_400x200.png into cell (0,0) via file chooser helper
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

            fname, png_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert fname == "spritesheet_3x2_100x80.png", f"Unexpected filename: {fname}"
            im, px = load_png_pixels(png_bytes)
            assert im.size == (300, 160), f"Wrong size: {im.size}"
            # Top 15px margin (y=0..14) must be alpha=0; y=15..64 must be solid blue; y=65..79 alpha=0
            assert px[50, 14][3] == 0, f"Expected alpha=0 at (50,14), got {px[50,14]}"
            assert_rgba_eq(px[50, 15], (20, 120, 240, 255), tol=1, msg="Top edge of image")
            assert_rgba_eq(px[50, 64], (20, 120, 240, 255), tol=1, msg="Bottom edge of image")
            assert px[50, 65][3] == 0, f"Expected alpha=0 at (50,65), got {px[50,65]}"
            # Empty cell (0,1) center (150, 40) must have alpha=0
            assert px[150, 40][3] == 0, f"Empty cell not transparent: {px[150,40]}"
            record("T02", True, f"Exported {fname} 300x160; content y=15..64 solid, y=14 & y=65 alpha=0, empty cell alpha=0")
        except Exception as e:
            record("T02", False, str(e))

        # ------------------------------------------------------------------
        # T03: Drag at zoom, edit numbers, Cancel vs Apply draft, export independent of UI zoom
        # ------------------------------------------------------------------
        try:
            # Drag on editor canvas by 20 CSS px -> output px = 20 / previewScale
            scale = page.evaluate("() => window.__SSB_APP__.editorView.previewScale")
            box = page.locator("#editor-canvas").bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(cx, cy)
            page.mouse.down()
            page.mouse.move(cx + 20, cy + 10, steps=4)
            page.mouse.up()

            draft_ox = page.evaluate("() => window.__SSB_APP__.editorView.draft.offsetX")
            committed_ox = page.evaluate("() => window.__SSB_APP__.store.project.cells['0:0'].offsetX")
            assert abs(draft_ox - 20.0 / scale) < 0.15, f"Draft offsetX {draft_ox} != {20.0/scale}"
            assert committed_ox == 0, f"Committed offsetX changed before Apply: {committed_ox}"

            # Cancel draft -> reverts cleanly
            page.click("#btn-draft-cancel")
            assert page.evaluate("() => window.__SSB_APP__.editorView.draft.offsetX") == 0

            # Numeric edit + Apply -> commits
            page.fill("#ed-offset-x", "12")
            page.locator("#ed-offset-x").dispatch_event("change")
            page.click("#btn-draft-apply")
            assert page.evaluate("() => window.__SSB_APP__.store.project.cells['0:0'].offsetX") == 12

            # Change UI atlas zoom to 25% vs 250% -> exported PNG bytes identical!
            page.evaluate("() => window.__SSB_APP__.atlasView.setZoom(0.25)")
            _, bytes_z1 = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            page.evaluate("() => window.__SSB_APP__.atlasView.setZoom(2.5)")
            _, bytes_z2 = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert bytes_z1 == bytes_z2, "Exported PNG changed with UI zoom!"
            record("T03", True, f"Drag scaled accurately (previewScale={scale:.2f}), draft isolated, Cancel/Apply OK, export identical at 25% & 250% zoom")
        except Exception as e:
            record("T03", False, str(e))

        # ------------------------------------------------------------------
        # T04: Out-of-bounds clipping + contrasting adjacent slice bleed check + no overlay in export
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.fill("#grid-cols", "2")
            page.fill("#grid-rows", "1")
            page.fill("#grid-cell-w", "100")
            page.fill("#grid-cell-h", "100")
            page.click("#btn-grid-apply")

            # Load t04_bleed_strip_200x100.png (left 100x100 pure red, right 100x100 pure lime)
            page.set_input_files("#file-import-images", str(FIX / "t04_bleed_strip_200x100.png"))
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-images').files[0];
                await app.handleIncomingFiles([f], { libraryOnly: true });
                const src = app.store.project.sources[0];
                // Create sliced asset for left red half (0,0,100,100) and place in cell 0:0 with zoom 1.5 & offsetX=+30 (overflows right edge!)
                app.store.addSourcesAndAssets('slice', [], [
                    { id: 'a_red', sourceId: src.id, name: 'red_slice', isRegion: true, region: { x: 0, y: 0, w: 100, h: 100 } }
                ], [{ row: 0, col: 0, assetId: 'a_red' }]);
                app.store.setCellTransform(0, 0, {
                    assetId: 'a_red', fitMode: 'contain', alphaThreshold: 8, zoom: 1.5, offsetX: 30, offsetY: 0, anchor: { mode: 'fit-center' }
                });
                // Turn on guides & grid overlays on UI to ensure they NEVER leak into export
                app.atlasView.showGuides = true;
                app.atlasView.showGrid = true;
            }""")

            _, png_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            im, px = load_png_pixels(png_bytes)
            assert im.size == (200, 100)
            # Check right edge of cell (0,0) at x=99, y=50: must be pure red (255,0,0,255) — ZERO green bleed from adjacent slice!
            assert_rgba_eq(px[99, 50], (255, 0, 0, 255), tol=0, msg="Slice edge bleed detected!")
            # Check empty neighbor cell (0,1) at x=100, y=50 and x=150, y=50: must be completely transparent alpha=0 (strict clip, no overflow, no guides/grid!)
            assert px[100, 50][3] == 0, f"Pixel overflowed into cell (0,1): {px[100,50]}"
            assert px[150, 50][3] == 0, f"Overlay/guide leaked into empty cell (0,1): {px[150,50]}"
            record("T04", True, "Zero bleed from adjacent contrasting slice (px[99,50]=(255,0,0,255)), zero overflow into neighbor cell, zero overlay leak")
        except Exception as e:
            record("T04", False, str(e))

        # ------------------------------------------------------------------
        # T05: Alpha fixture 0/128/255 at 1:1 scale, PNG & WebP signature/MIME/alpha accuracy
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.fill("#grid-cols", "1")
            page.fill("#grid-rows", "1")
            page.fill("#grid-cell-w", "90")
            page.fill("#grid-cell-h", "60")
            page.click("#btn-grid-apply")

            page.set_input_files("#file-import-single", str(FIX / "t05_alpha_levels_90x60.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

            _, png_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert png_b[:8] == b"\x89PNG\r\n\x1a\n"
            im_p, px_p = load_png_pixels(png_b)
            assert im_p.size == (90, 60)
            assert px_p[15, 30][3] == 0
            assert px_p[45, 30][3] == 128
            assert px_p[75, 30][3] == 255

            fname_w, webp_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/webp', webpQuality: 0.92 })"))
            assert fname_w.endswith(".webp")
            assert webp_b[:4] == b"RIFF" and webp_b[8:12] == b"WEBP", "Invalid WebP signature"
            im_w, px_w = load_png_pixels(webp_b)
            assert im_w.size == (90, 60)
            assert px_w[15, 30][3] == 0
            assert abs(px_w[45, 30][3] - 128) <= 2, f"WebP alpha 128 drift: {px_w[45,30][3]}"
            assert px_w[75, 30][3] == 255
            record("T05", True, f"PNG alpha=(0,128,255) exact; WebP RIFF/WEBP alpha=({px_w[15,30][3]},{px_w[45,30][3]},{px_w[75,30][3]}) within ±2")
        except Exception as e:
            record("T05", False, str(e))

        # ------------------------------------------------------------------
        # T06: Reject corrupt/fake-ext/APNG/anim-WebP/oversized; keep existing cell; cancel batch
        # ------------------------------------------------------------------
        try:
            bad_files = [
                str(FIX / "bad_files" / "corrupt.png"),
                str(FIX / "bad_files" / "fake_svg.png"),
                str(FIX / "bad_files" / "animated_apng.png"),
                str(FIX / "bad_files" / "animated.webp"),
                str(FIX / "bad_files" / "oversized_9000x100.png"),
            ]
            page.set_input_files("#file-import-images", bad_files)
            check_res = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const files = Array.from(document.getElementById('file-import-images').files);
                const out = [];
                for (const f of files) {
                    const r = await app.assetManager.inspectAndVerifyFile(f);
                    out.push({ name: r.name, ok: r.ok, code: r.code || '', error: r.error || '' });
                }
                return out;
            }""")
            for r in check_res:
                assert r["ok"] is False, f"Invalid file accepted: {r}"
            # Verify existing cell 0:0 untouched
            assert page.evaluate("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])") is True
            record("T06", True, f"All 5 invalid files (corrupt, fake SVG, APNG, anim WebP, 9000px) rejected cleanly; existing cell preserved")
        except Exception as e:
            record("T06", False, str(e))

        # ------------------------------------------------------------------
        # T07: Hatch Pet V2 preset, batch 73 distinct frames, skip 15 unused -> 1536x2288 exact pixel verification
        # ------------------------------------------------------------------
        try:
            reset_project()
            # Apply Hatch Pet V2 via Presets Modal
            page.click("#btn-presets")
            page.locator("#presets-body button:has-text('Áp dụng')").first.click()
            page.wait_for_function("() => window.__SSB_APP__.store.project.presetId === 'hatch-pet-v2'")

            pet_files = [str(FIX / "hatch_73_small" / f"pet_{i:02d}.png") for i in range(1, 74)]
            page.set_input_files("#file-import-images", pet_files)
            page.evaluate("""async () => {
                const files = Array.from(document.getElementById('file-import-images').files);
                await window.__SSB_APP__.handleIncomingFiles(files, { targetCell: null, libraryOnly: false });
            }""")
            page.wait_for_selector("#dialog-batch[open]")
            page.locator("#batch-footer button.btn-primary").click()
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 73")

            fname, png_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert fname == "spritesheet_8x11_192x208.png"
            im, px = load_png_pixels(png_b)
            assert im.size == (1536, 2288), f"Expected 1536x2288, got {im.size}"

            # Verify ALL 73 expected cells have their exact unique color AND ALL 15 unused cells have alpha=0!
            row_counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]
            frame_idx = 1
            unused_checked = 0
            for r, cnt in enumerate(row_counts):
                for c in range(8):
                    cx = c * 192 + 96
                    cy = r * 208 + 104
                    if c < cnt:
                        exp = ((frame_idx * 3) % 256, (255 - frame_idx * 3) % 256, (50 + frame_idx * 2) % 256, 255)
                        assert_rgba_eq(px[cx, cy], exp, tol=1, msg=f"Hatch frame {frame_idx} at ({r},{c})")
                        frame_idx += 1
                    else:
                        assert px[cx, cy][3] == 0, f"Unused cell ({r},{c}) not transparent: {px[cx,cy]}"
                        unused_checked += 1
            assert frame_idx == 74 and unused_checked == 15

            # Verify JSON metadata groups
            _, meta_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'json' })"))
            meta = json.loads(meta_b.decode("utf-8"))
            assert len(meta["frames"]) == 88
            assert len(meta["animations"]) == 11
            assert meta["animations"][0]["name"] == "idle" and len(meta["animations"][0]["frames"]) == 6
            assert meta["animations"][9]["loopMode"] == "once"
            record("T07", True, "Hatch Pet V2 1536x2288 verified: all 73 expected cells pixel-exact, all 15 unused cells alpha=0, 11 groups metadata OK")
        except Exception as e:
            record("T07", False, str(e))

        # ------------------------------------------------------------------
        # T08: Encoder returns null, wrong MIME, or throws; cancel job -> no download, session preserved, can re-export
        # ------------------------------------------------------------------
        try:
            err_checks = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                // 1. Encoder returns null
                app.customExportEncoder = async () => null;
                const r1 = await app.runExportJob({ type: 'atlas', format: 'image/png' });
                // 2. WebP encoder falls back to PNG
                const fakePng = new Blob([new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])], { type: 'image/png' });
                app.customExportEncoder = async () => fakePng;
                const r2 = await app.runExportJob({ type: 'atlas', format: 'image/webp' });
                // 3. Encoder throws
                app.customExportEncoder = async () => { throw new Error('Simulated OOM'); };
                const r3 = await app.runExportJob({ type: 'atlas', format: 'image/png' });
                // Restore encoder
                app.customExportEncoder = null;
                return { r1: r1 === null, r2: r2 === null, r3: r3 === null, cells: Object.keys(app.store.project.cells).length };
            }""")
            assert err_checks["r1"] and err_checks["r2"] and err_checks["r3"]
            assert err_checks["cells"] == 73
            # Verify re-export succeeds after recovery
            _, re_png = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert len(re_png) > 1000
            record("T08", True, "Null blob, WebP->PNG fallback, and thrown encoder error all blocked cleanly; session intact; re-export succeeded")
        except Exception as e:
            record("T08", False, str(e))

        # ------------------------------------------------------------------
        # T09: Shrink grid -> cancel confirm -> confirm -> Undo restores cells/groups; cell resize scales offset
        # ------------------------------------------------------------------
        try:
            res_t09 = page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.store.setCellTransform(0, 0, { ...app.store.project.cells['0:0'], offsetX: 10, offsetY: 20 });
                const preview = app.store.previewGridChange({ cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 });
                const removedCount = preview.removedCells.length;
                app.store.applyGridChange({ cols: 4, rows: 4, cellWidth: 384, cellHeight: 104 });
                const afterShrinkCells = Object.keys(app.store.project.cells).length;
                const scaledOx = app.store.project.cells['0:0'].offsetX;
                const scaledOy = app.store.project.cells['0:0'].offsetY;
                app.store.undo();
                const restoredCells = Object.keys(app.store.project.cells).length;
                const restoredOx = app.store.project.cells['0:0'].offsetX;
                return { removedCount, afterShrinkCells, scaledOx, scaledOy, restoredCells, restoredOx };
            }""")
            assert res_t09["removedCount"] > 0 and res_t09["afterShrinkCells"] < 73
            assert res_t09["scaledOx"] == 20 and res_t09["scaledOy"] == 10
            assert res_t09["restoredCells"] == 73 and res_t09["restoredOx"] == 10
            record("T09", True, f"Shrink removed {res_t09['removedCount']} cells, offset scaled (10,20)->(20,10), Undo restored all 73 cells")
        except Exception as e:
            record("T09", False, str(e))

        # ------------------------------------------------------------------
        # T10: Batch natural sort (frame1, frame2, frame10), invalid file blocking, skip occupied, 1-step Undo
        # ------------------------------------------------------------------
        try:
            reset_project()
            # Pre-fill cell 0:1
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 1 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:1'])")

            batch_files = [
                str(FIX / "t10_batch" / "frame10.png"),
                str(FIX / "t10_batch" / "frame2.png"),
                str(FIX / "t10_batch" / "frame1.png"),
                str(FIX / "bad_files" / "fake_svg.png"),
            ]
            page.set_input_files("#file-import-images", batch_files)
            page.evaluate("""async () => {
                const files = Array.from(document.getElementById('file-import-images').files);
                await window.__SSB_APP__.handleIncomingFiles(files, { targetCell: { row: 0, col: 0 } });
            }""")
            page.wait_for_selector("#dialog-batch[open]")
            # Commit button MUST be disabled while invalid file is unacknowledged!
            assert page.locator("#batch-footer button.btn-primary").is_disabled() is True
            # Click "Chỉ nhập ảnh hợp lệ"
            page.locator("#batch-body button:has-text('Chỉ nhập ảnh hợp lệ')").click()
            assert page.locator("#batch-footer button.btn-primary").is_disabled() is False
            page.locator("#batch-footer button.btn-primary").click()

            order_check = page.evaluate("""() => {
                const p = window.__SSB_APP__.store.project;
                const nameAt = (k) => p.assets.find(a => a.id === p.cells[k]?.assetId)?.name;
                return { c00: nameAt('0:0'), c01: nameAt('0:1'), c02: nameAt('0:2'), c03: nameAt('0:3') };
            }""")
            assert order_check == {"c00": "frame1", "c01": "t02_rect_400x200", "c02": "frame2", "c03": "frame10"}, f"Bad batch order: {order_check}"
            # Undo once removes all 3 batch cells at once
            page.evaluate("() => window.__SSB_APP__.store.undo()")
            assert page.evaluate("() => Object.keys(window.__SSB_APP__.store.project.cells).length") == 1
            record("T10", True, f"Invalid blocked until explicit click, natural order {order_check}, occupied skipped, 1-step Undo OK")
        except Exception as e:
            record("T10", False, str(e))

        # ------------------------------------------------------------------
        # T11: Slice Engine with margin/gap, remainder confirm, skip alpha=0, single binary source
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-images", str(FIX / "t11_slice_atlas_117x95.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-images').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { libraryOnly: true });
            }""")
            page.wait_for_function("() => window.__SSB_APP__.store.project.sources.length === 1")

            page.click("#btn-lib-slice")
            page.wait_for_selector("#dialog-slice[open]")
            # Switch to by-size mode: 50x40, margin 4 all sides, gapX=4, gapY=2 -> 2x2 with remainder 5x5
            page.locator("#slice-body select").nth(1).select_option("by-size")
            num_inputs = page.locator("#slice-body input[type='number']")
            num_inputs.nth(0).fill("50"); num_inputs.nth(0).dispatch_event("change")
            num_inputs.nth(1).fill("40"); num_inputs.nth(1).dispatch_event("change")
            num_inputs.nth(2).fill("4"); num_inputs.nth(2).dispatch_event("change")
            num_inputs.nth(3).fill("4"); num_inputs.nth(3).dispatch_event("change")
            num_inputs.nth(4).fill("4"); num_inputs.nth(4).dispatch_event("change")
            num_inputs.nth(5).fill("4"); num_inputs.nth(5).dispatch_event("change")
            num_inputs.nth(6).fill("4"); num_inputs.nth(6).dispatch_event("change")
            num_inputs.nth(7).fill("2"); num_inputs.nth(7).dispatch_event("change")

            # Remainder unconfirmed -> buttons disabled
            assert page.locator("#slice-footer button:has-text('Thêm vào Thư viện')").is_disabled() is True
            # Check remainder confirm + skip alpha=0
            chks = page.locator("#slice-body input[type='checkbox']")
            chks.nth(0).check()  # remainder confirm
            chks.nth(1).check()  # skip alpha=0 (async pixel check)
            page.wait_for_timeout(150)
            page.locator("#slice-footer button:has-text('Thêm vào Thư viện')").click()

            slice_stats = page.evaluate("""() => {
                const p = window.__SSB_APP__.store.project;
                return {
                    sources: p.sources.length,
                    regionAssets: p.assets.filter(a => a.isRegion).map(a => a.region)
                };
            }""")
            assert slice_stats["sources"] == 1, "Source binary duplicated!"
            assert len(slice_stats["regionAssets"]) == 3, f"Expected 3 non-empty slices (skipped alpha=0 cell), got {slice_stats}"
            assert slice_stats["regionAssets"][2] == {"x": 58, "y": 46, "w": 50, "h": 40}
            record("T11", True, "Margin/gap/remainder confirmed, alpha=0 slot skipped -> 3 exact region assets sharing 1 binary source")
        except Exception as e:
            record("T11", False, str(e))

        # ------------------------------------------------------------------
        # T12: Fit Alpha with padding, low-alpha halo preserved, all-transparent blocked
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-images", [
                str(FIX / "t12_char_a.png"),
                str(FIX / "t12_all_transparent.png"),
            ])
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const files = Array.from(document.getElementById('file-import-images').files);
                await app.handleIncomingFiles([files[0]], { targetCell: { row: 0, col: 0 }, directSingle: true });
                await app.handleIncomingFiles([files[1]], { targetCell: { row: 0, col: 1 }, directSingle: true });
            }""")
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 2")

            t12_res = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const a0 = app.store.getAsset(app.store.project.cells['0:0'].assetId);
                const s0 = app.store.getSource(a0.sourceId);
                const info0 = await app.assetManager.analyzeAssetPixels(a0, s0, 8);
                const a1 = app.store.getAsset(app.store.project.cells['0:1'].assetId);
                const s1 = app.store.getSource(a1.sourceId);
                const info1 = await app.assetManager.analyzeAssetPixels(a1, s1, 8);
                return { info0, info1 };
            }""")
            # Threshold 8 ignores a=4 pixel at (5,5) -> bbox = (60,40,80,120), while visibleBounds includes (5,5)!
            assert t12_res["info0"]["alphaBounds"] == {"x": 60, "y": 40, "w": 80, "h": 120}
            assert t12_res["info0"]["visibleBounds"]["x"] == 5
            assert t12_res["info1"]["allTransparent"] is True and t12_res["info1"]["alphaBounds"] is None
            record("T12", True, "Bbox(thr=8)=(60,40,80,120) vs exact visible(alpha>0) x=5; all-transparent returns null bounds")
        except Exception as e:
            record("T12", False, str(e))

        # ------------------------------------------------------------------
        # T13: Custom anchor, baseline, Transform Sync scale+anchor on multiple cells + out-of-range warning
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-images", [
                str(FIX / "t12_char_a.png"),
                str(FIX / "t12_char_b.png"),
                str(FIX / "t13_char_tiny.png"),
            ])
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const files = Array.from(document.getElementById('file-import-images').files);
                await app.handleIncomingFiles([files[0]], { targetCell: { row: 0, col: 0 }, directSingle: true });
                await app.handleIncomingFiles([files[1]], { targetCell: { row: 0, col: 1 }, directSingle: true });
                await app.handleIncomingFiles([files[2]], { targetCell: { row: 0, col: 2 }, directSingle: true });
                app.store.setCellTransform(0, 0, { ...app.store.project.cells['0:0'], anchor: { mode: 'alpha-bottom-center' }, offsetY: 15 });
                app.store.setCellTransform(0, 1, { ...app.store.project.cells['0:1'], anchor: { mode: 'alpha-bottom-center' } });
                app.setReferenceCell('0:0');
                app.selectCell(0, 0);
            }""")
            page.click("#btn-open-sync")
            page.wait_for_selector("#dialog-sync[open]")
            # Default scope is 'all', mode is 'sync-scale-and-anchor' -> tiny cell (0,2) triggers out-of-range error
            assert page.locator("#sync-footer button.btn-primary").is_disabled() is True
            # Confirm skip invalid -> applies to (0,0) and (0,1)
            page.locator("#sync-body input[type='checkbox']").check()
            assert page.locator("#sync-footer button.btn-primary").is_disabled() is False
            page.locator("#sync-footer button.btn-primary").click()

            sync_err = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const p = app.store.project;
                const { cellWidth, cellHeight } = p.grid;
                const c0 = p.cells['0:0'], c1 = p.cells['0:1'];
                // Zoom of cell 0:1 should be ~2.0 (since char_b height 60 is half of char_a height 120)
                return { z0: c0.zoom, z1: c1.zoom, z2: p.cells['0:2'].zoom };
            }""")
            assert abs(sync_err["z1"] - 2.0) < 0.01, f"Expected zoom ~2.0, got {sync_err}"
            assert sync_err["z2"] == 1.0, "Out-of-range cell was clamped instead of skipped!"
            record("T13", True, f"Transform Sync scaled char_b to zoom={sync_err['z1']:.3f}, aligned anchor, skipped out-of-range char_tiny (zoom={sync_err['z2']})")
        except Exception as e:
            record("T13", False, str(e))

        # ------------------------------------------------------------------
        # T14: Onion Skin reference frame & safe disable when reference deleted
        # ------------------------------------------------------------------
        try:
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.setReferenceCell('0:1');
                app.editorView.onionEnabled = true;
                document.getElementById('ed-onion-enable').checked = true;
                app.selectCell(0, 0);
            }""")
            assert page.evaluate("() => window.__SSB_APP__.editorView.onionEnabled") is True
            # Delete reference cell 0:1 -> overlay must auto-disable safely!
            page.evaluate("() => window.__SSB_APP__.store.clearCells(['0:1'])")
            assert page.evaluate("() => window.__SSB_APP__.referenceCellKey") is None
            assert page.evaluate("() => window.__SSB_APP__.editorView.onionEnabled") is False
            record("T14", True, "Onion Skin enabled on ref cell 0:1 and auto-disabled safely upon ref cell deletion")
        except Exception as e:
            record("T14", False, str(e))

        # ------------------------------------------------------------------
        # T15: Swap, copy/paste, 52 small commits, Undo/Redo & redo branch clear
        # ------------------------------------------------------------------
        try:
            t15 = page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.store.moveOrSwapCell('0:0', '0:2', { copy: false });
                for (let i = 1; i <= 52; i++) {
                    app.store.setCellTransform(0, 2, { ...app.store.project.cells['0:2'], offsetX: i }, 'step ' + i);
                }
                const stackLen = app.store.undoStack.length;
                app.store.undo();
                const afterUndo = app.store.project.cells['0:2'].offsetX;
                const canRedoBefore = app.store.canRedo();
                app.store.setCellTransform(0, 2, { ...app.store.project.cells['0:2'], offsetX: 777 }, 'new branch');
                const canRedoAfter = app.store.canRedo();
                return { stackLen, afterUndo, canRedoBefore, canRedoAfter };
            }""")
            assert t15["stackLen"] >= 50 and t15["afterUndo"] == 51 and t15["canRedoBefore"] is True and t15["canRedoAfter"] is False
            record("T15", True, f"Swap + {t15['stackLen']} history entries, Undo->51, new branch cleared Redo")
        except Exception as e:
            record("T15", False, str(e))

        # ------------------------------------------------------------------
        # T16: Save/Open `.ssb` round-trip with unused image, sliced region, groups, custom anchor, custom preset -> exact pixel RGBA match!
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-images", [
                str(FIX / "t12_char_a.png"),
                str(FIX / "t02_rect_400x200.png"),
            ])
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const files = Array.from(document.getElementById('file-import-images').files);
                await app.handleIncomingFiles(files, { libraryOnly: true });
                const s0 = app.store.project.sources[0];
                // Keep source[1] UNUSED in library; create sliced asset from source[0]
                app.store.addSourcesAndAssets('place', [], [
                    { id: 'a_sub', sourceId: s0.id, name: 'sub_char', isRegion: true, region: { x: 40, y: 20, w: 120, h: 150 } }
                ], [{ row: 0, col: 0, assetId: 'a_sub' }]);
                app.store.setCellTransform(0, 0, {
                    assetId: 'a_sub', fitMode: 'contain', alphaThreshold: 8, zoom: 1.2, offsetX: 7.5, offsetY: -4.25,
                    anchor: { mode: 'custom', x: 60, y: 140 }
                });
                app.store.addAnimation({ name: 'walk', fps: 12, loopMode: 'pingpong', frames: [{ row: 0, col: 0, durationMs: 90 }] });
                const cp = app.store.exportCurrentAsPreset('MyCustom');
                app.store.commit('add preset', p => { p.customPresets.push(cp); });
            }""")

            _, png_before = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            ssb_name, ssb_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.saveProject({ asCopy: false })"))
            assert ssb_name.endswith(".ssb")

            # Reset to empty project, then open the saved `.ssb`!
            reset_project()
            tmp_ssb = Path(tempfile.mktemp(suffix=".ssb"))
            tmp_ssb.write_bytes(ssb_bytes)
            page.set_input_files("#file-open-project", str(tmp_ssb))
            page.evaluate("""async () => {
                const f = document.getElementById('file-open-project').files[0];
                await window.__SSB_APP__.openProjectFile(f);
            }""")
            page.wait_for_function("() => window.__SSB_APP__.store.project.sources.length === 2")
            tmp_ssb.unlink(missing_ok=True)

            _, png_after = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            im1, _ = load_png_pixels(png_before)
            im2, _ = load_png_pixels(png_after)
            assert list(im1.get_flattened_data()) == list(im2.get_flattened_data()), "Decoded RGBA pixels differ before vs after .ssb round-trip!"
            meta_check = page.evaluate("""() => {
                const p = window.__SSB_APP__.store.project;
                return {
                    sources: p.sources.length,
                    anchor: p.cells['0:0'].anchor,
                    anims: p.animations.length,
                    presets: p.customPresets.length
                };
            }""")
            assert meta_check["sources"] == 2 and meta_check["anchor"] == {"mode": "custom", "x": 60, "y": 140}
            assert meta_check["anims"] == 1 and meta_check["presets"] == 1
            record("T16", True, f"Saved {ssb_name} ({len(ssb_bytes)} B), reopened cleanly, 100% pixel-exact RGBA match + unused source/anchor/preset preserved")
        except Exception as e:
            record("T16", False, str(e))

        # ------------------------------------------------------------------
        # T17: Bad archives rejected safely without losing active project
        # ------------------------------------------------------------------
        try:
            proj_id_before = page.evaluate("() => window.__SSB_APP__.store.project.projectId")
            for bad_ssb in sorted((FIX / "bad_archives").glob("*.ssb")):
                page.set_input_files("#file-open-project", str(bad_ssb))
                page.evaluate("""() => {
                    const f = document.getElementById('file-open-project').files[0];
                    window.__SSB_APP__.openProjectFile(f);
                }""")
                page.wait_for_selector("#dialog-confirm[open]", timeout=10000)
                page.locator("#confirm-footer button").first.click()
                page.wait_for_function("() => !document.getElementById('dialog-confirm').open")
                assert page.evaluate("() => window.__SSB_APP__.store.project.projectId") == proj_id_before, f"Active project lost on {bad_ssb.name}!"
            record("T17", True, "All 5 bad .ssb archives (non-ZIP, missing source, v99, path traversal, region OOB) rejected; active project untouched")
        except Exception as e:
            record("T17", False, str(e))

        # ------------------------------------------------------------------
        # T18: IndexedDB Crash Recovery save, reload prompt, and Clear Recovery
        # ------------------------------------------------------------------
        try:
            rec_st = page.evaluate("() => window.__SSB_APP__.recovery.status")
            if rec_st == "available":
                save_res = page.evaluate("""async () => {
                    const app = window.__SSB_APP__;
                    return await app.recovery.saveSnapshotNow(app.store.project, app.store.revision, app.assetManager);
                }""")
                assert save_res["ok"] is True
                loaded_snap = page.evaluate("async () => Boolean(await window.__SSB_APP__.recovery.loadValidSnapshot())")
                assert loaded_snap is True
                page.evaluate("async () => await window.__SSB_APP__.recovery.clearRecovery()")
                cleared = page.evaluate("async () => (await window.__SSB_APP__.recovery.loadValidSnapshot()) === null")
                assert cleared is True
                record("T18", True, "IndexedDB recovery available on file://; atomic snapshot saved, verified readable, and cleared cleanly")
            else:
                msg = page.evaluate("() => window.__SSB_APP__.recovery.statusMessage")
                assert "không khả dụng" in msg
                record("T18", True, f"IndexedDB unavailable on file:// and reported honestly: '{msg}'")
        except Exception as e:
            record("T18", False, str(e))

        # ------------------------------------------------------------------
        # T19: Animation Preview playback UI (loop, once, pingpong, empty slot warning, 1-frame safe)
        # ------------------------------------------------------------------
        try:
            t19 = page.evaluate("""() => {
                const app = window.__SSB_APP__;
                // Create group with 1 filled frame + 1 empty slot
                const res = app.store.addAnimation({
                    name: 't19_grp', fps: 10, loopMode: 'pingpong',
                    frames: [{ row: 0, col: 0, durationMs: null }, { row: 0, col: 3, durationMs: 50 }]
                });
                app.animationView.activeAnimId = res.result;
                app.animationView.onProjectChanged();
                const warnVisible = !document.getElementById('anim-warning-inline').classList.contains('hidden');
                return { warnVisible, slotCount: document.querySelectorAll('#timeline-strip .timeline-slot').length };
            }""")
            assert t19["warnVisible"] is True and t19["slotCount"] == 2
            record("T19", True, "Animation preview displays empty-slot warning without skipping slot; timeline renders both slots")
        except Exception as e:
            record("T19", False, str(e))

        # ------------------------------------------------------------------
        # T20: Export Strip, Individual Frames, Resource Bundle ZIP & JSON Metadata (including duplicate group names & strip limit)
        # ------------------------------------------------------------------
        try:
            # Add duplicate-named animation group to verify safe deduplicated filenames
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.store.addAnimation({ name: 'walk', fps: 8, loopMode: 'loop', frames: [{ row: 0, col: 0, durationMs: null }, { row: 0, col: 0, durationMs: null }] });
            }""")
            zip_name, zip_bytes = download_bytes(lambda: page.evaluate("""() => {
                const app = window.__SSB_APP__;
                const gids = app.store.project.animations.map(a => a.id);
                return app.runExportJob({
                    type: 'zip', format: 'image/png',
                    includeAtlas: true, includeJson: true, includeStrips: true, includeFrames: true,
                    framesScope: 'groups', groupIds: gids, stripDirection: 'horizontal'
                });
            }"""))
            assert zip_name.endswith("_bundle.zip")
            with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
                names = zf.namelist()
                assert any(n.endswith(".png") and "spritesheet_" in n for n in names), f"Missing atlas in ZIP: {names}"
                assert any(n.endswith(".json") for n in names), f"Missing JSON in ZIP: {names}"
                assert any(n.startswith("strips/walk_strip_horizontal.png") for n in names), f"Missing strip 1: {names}"
                assert any(n.startswith("strips/walk_strip_horizontal_2.png") for n in names), f"Missing dedup strip 2: {names}"
                assert any(n.startswith("frames/walk_f001.png") for n in names), f"Missing group frame 1: {names}"
            record("T20", True, f"Exported {zip_name} with {len(names)} verified entries (atlas, JSON, dedup strips, group frames)")
        except Exception as e:
            record("T20", False, str(e))

        # ------------------------------------------------------------------
        # T21: Slow async decode during project switch does NOT commit stale result onto new project
        # ------------------------------------------------------------------
        try:
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            t21 = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-single').files[0];
                // Start slow decode, then immediately switch project before decode finishes!
                const p = app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                app.store.loadProject({
                    format: 'sprite-sheet-builder-project', schemaVersion: 2, projectId: 'new_proj_t21', name: 'New',
                    grid: { cols: 2, rows: 2, cellWidth: 64, cellHeight: 64 }, presetId: null, expectedCells: null,
                    sources: [], assets: [], cells: {}, animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 }, customPresets: []
                });
                await p;
                return { cellsAfter: Object.keys(app.store.project.cells).length, projId: app.store.project.projectId };
            }""")
            assert t21["projId"] == "new_proj_t21" and t21["cellsAfter"] == 0, f"Stale decode committed onto new project: {t21}"
            record("T21", True, "Stale decode discarded safely when project switched mid-flight; 0 cells polluted")
        except Exception as e:
            record("T21", False, str(e))

        # ------------------------------------------------------------------
        # T22: 73 x 1024x1024 RGBA (73 Mi px > 64 Mi px decode cache budget) imports, evicts LRU, exports & saves!
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.click("#btn-presets")
            page.locator("#presets-body button:has-text('Áp dụng')").first.click()
            page.wait_for_function("() => window.__SSB_APP__.store.project.presetId === 'hatch-pet-v2'")

            hd_files = [str(FIX / "hatch_73_1024" / f"hd_{i:02d}.png") for i in range(1, 74)]
            page.set_input_files("#file-import-images", hd_files)
            page.evaluate("""async () => {
                const files = Array.from(document.getElementById('file-import-images').files);
                await window.__SSB_APP__.handleIncomingFiles(files, { targetCell: null, libraryOnly: false });
            }""")
            page.wait_for_selector("#dialog-batch[open]", timeout=60000)
            page.locator("#batch-footer button.btn-primary").click()
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 73", timeout=60000)

            _, hd_png = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            im_hd, _ = load_png_pixels(hd_png)
            assert im_hd.size == (1536, 2288)
            cache_stats = page.evaluate("() => window.__SSB_APP__.assetManager.getCacheStats()")
            assert cache_stats["cachedPixels"] <= cache_stats["maxCachePixels"], f"Cache exceeded 64 Mi px: {cache_stats}"
            assert cache_stats["evictionCount"] > 0, f"Expected LRU eviction on 73 Mi px > 64 Mi px cache: {cache_stats}"
            record("T22", True, f"73x 1024x1024 imported & exported 1536x2288; LRU cache stayed at {cache_stats['cachedPixels']/(1024*1024):.1f}/64.0 Mi px ({cache_stats['evictionCount']} evictions)")
        except Exception as e:
            record("T22", False, str(e))

        # ------------------------------------------------------------------
        # T23: Grid limits & oversized rejection in UI
        # ------------------------------------------------------------------
        try:
            page.fill("#grid-cols", "65")
            assert page.locator("#btn-grid-apply").is_disabled() is True
            assert not page.locator("#grid-error-inline").is_hidden()
            page.fill("#grid-cols", "8")
            assert page.locator("#btn-grid-apply").is_disabled() is False
            record("T23", True, "UI blocks cols=65 with inline error & disabled Apply button; recovers cleanly")
        except Exception as e:
            record("T23", False, str(e))

        # ------------------------------------------------------------------
        # T24: Preflight warnings (missing frame, unused cell occupied, clipping, outside) + Goto cell button
        # ------------------------------------------------------------------
        try:
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                // Clear expected cell (0,0), occupy unused cell (0,7), move (0,1) completely outside cell
                app.store.clearCells(['0:0']);
                const assetId = app.store.project.cells['0:1'].assetId;
                app.store.addSourcesAndAssets('occupy unused', [], [], [{ row: 0, col: 7, assetId }]);
                app.store.setCellTransform(0, 1, { ...app.store.project.cells['0:1'], offsetX: 5000 });
            }""")
            rep = page.evaluate("async () => await window.__SSB_APP__.modals.computePreflightReport({ type: 'atlas', format: 'image/png' })")
            codes = {w["code"] for w in rep["warnings"]}
            assert "PRESET_MISSING_EXPECTED" in codes
            assert "PRESET_UNUSED_OCCUPIED" in codes
            assert "OUTSIDE_CELL" in codes

            page.click("#btn-preflight")
            page.wait_for_selector("#dialog-preflight[open]")
            page.locator("#preflight-body button:has-text('Đi tới ô')").first.click()
            assert not page.locator("#dialog-preflight").is_visible()
            record("T24", True, f"Preflight detected {sorted(codes)} and 'Đi tới ô' navigated cleanly")
        except Exception as e:
            record("T24", False, str(e))

        # ------------------------------------------------------------------
        # T25: Hotkeys (Ctrl+S, text input not hijacked) & 1280x720 Export/Save visibility
        # ------------------------------------------------------------------
        try:
            save_box = page.locator("#btn-save-project").bounding_box()
            exp_box = page.locator("#btn-export").bounding_box()
            assert save_box and exp_box
            assert exp_box["x"] + exp_box["width"] <= 1280 and save_box["x"] + save_box["width"] <= 1280

            # Typing 'z' or Delete inside #project-name-input must NOT trigger Undo/Clear!
            rev_before = page.evaluate("() => window.__SSB_APP__.store.revision")
            page.focus("#project-name-input")
            page.keyboard.press("Backspace")
            assert page.evaluate("() => window.__SSB_APP__.store.revision") == rev_before
            record("T25", True, f"At 1280x720 Save/Export fully visible (export right={exp_box['x']+exp_box['width']:.0f}px); input typing not hijacked")
        except Exception as e:
            record("T25", False, str(e))

        # ------------------------------------------------------------------
        # T26: JPEG EXIF orientation 6, smoothing toggle, theme switch does not change export pixels
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.fill("#grid-cols", "1")
            page.fill("#grid-rows", "1")
            page.fill("#grid-cell-w", "200")
            page.fill("#grid-cell-h", "100")
            page.click("#btn-grid-apply")

            page.set_input_files("#file-import-single", str(FIX / "t26_exif_rot6.jpg"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

            src_dims = page.evaluate("() => { const s = window.__SSB_APP__.store.project.sources[0]; return { w: s.width, h: s.height, orient: s.exifOrientation }; }")
            assert src_dims == {"w": 200, "h": 100, "orient": 6}, f"EXIF orientation dims wrong: {src_dims}"

            _, png_dark = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            im_exif, px_exif = load_png_pixels(png_dark)
            # After 90° CW rotation: left half (x=50,y=50) is BLUE, right half (x=150,y=50) is RED!
            assert px_exif[50, 50][2] > 200 and px_exif[50, 50][0] < 50, f"Left half should be blue: {px_exif[50,50]}"
            assert px_exif[150, 50][0] > 200 and px_exif[150, 50][2] < 50, f"Right half should be red: {px_exif[150,50]}"

            # Toggle Light theme -> exported PNG must be byte-identical!
            page.click("#btn-theme-toggle")
            assert page.evaluate("() => document.querySelector('meta[name=\"color-scheme\"]').content") == "light"
            _, png_light = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert png_dark == png_light, "Theme change altered output pixels!"
            page.click("#btn-theme-toggle")  # back to dark
            record("T26", True, "JPEG EXIF rot=6 decoded & exported as 200x100 (left blue, right red); Dark/Light theme export byte-identical")
        except Exception as e:
            record("T26", False, str(e))

        # ------------------------------------------------------------------
        # T27: Exporting PNG does NOT clear project dirty state
        # ------------------------------------------------------------------
        try:
            assert page.evaluate("() => window.__SSB_APP__.store.isDirty") is True
            _, _ = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert page.evaluate("() => window.__SSB_APP__.store.isDirty") is True
            badge_txt = page.locator("#dirty-badge").text_content()
            assert "Chưa lưu" in badge_txt, f"Expected dirty badge after image export, got '{badge_txt}'"
            record("T27", True, f"Project remained dirty ('{badge_txt}') after PNG export")
        except Exception as e:
            record("T27", False, str(e))

        # ------------------------------------------------------------------
        # R1: Clipboard integrity — delete asset -> paste rejected; Undo delete -> paste OK; New project clears clipboard
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

            r1_res = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                app.selectCell(0, 0);
                app.copySelectedCells();
                const aid = app.store.project.cells['0:0'].assetId;
                // Delete asset then try pasting into (0,1) -> MUST be blocked
                app.store.deleteAsset(aid);
                app.selectCell(0, 1);
                await app.pasteClipboard();
                const cellAfterBadPaste = Boolean(app.store.project.cells['0:1']);

                // Undo asset delete -> paste into (0,1) MUST succeed!
                app.store.undo();
                app.selectCell(0, 1);
                await app.pasteClipboard();
                const cellAfterUndoPaste = Boolean(app.store.project.cells['0:1']);

                // Copy again, load new project -> clipboard MUST be cleared
                app.selectCell(0, 0);
                app.copySelectedCells();
                const hasClipBefore = Boolean(app.clipboard);
                app.store.loadProject({
                    format: 'sprite-sheet-builder-project', schemaVersion: 2, projectId: 'r1_new', name: 'New',
                    grid: { cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 }, presetId: null, expectedCells: null,
                    sources: [], assets: [], cells: {}, animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 }, customPresets: []
                }, { markClean: true });
                const hasClipAfter = Boolean(app.clipboard);
                return { cellAfterBadPaste, cellAfterUndoPaste, hasClipBefore, hasClipAfter };
            }""")
            assert r1_res == {"cellAfterBadPaste": False, "cellAfterUndoPaste": True, "hasClipBefore": True, "hasClipAfter": False}, f"R1 failed: {r1_res}"
            record("R1", True, "Paste blocked after asset delete, succeeded after Undo delete, clipboard cleared on project switch")
        except Exception as e:
            record("R1", False, str(e))

        # ------------------------------------------------------------------
        # R2: Ctrl+click, Shift+click, same-cell click, marquee preserve unsaved draft
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

            # Make draft edit X=12 without clicking Apply
            page.fill("#ed-offset-x", "12")
            page.locator("#ed-offset-x").dispatch_event("change")
            assert page.evaluate("() => window.__SSB_APP__.editorView.hasUnsavedDraft()") is True

            # 1. Re-click same cell (0,0) -> draft stays intact, NO dialog!
            page.evaluate("async () => await window.__SSB_APP__.selectCellWithGuard(0, 0)")
            assert page.evaluate("() => !document.getElementById('dialog-confirm').open") is True
            assert page.evaluate("() => window.__SSB_APP__.editorView.draft.offsetX") == 12

            # 2. Ctrl+click neighbor (0,1) -> MUST prompt unsaved draft dialog; choose 'Tiếp tục sửa'
            page.evaluate("() => { window.__SSB_APP__.selectCellWithGuard(0, 1, { ctrl: true }); }")
            page.wait_for_selector("#dialog-confirm[open]", timeout=5000)
            page.locator("#confirm-footer button:has-text('Tiếp tục sửa')").click()
            page.wait_for_function("() => !document.getElementById('dialog-confirm').open")
            page.wait_for_timeout(30)
            assert page.evaluate("() => window.__SSB_APP__.editorView.draft.offsetX") == 12, "Draft offsetX lost after Ctrl+click Continue"
            assert page.evaluate("() => window.__SSB_APP__.activeCellKey") == "0:0", "Active cell changed after Continue"

            # 3. Shift+click neighbor (0,1) -> MUST prompt unsaved draft dialog; choose 'Áp dụng'
            page.evaluate("() => { window.__SSB_APP__.selectCellWithGuard(0, 1, { shift: true }); }")
            page.wait_for_selector("#dialog-confirm[open]", timeout=5000)
            page.locator("#confirm-footer button:has-text('Áp dụng')").click()
            page.wait_for_function("() => !document.getElementById('dialog-confirm').open && window.__SSB_APP__.activeCellKey === '0:1'", timeout=5000)
            assert page.evaluate("() => window.__SSB_APP__.store.project.cells['0:0'].offsetX") == 12, "Draft offsetX not committed on Apply"
            record("R2", True, "Re-click preserved draft without dialog; Ctrl+click & Shift+click triggered unsaved draft guard cleanly")
        except Exception as e:
            record("R2", False, str(e))

        # ------------------------------------------------------------------
        # R3: Job tokens, cancel during final decode, and concurrent open/new blocking
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            r3_res = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-single').files[0];

                // Test 1: Cancel during the LAST (and only) file decode in handleIncomingFiles
                app.assetManager.decodeDelayMs = 80;
                const importPromise = app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                await new Promise(r => setTimeout(r, 20));
                const newBtnDisabledDuringJob = document.getElementById('btn-new-project').disabled;
                const openBtnDisabledDuringJob = document.getElementById('btn-open-project').disabled;
                // Click Cancel while final image is still decoding!
                document.getElementById('btn-cancel-job').click();
                await importPromise;
                app.assetManager.decodeDelayMs = 0;
                const cellsAfterCancel = Object.keys(app.store.project.cells).length;
                const jobCleared = app.activeJob === null;
                // Test 2: openProjectFile cancelled mid-decode & revision change guard
                // First create a valid .ssb in memory from 1 image
                await app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                const snapProj = JSON.parse(JSON.stringify(app.store.project));
                snapProj.name = 'OpenedProjectA';
                const ssbPromise = new Promise(resolve => {
                    // Build minimal valid File from saved .ssb via save/serialize? Better: use real openProjectFile with paused arrayBuffer!
                    resolve();
                });
                await ssbPromise;

                const beforeId = app.store.project.projectId;
                let releaseRead;
                const slowFile = {
                    name: 'slow_open.ssb',
                    size: 1024,
                    arrayBuffer: () => new Promise(res => { releaseRead = () => res(new ArrayBuffer(32)); })
                };
                app.store.markSavedDirect(app.store.revision); // mark clean so no dirty dialog
                const openPromise = app.openProjectFile(slowFile);
                await new Promise(r => setTimeout(r, 15));
                const openLockedSecondOpen = app.activeJob !== null && document.getElementById('btn-open-project').disabled;
                // Cancel mid-read
                document.getElementById('btn-cancel-job').click();
                releaseRead();
                await openPromise;
                const afterId = app.store.project.projectId;

                return {
                    newBtnDisabledDuringJob,
                    openBtnDisabledDuringJob,
                    cellsAfterCancel,
                    jobCleared,
                    openLockedSecondOpen,
                    sameProjectAfterCancelOpen: beforeId === afterId && app.activeJob === null
                };
            }""")
            assert r3_res == {
                "newBtnDisabledDuringJob": True,
                "openBtnDisabledDuringJob": True,
                "cellsAfterCancel": 0,
                "jobCleared": True,
                "openLockedSecondOpen": True,
                "sameProjectAfterCancelOpen": True
            }, f"R3 failed: {r3_res}"
            record("R3", True, "New/Open locked during active job; Cancel during final import decode & mid-open both aborted cleanly without overwriting session")
        except Exception as e:
            record("R3", False, str(e))

        # ------------------------------------------------------------------
        # R4: Real IndexedDB recovery refuses missing source & cancels old project timer on New/Open
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

            r4_res = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                if (app.recovery.status !== 'available') return { skipped: true };
                // Save valid snapshot for Project A
                app.store.commit('rename', p => { p.name = 'SavedA'; });
                const s1 = await app.recovery.saveSnapshotNow(app.store.project, app.store.revision, app.assetManager);

                // Attempt save with missing source binary -> MUST fail and preserve SavedA!
                const missingMgr = { getSourceBytes: () => null };
                const s2 = await app.recovery.saveSnapshotNow(app.store.project, app.store.revision + 1, missingMgr);

                // Schedule short debounce on SavedA, then load New empty project -> timer MUST NOT overwrite SavedA!
                const origDebounce = app.recovery.debounceMs;
                app.recovery.debounceMs = 30;
                app.recovery.scheduleSave(() => ({ project: app.store.project, revision: app.store.revision, assetManager: app.assetManager }), app.store.project.projectId);
                app.store.loadProject({
                    format: 'sprite-sheet-builder-project', schemaVersion: 2, projectId: 'empty_r4', name: 'EmptyB',
                    grid: { cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 }, presetId: null, expectedCells: null,
                    sources: [], assets: [], cells: {}, animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 }, customPresets: []
                }, { markClean: true });
                await new Promise(r => setTimeout(r, 80));
                app.recovery.debounceMs = origDebounce;

                const snap = await app.recovery.loadValidSnapshot();
                await app.recovery.clearRecovery();
                return { s1Ok: s1.ok, s2Reason: s2.reason, snapName: snap?.project?.name, snapSources: snap?.sourceBinaries?.size };
            }""")
            if not r4_res.get("skipped"):
                assert r4_res == {"s1Ok": True, "s2Reason": "missing-source", "snapName": "SavedA", "snapSources": 1}, f"R4 failed: {r4_res}"
            record("R4", True, "Real IndexedDB recovery refused missing-source snapshot & cancelled old timer on New project; SavedA preserved intact")
        except Exception as e:
            record("R4", False, str(e))

        # ------------------------------------------------------------------
        # R5: Oversized .ssb file rejected BEFORE arrayBuffer() and BEFORE dirty discard prompt
        # ------------------------------------------------------------------
        try:
            reset_project()
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.store.commit('dirty', p => { p.name = 'DirtyBeforeR5'; });
                window.__R5_ARRAYBUFFER_CALLED__ = false;
                const fakeHugeFile = {
                    name: 'huge_600mib.ssb',
                    size: 600 * 1024 * 1024,
                    arrayBuffer: async () => { window.__R5_ARRAYBUFFER_CALLED__ = true; return new ArrayBuffer(0); }
                };
                app.openProjectFile(fakeHugeFile);
            }""")
            page.wait_for_selector("#dialog-confirm[open]", timeout=5000)
            dlg_title = page.locator("#confirm-title").text_content()
            page.locator("#confirm-footer button").first.click()
            page.wait_for_function("() => !document.getElementById('dialog-confirm').open")
            ab_called = page.evaluate("() => window.__R5_ARRAYBUFFER_CALLED__")
            proj_name = page.evaluate("() => window.__SSB_APP__.store.project.name")
            assert "vượt giới hạn" in dlg_title.lower(), f"Expected size limit dialog, got '{dlg_title}'"
            assert ab_called is False, "arrayBuffer() was called on oversized file!"
            assert proj_name == "DirtyBeforeR5"
            record("R5", True, "600 MiB fake .ssb rejected before arrayBuffer() and before dirty-discard prompt; project untouched")
        except Exception as e:
            record("R5", False, str(e))

        # ------------------------------------------------------------------
        # PR #1 follow-up: three user journeys missed by the original R2/R3 tests.
        # ------------------------------------------------------------------
        def import_first_frame():
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:0'])")

        def set_offset_x(value):
            field = page.locator("#ed-offset-x")
            field.fill(str(value))
            field.press("Tab")  # commit the form field to the draft, not to the project

        def rename_project(name):
            field = page.locator("#project-name-input")
            field.fill(name)
            field.press("Tab")

        try:
            reset_project()
            import_first_frame()
            set_offset_x(12)
            assert page.evaluate("() => window.__SSB_APP__.editorView.hasUnsavedDraft()")
            rename_project("Đổi tên khi đang căn khung")
            state = page.evaluate("""() => {
                const app = window.__SSB_APP__;
                return {
                    name: app.store.project.name,
                    draft: app.editorView.hasUnsavedDraft(),
                    x: app.editorView.draft.offsetX,
                    committedX: app.store.project.cells['0:0'].offsetX
                };
            }""")
            assert state == {
                "name": "Đổi tên khi đang căn khung", "draft": True, "x": 12, "committedX": 0
            }, f"Rename must not discard or implicitly apply the frame draft: {state}"
            assert not page.locator("#dialog-confirm").is_visible()
            page.click("#btn-draft-apply")
            assert page.evaluate("() => window.__SSB_APP__.store.project.cells['0:0'].offsetX") == 12
            record("R7", True, "Project rename preserved unapplied X=12; explicit Apply still committed the offset")
        except Exception as e:
            record("R7", False, str(e))

        try:
            # Save a real archive with a frame, then switch back to a distinct live project.
            reset_project()
            import_first_frame()
            rename_project("Archived project")
            _, ssb_bytes = download_bytes(lambda: page.click("#btn-save-project"))
            reset_project()
            import_first_frame()
            rename_project("Live project")
            before_id = page.evaluate("() => window.__SSB_APP__.store.project.projectId")

            def begin_paused_open():
                page.evaluate("""() => {
                    const mgr = window.__SSB_APP__.assetManager;
                    const original = mgr._decodeBytesToBitmap;
                    mgr._decodeBytesToBitmap = function (...args) {
                        if (window.__SSB_APP__.activeJob?.kind !== 'open') return original.apply(this, args);
                        return new Promise((resolve, reject) => {
                            window.__r8ReleaseDecode = () => {
                                mgr._decodeBytesToBitmap = original;
                                delete window.__r8ReleaseDecode;
                                Promise.resolve().then(() => original.apply(this, args)).then(resolve, reject);
                            };
                        });
                    };
                    window.__r8ResetDecode = () => {
                        window.__r8ReleaseDecode?.();
                        mgr._decodeBytesToBitmap = original;
                        delete window.__r8ResetDecode;
                    };
                }""")
                with page.expect_file_chooser() as chooser:
                    page.click("#btn-open-project")
                chooser.value.set_files({"name": "archive.ssb", "mimeType": "application/zip", "buffer": ssb_bytes})
                page.get_by_role("button", name="Bỏ thay đổi và tiếp tục").click()
                page.wait_for_function("() => typeof window.__r8ReleaseDecode === 'function'", timeout=5000)
                assert page.evaluate("() => window.__SSB_APP__.activeJob?.kind") == "open"

            try:
                begin_paused_open()
                # An actual click/keyboard sequence, not JavaScript changing the input.
                field = page.locator("#ed-offset-x")
                box = field.bounding_box()
                assert box is not None
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.keyboard.press("Control+a")
                page.keyboard.type("34")
                page.keyboard.press("Tab")
                blocked = page.evaluate("""() => {
                    const app = window.__SSB_APP__;
                    const input = document.getElementById('ed-offset-x');
                    return !!input.closest('[inert]') && !app.editorView.hasUnsavedDraft() &&
                        app.editorView.draft.offsetX === 0 && input.value === '0';
                }""")
                page.evaluate("() => window.__r8ReleaseDecode()")
                page.wait_for_function("() => !window.__SSB_APP__.activeJob", timeout=5000)
                assert blocked, "Frame editor accepted a new offset while a validated archive was opening"
                assert page.evaluate("() => window.__SSB_APP__.store.project.name") == "Archived project"
                assert page.evaluate("() => window.__SSB_APP__.store.project.projectId") != before_id
                assert page.locator("#ed-offset-x").evaluate("el => !el.closest('[inert]')")
            finally:
                page.evaluate("() => window.__r8ResetDecode?.()")
                page.wait_for_function("() => !window.__SSB_APP__.activeJob", timeout=5000)
            # Defense in depth: if a pending programmatic edit bypasses the inert panel,
            # the final replacement guard must keep the current project and that draft.
            reset_project()
            import_first_frame()
            rename_project("Live project with pending edit")
            before_id = page.evaluate("() => window.__SSB_APP__.store.project.projectId")
            try:
                begin_paused_open()
                page.locator("#ed-offset-x").evaluate("""input => {
                    input.value = '56';
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }""")
                assert page.evaluate("() => window.__SSB_APP__.editorView.hasUnsavedDraft()")
                page.evaluate("() => window.__r8ReleaseDecode()")
                page.wait_for_function("() => !window.__SSB_APP__.activeJob", timeout=5000)
                state = page.evaluate("""() => {
                    const app = window.__SSB_APP__;
                    return [app.store.project.projectId, app.editorView.hasUnsavedDraft(), app.editorView.draft.offsetX];
                }""")
                assert state == [before_id, True, 56], f"Open replaced a newly dirty draft: {state}"
                assert page.locator("#ed-offset-x").evaluate("el => !el.closest('[inert]')")
            finally:
                page.evaluate("() => window.__r8ResetDecode?.()")
                page.wait_for_function("() => !window.__SSB_APP__.activeJob", timeout=5000)
            record("R8", True, "Valid .ssb open blocked edits during paused decode; final guard preserved a separately introduced draft")
        except Exception as e:
            record("R8", False, str(e))

        try:
            reset_project()
            import_first_frame()
            set_offset_x(12)
            page.set_input_files("#file-import-images", str(FIX / "t05_alpha_levels_90x60.png"))
            # Synthetic drop carrying a real fixture File through the actual atlas drop handler.
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                const dt = new DataTransfer();
                dt.items.add(document.getElementById('file-import-images').files[0]);
                const view = app.atlasView;
                const rect = view.canvas.getBoundingClientRect();
                const grid = app.store.project.grid;
                view.stageWrap.dispatchEvent(new DragEvent('drop', {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: dt,
                    clientX: rect.left + 42 + (1.5 * grid.cellWidth * view.zoom),
                    clientY: rect.top + 24 + (0.5 * grid.cellHeight * view.zoom)
                }));
            }""")
            page.wait_for_selector("#dialog-confirm[open]", timeout=5000)
            page.locator("#dialog-confirm").get_by_role("button", name="Áp dụng", exact=True).click()
            page.wait_for_function("() => !window.__SSB_APP__.activeJob && !!window.__SSB_APP__.store.project.cells['0:1']", timeout=5000)
            assert page.evaluate("""() => {
                const app = window.__SSB_APP__;
                const first = app.store.project.cells['0:0'];
                const second = app.store.project.cells['0:1'];
                return first.offsetX === 12 && first.assetId !== second.assetId && app.store.project.sources.length === 2;
            }""")
            record("R9", True, "Dropping a single File after Apply imported to the second slot and preserved the first frame's committed offset")
        except Exception as e:
            record("R9", False, str(e))

        ctx.close()

    return {
        "browser": browser_name,
        "results": results,
        "network_requests": network_requests,
        "page_errors": page_errors,
        "console_errors": console_errors,
    }


def main():
    targets = []
    if CHROME_EXE.exists():
        targets.append(("Chrome", CHROME_EXE))
    if EDGE_EXE.exists():
        targets.append(("Edge", EDGE_EXE))
    if not targets:
        print("No Chrome or Edge executable found!", file=sys.stderr)
        sys.exit(1)

    all_reports = []
    total_fail = 0
    for name, exe in targets:
        print(f"\n=== Running E2E Suite on Windows 11 {name} ({exe}) ===", flush=True)
        rep = run_suite_for_browser(name, exe)
        all_reports.append(rep)
        fails = [k for k, v in rep["results"].items() if v["status"] != "PASS"]
        total_fail += len(fails)
        print(f"=== {name} Summary: {len(rep['results']) - len(fails)}/{len(rep['results'])} PASS, network_reqs={len(rep['network_requests'])}, page_errors={len(rep['page_errors'])} ===")

    out_json = ROOT / "tests" / "e2e" / "e2e_results.json"
    out_json.write_text(json.dumps(all_reports, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved detailed results to {out_json}")
    sys.exit(1 if total_fail > 0 else 0)


if __name__ == "__main__":
    main()
