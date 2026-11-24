#!/usr/bin/env python3
"""
Sprite Sheet Builder — Per-Cell Eraser/Restore Mask E2E Test Suite (E01–E11).
Runs against the built offline dist/sprite-sheet-builder.html over file:// on Windows 11 Chrome & Edge.
Verifies real UI clicks/drags, DPR=2 accuracy, PNG/WebP pixel buffers, JSON metadata V1/V2,
.ssb V2/V3 & IndexedDB Recovery round-trip, bad manifest rejection, post-op mask budgets,
edge/1px brush accuracy, clipped bounds, and cell/crop operations.
"""

import io
import json
import sys
import tempfile
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


def load_rgba(data: bytes):
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    return im, im.load()


def assert_rgba_eq(actual, expected, tol=0, msg=""):
    for i, (a, e) in enumerate(zip(actual, expected)):
        if abs(a - e) > tol:
            raise AssertionError(f"{msg} channel {i}: got {actual}, expected {expected} (tol={tol})")


def src_to_canvas_client(page, src_x: float, src_y: float):
    """Map an EXIF-oriented source pixel coordinate to current #editor-canvas client (x, y)."""
    return page.evaluate("""([sx, sy]) => {
        const app = window.__SSB_APP__;
        const ed = app.editorView;
        ed.canvas.scrollIntoView({ block: 'center', inline: 'center' });
        const asset = app.store.getAsset(ed.draft.assetId);
        const geom = ed._pointerGeom;
        const rect = ed.canvas.getBoundingClientRect();
        const outX = geom.localX + (sx - asset.region.x) * geom.scale;
        const outY = geom.localY + (sy - asset.region.y) * geom.scale;
        const bx = outX * ed._renderDpr * ed.previewScale;
        const by = outY * ed._renderDpr * ed.previewScale;
        return {
            x: rect.left + bx * (rect.width / ed.canvas.width),
            y: rect.top + by * (rect.height / ed.canvas.height)
        };
    }""", [src_x, src_y])


def run_eraser_suite_for_browser(browser_name: str, executable_path: Path):
    results = {}
    network_requests = []
    page_errors = []
    console_errors = []

    def record(tid, passed, evidence):
        results[tid] = {"status": "PASS" if passed else "FAIL", "evidence": evidence}
        print(f"  [{browser_name}] {tid}: {'PASS' if passed else 'FAIL'} — {evidence}", flush=True)

    with sync_playwright() as p:
        user_data_dir = tempfile.mkdtemp(prefix=f"ssb_eraser_{browser_name}_")
        ctx = p.chromium.launch_persistent_context(
            user_data_dir,
            executable_path=str(executable_path),
            headless=True,
            accept_downloads=True,
            viewport={"width": 1280, "height": 780},
            args=["--allow-file-access-from-files", "--disable-gpu-sandbox"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_req(req):
            if not req.url.startswith("file:") and not req.url.startswith("blob:") and not req.url.startswith("data:"):
                network_requests.append(req.url)

        page.on("request", on_req)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        def download_bytes(action_fn, target_page=page):
            with target_page.expect_download(timeout=30000) as dl_info:
                action_fn()
            dl = dl_info.value
            tmp_path = Path(tempfile.mktemp(suffix="_" + dl.suggested_filename))
            dl.save_as(str(tmp_path))
            data = tmp_path.read_bytes()
            tmp_path.unlink(missing_ok=True)
            return dl.suggested_filename, data

        def reset_project(target_page=page, cols=12, rows=1, cw=64, ch=64):
            try:
                target_page.mouse.up()
            except Exception:
                pass
            target_page.evaluate("""([cols, rows, cw, ch]) => {
                for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
                const tc = document.getElementById('toast-container');
                if (tc) tc.replaceChildren();
                const edBody = document.getElementById('editor-body');
                if (edBody) edBody.scrollTop = 0;
                const app = window.__SSB_APP__;
                app.endJob();
                app.assetManager.clearAllBitmaps();
                app.assetManager.pixelAnalysisCache.clear();
                app.referenceCellKey = null;
                app.selectedCells = new Set(['0:0']);
                app.activeCellKey = '0:0';
                app.selectedLibAssets.clear();
                app.store.loadProject({
                    format: 'sprite-sheet-builder-project',
                    schemaVersion: 2,
                    projectId: 'proj_eraser_' + Math.random().toString(36).slice(2),
                    name: 'EraserTest',
                    grid: { cols, rows, cellWidth: cw, cellHeight: ch },
                    presetId: null,
                    expectedCells: null,
                    sources: [],
                    assets: [],
                    cells: {},
                    animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 },
                    customPresets: []
                }, { markClean: true });
            }""", [cols, rows, cw, ch])

        def import_and_slice_12_frames(target_page=page, cell_w=64, cell_h=64):
            reset_project(target_page, cols=12, rows=1, cw=cell_w, ch=cell_h)
            target_page.set_input_files("#file-import-images", str(FIX / "e01_strip_12frames_768x64.png"))
            target_page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-images').files[0];
                await app.handleIncomingFiles([f], { libraryOnly: true });
                const src = app.store.project.sources[0];
                const assets = [];
                const assigns = [];
                for (let i = 0; i < 12; i++) {
                    const aid = 'f_' + i;
                    assets.push({ id: aid, sourceId: src.id, name: 'frame_' + (i + 1), isRegion: true, region: { x: i * 64, y: 0, w: 64, h: 64 } });
                    assigns.push({ row: 0, col: i, assetId: aid });
                }
                app.store.addSourcesAndAssets('slice12', [], assets, assigns);
                app.store.addAnimation({
                    name: 'walk12',
                    fps: 8,
                    loopMode: 'loop',
                    frames: assigns.map(a => ({ row: a.row, col: a.col, durationMs: null }))
                });
                app.selectCell(0, 0);
            }""")
            target_page.wait_for_function("() => Boolean(window.__SSB_APP__.editorView._pointerGeom && window.__SSB_APP__.assetManager.getAssetDrawableSync(window.__SSB_APP__.store.getAsset('f_0'), window.__SSB_APP__.store.project.sources[0]))", timeout=5000)
            target_page.evaluate("() => window.__SSB_APP__.editorView.render()")

        page.goto(FILE_URL, wait_until="load")
        page.wait_for_function("() => Boolean(window.__SSB_APP__)")

        # ------------------------------------------------------------------
        # E01: 12-frame strip, erase Frame 2 speck inside Frame 1, zoom, PNG & WebP clean
        # ------------------------------------------------------------------
        try:
            # First verify empty cell has no brush UI visible
            reset_project(page, cols=4, rows=1, cw=64, ch=64)
            assert page.locator("#editor-body").evaluate("el => el.classList.contains('hidden')")
            assert page.evaluate("() => window.__SSB_APP__.editorView.toolMode === 'move'")

            import_and_slice_12_frames(page, 64, 64)
            orig_strip_im = Image.open(FIX / "e01_strip_12frames_768x64.png").convert("RGBA")
            orig_px = orig_strip_im.load()

            # Zoom editor view to 200%, choose Erase mode, brush size 14
            page.select_option("#ed-view-zoom", "2")
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "14")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")

            # Verify brush cursor radius matches (brushSize/2) * geom.scale * previewScale
            cursor_check = page.evaluate("""() => {
                const ed = window.__SSB_APP__.editorView;
                const expected = (ed.brushSize / 2) * ed._pointerGeom.scale * ed.previewScale;
                return { actual: ed.brushCursorRadiusCss, expected };
            }""")
            assert abs(cursor_check["actual"] - cursor_check["expected"]) < 0.01, f"Cursor radius mismatch: {cursor_check}"

            # Erase speck in Frame 1 (x=54..61, y=24..37) by dragging (58, 25) -> (58, 36)
            p_start = src_to_canvas_client(page, 58, 25)
            p_end = src_to_canvas_client(page, 58, 36)
            page.mouse.move(p_start["x"], p_start["y"])
            page.mouse.down()
            page.mouse.move(p_end["x"], p_end["y"], steps=5)
            page.mouse.up()

            # Verify brush drag did NOT move image offsetX/offsetY
            off_check = page.evaluate("() => [window.__SSB_APP__.editorView.draft.offsetX, window.__SSB_APP__.editorView.draft.offsetY]")
            assert off_check == [0, 0], f"Brush moved image offset: {off_check}"

            page.click("#btn-draft-apply")

            # Export PNG & WebP
            _, png_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            im_png, px_png = load_rgba(png_bytes)
            assert im_png.size == (768, 64)
            # Speck area in Frame 1 must have alpha == 0
            for sy in range(25, 37):
                assert px_png[58, sy][3] == 0, f"Speck not erased at (58,{sy}): {px_png[58, sy]}"
            # Frame 1 body pixel untouched
            assert_rgba_eq(px_png[30, 32], orig_px[30, 32], tol=0, msg="Frame 1 body modified")
            # Remaining 11 frames (x=64..767) 100% identical to original strip
            diff_other = 0
            for x in range(64, 768):
                for y in range(64):
                    if px_png[x, y] != orig_px[x, y]:
                        diff_other += 1
            assert diff_other == 0, f"Other 11 frames changed ({diff_other} pixels)!"

            # WebP format & alpha check
            fname_w, webp_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/webp', webpQuality: 0.92 })"))
            assert fname_w.endswith(".webp") and webp_bytes[:4] == b"RIFF" and webp_bytes[8:12] == b"WEBP"
            im_w, px_w = load_rgba(webp_bytes)
            assert im_w.size == (768, 64)
            assert px_w[58, 30][3] == 0, f"WebP speck alpha != 0: {px_w[58, 30]}"
            assert px_w[5, 5][3] == 0, f"WebP transparent bg != 0: {px_w[5, 5]}"
            record("E01", True, "12-frame strip speck erased (alpha=0), body & 11 other frames exact 0-diff, WebP RIFF/WEBP transparent")
        except Exception as e:
            record("E01", False, str(e))

        # ------------------------------------------------------------------
        # E02: Shared asset across two cells — erasing cell 1 does NOT alter cell 8 or source bytes
        # ------------------------------------------------------------------
        try:
            import_and_slice_12_frames(page, 64, 64)
            orig_bytes_hex = page.evaluate("""() => {
                const app = window.__SSB_APP__;
                const b = app.assetManager.getSourceBytes(app.store.project.sources[0].id);
                return b.length + ':' + Array.from(b.slice(0, 32)).join(',');
            }""")
            # Assign same asset f_0 to cell 0:7 (cell 8)
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.store.addSourcesAndAssets('share_f0', [], [], [{ row: 0, col: 7, assetId: 'f_0' }]);
                app.selectCell(0, 0);
            }""")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")

            # Erase center of cell 0:0
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "20")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            pt = src_to_canvas_client(page, 30, 32)
            page.mouse.click(pt["x"], pt["y"])
            page.click("#btn-draft-apply")

            after_bytes_hex = page.evaluate("""() => {
                const app = window.__SSB_APP__;
                const b = app.assetManager.getSourceBytes(app.store.project.sources[0].id);
                return b.length + ':' + Array.from(b.slice(0, 32)).join(',');
            }""")
            assert orig_bytes_hex == after_bytes_hex, "Source bytes mutated!"

            _, png_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px = load_rgba(png_bytes)
            # Cell 0:0 center erased
            assert px[30, 32][3] == 0, f"Cell 0:0 center not erased: {px[30, 32]}"
            # Cell 0:7 (col=7 -> x offset 7*64=448) MUST match original f_0 pixel-for-pixel!
            orig_im = Image.open(FIX / "e01_strip_12frames_768x64.png").convert("RGBA")
            orig_px = orig_im.load()
            diffs = 0
            for y in range(64):
                for x in range(64):
                    if px[7 * 64 + x, y] != orig_px[x, y]:
                        diffs += 1
            assert diffs == 0, f"Shared asset control cell 0:7 changed ({diffs} pixels)!"
            record("E02", True, "Erased cell 0:0 center (alpha=0); control cell 0:7 sharing f_0 has 0 pixel diffs; source bytes untouched")
        except Exception as e:
            record("E02", False, str(e))

        # ------------------------------------------------------------------
        # E03: DPR=2 context, non-zero crop origin, zoom!=100%, offset!=0, fast 2-event drag, transform change after erase
        # ------------------------------------------------------------------
        try:
            dpr2_dir = tempfile.mkdtemp(prefix=f"ssb_dpr2_{browser_name}_")
            ctx2 = p.chromium.launch_persistent_context(
                dpr2_dir,
                executable_path=str(executable_path),
                headless=True,
                accept_downloads=True,
                viewport={"width": 1280, "height": 780},
                device_scale_factor=2,
                args=["--allow-file-access-from-files", "--disable-gpu-sandbox"],
            )
            p2 = ctx2.pages[0] if ctx2.pages else ctx2.new_page()
            p2.goto(FILE_URL, wait_until="load")
            p2.wait_for_function("() => Boolean(window.__SSB_APP__)")
            dpr_val = p2.evaluate("() => window.devicePixelRatio")
            assert dpr_val == 2, f"Expected DPR=2, got {dpr_val}"

            # Load 12-frame strip into 1x1 grid of 100x100 cell using frame 3 (non-zero crop origin x=128, y=0, w=64, h=64)
            reset_project(p2, cols=1, rows=1, cw=100, ch=100)
            p2.set_input_files("#file-import-images", str(FIX / "e01_strip_12frames_768x64.png"))
            p2.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-images').files[0];
                await app.handleIncomingFiles([f], { libraryOnly: true });
                const src = app.store.project.sources[0];
                app.store.addSourcesAndAssets('slice_f3', [], [
                    { id: 'a_f3', sourceId: src.id, name: 'frame3', isRegion: true, region: { x: 128, y: 0, w: 64, h: 64 } }
                ], [{ row: 0, col: 0, assetId: 'a_f3' }]);
                app.store.setCellTransform(0, 0, {
                    assetId: 'a_f3', fitMode: 'contain', alphaThreshold: 8, zoom: 1.5, offsetX: 12, offsetY: -8, anchor: { mode: 'fit-center' }
                });
                app.selectCell(0, 0);
            }""")
            p2.wait_for_function("() => Boolean(window.__SSB_APP__.editorView._pointerGeom && window.__SSB_APP__.assetManager.getAssetDrawableSync(window.__SSB_APP__.store.getAsset('a_f3'), window.__SSB_APP__.store.project.sources[0]))", timeout=5000)

            p2.select_option("#ed-view-zoom", "2")
            p2.click("#btn-ed-tool-erase")
            p2.fill("#ed-brush-size-num", "8")
            p2.locator("#ed-brush-size-num").dispatch_event("change")
            p2.evaluate("() => window.__SSB_APP__.editorView.render()")

            # 1. Single click at exact known source pixel (128+30=158, 32)
            pt_click = src_to_canvas_client(p2, 158, 32)
            p2.mouse.click(pt_click["x"], pt_click["y"])

            # 2. Fast drag (steps=1 -> single pointermove jump of 26 source px) from (145, 20) to (171, 20)
            pt_a = src_to_canvas_client(p2, 145, 20)
            pt_b = src_to_canvas_client(p2, 171, 20)
            p2.mouse.move(pt_a["x"], pt_a["y"])
            p2.mouse.down()
            p2.mouse.move(pt_b["x"], pt_b["y"], steps=1)
            p2.mouse.up()

            # Verify stored stroke coords are in EXIF source space (~158, 32)
            stored_strokes = p2.evaluate("() => window.__SSB_APP__.editorView.draft.mask.strokes")
            assert len(stored_strokes) == 2
            assert abs(stored_strokes[0]["points"][0][0] - 158) < 1.0 and abs(stored_strokes[0]["points"][0][1] - 32) < 1.0, f"Wrong source coord: {stored_strokes[0]}"

            # Change zoom & offset AFTER erasing, then apply!
            p2.fill("#ed-zoom-num", "200")
            p2.locator("#ed-zoom-num").dispatch_event("change")
            p2.fill("#ed-offset-x", "-10")
            p2.locator("#ed-offset-x").dispatch_event("change")
            p2.fill("#ed-offset-y", "6")
            p2.locator("#ed-offset-y").dispatch_event("change")
            p2.click("#btn-draft-apply")

            # Compute expected output cell pixel coords for source (158, 32), midpoint (158, 20), and untouched (158, 45)
            # Under new transform: cell=100x100, region=64x64 -> fit=100/64=1.5625, zoom=2 -> scale=3.125
            # localX = 50 - 32*3.125 + (-10) = -60, localY = 50 - 32*3.125 + 6 = -44
            # out(sx, sy) = (localX + (sx-128)*scale, localY + sy*scale)
            def out_pt(sx, sy):
                scale = (100.0 / 64.0) * 2.0
                return (int(round(-60 + (sx - 128) * scale)), int(round(-44 + sy * scale)))

            _, png_bytes = download_bytes(lambda: p2.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"), target_page=p2)
            _, px = load_rgba(png_bytes)
            ox1, oy1 = out_pt(158, 32)
            oxm, oym = out_pt(158, 20)
            oxu, oyu = out_pt(158, 45)
            assert px[ox1, oy1][3] == 0, f"1-click erased pixel drifted after transform change at ({ox1},{oy1}): {px[ox1,oy1]}"
            assert px[oxm, oym][3] == 0, f"Fast drag midpoint had gap at ({oxm},{oym}): {px[oxm,oym]}"
            assert px[oxu, oyu][3] == 255, f"Untouched body pixel erased at ({oxu},{oyu}): {px[oxu,oyu]}"
            ctx2.close()
            record("E03", True, f"DPR=2, crop=(128,0), zoom=150%->200%, offset=(12,-8)->(-10,6): click & fast drag locked to source pixels (0 gap, 0 drift)")
        except Exception as e:
            try:
                ctx2.close()
            except Exception:
                pass
            record("E03", False, str(e))

        # ------------------------------------------------------------------
        # E04: Erase & Restore across alpha 0 / 128 / 255, Draft Undo, Cancel, Apply, Project Undo/Redo
        # ------------------------------------------------------------------
        try:
            reset_project(page, cols=1, rows=1, cw=90, ch=60)
            page.set_input_files("#file-import-single", str(FIX / "t05_alpha_levels_90x60.png"))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                window.__SSB_APP__.selectCell(0, 0);
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.editorView._pointerGeom && window.__SSB_APP__.assetManager.getAssetDrawableSync(window.__SSB_APP__.store.project.assets[0], window.__SSB_APP__.store.project.sources[0]))", timeout=5000)
            page.select_option("#ed-view-zoom", "2")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")

            # Draft test: erase -> draft undo -> re-erase -> Cancel draft
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "12")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            p1 = src_to_canvas_client(page, 75, 45)
            page.mouse.click(p1["x"], p1["y"])
            assert page.evaluate("() => window.__SSB_APP__.editorView.draft.mask.strokes.length") == 1
            page.click("#btn-draft-undo")
            assert page.evaluate("() => !window.__SSB_APP__.editorView.draft.mask")
            page.mouse.click(p1["x"], p1["y"])
            page.click("#btn-draft-cancel")
            assert page.evaluate("() => !window.__SSB_APP__.store.project.cells['0:0'].mask && !window.__SSB_APP__.editorView.hasUnsavedDraft()")

            # Now erase across alpha=0 (x=15), alpha=128 (x=45), alpha=255 (x=75) at y=20, then RESTORE across y=20, plus erase dot at (75, 45)
            pa = src_to_canvas_client(page, 15, 20)
            pb = src_to_canvas_client(page, 75, 20)
            page.click("#btn-ed-tool-erase")
            page.mouse.move(pa["x"], pa["y"])
            page.mouse.down()
            page.mouse.move(pb["x"], pb["y"], steps=4)
            page.mouse.up()

            page.click("#btn-ed-tool-restore")
            page.mouse.move(pa["x"], pa["y"])
            page.mouse.down()
            page.mouse.move(pb["x"], pb["y"], steps=4)
            page.mouse.up()

            page.click("#btn-ed-tool-erase")
            page.mouse.click(p1["x"], p1["y"])
            page.click("#btn-draft-apply")

            _, png_after = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px = load_rgba(png_after)
            assert px[15, 20][3] == 0, f"Restored alpha=0 got opaque: {px[15,20]}"
            assert px[45, 20][3] == 128, f"Restored alpha=128 drifted: {px[45,20]}"
            assert px[75, 20][3] == 255, f"Restored alpha=255 wrong: {px[75,20]}"
            assert px[75, 45][3] == 0, f"Erased dot (75,45) not transparent: {px[75,45]}"

            # Project Undo / Redo
            page.click("#btn-undo")
            _, png_undo = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px_u = load_rgba(png_undo)
            assert px_u[75, 45][3] == 255, f"Project Undo did not restore mask: {px_u[75,45]}"

            page.click("#btn-redo")
            _, png_redo = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px_r = load_rgba(png_redo)
            assert px_r[75, 45][3] == 0, f"Project Redo did not re-apply mask: {px_r[75,45]}"
            record("E04", True, "Erase/Restore exact alpha=(0,128,255) without alpha buildup; Draft Undo, Cancel, Apply, Project Undo/Redo all verified")
        except Exception as e:
            record("E04", False, str(e))

        # ------------------------------------------------------------------
        # E05: Speck widens alpha bounds -> erase -> Fit Alpha + alpha anchor + metadata + strip/frame match -> erase ALL -> warn & transparent export -> restore
        # ------------------------------------------------------------------
        try:
            import_and_slice_12_frames(page, 64, 64)
            # Enable Fit Alpha + alpha-bottom-center BEFORE erasing speck
            page.select_option("#ed-fit-mode", "alpha")
            page.select_option("#ed-anchor-mode", "alpha-bottom-center")
            page.click("#btn-draft-apply")

            # Pre-erase bounds must include speck (width=48: x=14..61)
            pre_bounds = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const cell = app.store.project.cells['0:0'];
                const asset = app.store.getAsset(cell.assetId);
                const src = app.store.getSource(asset.sourceId);
                return (await app.assetManager.analyzeCellPixels(asset, src, cell.alphaThreshold, cell.mask)).alphaBounds;
            }""")
            assert pre_bounds["w"] == 48, f"Expected pre-erase width 48 (with speck), got {pre_bounds}"

            # Erase speck in cell 0:0 (geometry locked during stroke, Fit Alpha updates AFTER stroke BEFORE Apply!)
            page.select_option("#ed-view-zoom", "2")
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "16")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")
            p_s1 = src_to_canvas_client(page, 58, 24)
            p_s2 = src_to_canvas_client(page, 58, 37)
            page.mouse.move(p_s1["x"], p_s1["y"])
            page.mouse.down()
            page.mouse.move(p_s2["x"], p_s2["y"], steps=5)
            page.mouse.up()

            # Wait for post-stroke masked analysis to update BEFORE clicking Apply!
            page.wait_for_function("""() => {
                const app = window.__SSB_APP__;
                const ed = app.editorView;
                const asset = app.store.getAsset(ed.draft.assetId);
                const anal = app.assetManager.getCachedCellPixelAnalysis(asset, ed.draft.alphaThreshold, ed.draft.mask);
                return Boolean(anal && anal.alphaBounds && anal.alphaBounds.w === 32);
            }""", timeout=5000)

            page.click("#btn-draft-apply")

            # Export Atlas PNG, Strip PNG, Single Frame PNG, JSON V1 (default), and JSON V2 (with contentBoundsCellPx) -> verify consistency!
            _, atlas_png = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, frame_png = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'frames', framesScope: 'selected-cells', selectedCells: ['0:0'], format: 'image/png' })"))
            _, strip_png = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'strip', groupIds: [window.__SSB_APP__.store.project.animations[0].id], stripDirection: 'horizontal', format: 'image/png' })"))
            _, meta_v1_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'json' })"))
            _, meta_v2_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'json', includeContentBounds: true })"))

            meta_v1 = json.loads(meta_v1_bytes.decode("utf-8"))
            assert meta_v1["schemaVersion"] == 1
            assert "contentBoundsCellPx" not in meta_v1["frames"][0], "V1 metadata must not include contentBoundsCellPx"
            assert abs(meta_v1["frames"][0]["anchorCellPx"]["x"] - 32.0) < 0.05 and abs(meta_v1["frames"][0]["anchorCellPx"]["y"] - 64.0) < 0.05

            meta_v2 = json.loads(meta_v2_bytes.decode("utf-8"))
            assert meta_v2["schemaVersion"] == 2
            f0_meta = meta_v2["frames"][0]
            im_a, px_a = load_rgba(atlas_png)
            # Compute actual PNG alpha > 0 bbox of cell 0:0 and assert exact match with V2 metadata!
            png_bbox = im_a.crop((0, 0, 64, 64)).getbbox()
            assert png_bbox is not None
            exp_bounds = {"x": png_bbox[0], "y": png_bbox[1], "w": png_bbox[2] - png_bbox[0], "h": png_bbox[3] - png_bbox[1]}
            assert f0_meta["contentBoundsCellPx"] == exp_bounds, f"V2 metadata bounds {f0_meta['contentBoundsCellPx']} != actual PNG bbox {exp_bounds}"
            assert abs(f0_meta["anchorCellPx"]["x"] - 32.0) < 0.05 and abs(f0_meta["anchorCellPx"]["y"] - 64.0) < 0.05, f"Metadata anchor mismatch: {f0_meta}"

            im_f, px_f = load_rgba(frame_png)
            im_s, px_s = load_rgba(strip_png)
            for y in range(64):
                for x in range(64):
                    assert px_a[x, y] == px_f[x, y] == px_s[x, y], f"Atlas/Frame/Strip mismatch at ({x},{y})"

            # Now erase ENTIRE visible body of cell 0:0 (brush size 128 at center)
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "128")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")
            p_mid = src_to_canvas_client(page, 30, 32)
            page.mouse.click(p_mid["x"], p_mid["y"])
            page.wait_for_function("""() => {
                const app = window.__SSB_APP__;
                const ed = app.editorView;
                const asset = app.store.getAsset(ed.draft.assetId);
                const anal = app.assetManager.getCachedCellPixelAnalysis(asset, ed.draft.alphaThreshold, ed.draft.mask);
                return Boolean(anal && anal.allTransparent);
            }""", timeout=5000)
            page.click("#btn-draft-apply")

            # Preflight: 0 errors, MASK_ALL_TRANSPARENT warning!
            pf = page.evaluate("async () => await window.__SSB_APP__.modals.computePreflightReport({ type: 'atlas', format: 'image/png' })")
            assert len(pf["errors"]) == 0, f"Erased-empty Fit Alpha caused blocking errors: {pf['errors']}"
            assert any(w["code"] == "MASK_ALL_TRANSPARENT" for w in pf["warnings"]), f"Missing MASK_ALL_TRANSPARENT warning: {pf['warnings']}"

            # Export Atlas PNG succeeds cleanly; cell 0:0 is 100% alpha=0; cell 0:1 intact
            _, empty_atlas = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px_e = load_rgba(empty_atlas)
            for y in range(64):
                for x in range(64):
                    assert px_e[x, y][3] == 0, f"Erased-empty cell not transparent at ({x},{y})"
            assert px_e[64 + 30, 32][3] == 255, "Frame 2 damaged when Frame 1 erased empty"

            # Restore works even after erasing everything under Fit Alpha!
            page.click("#btn-ed-tool-restore")
            page.fill("#ed-brush-size-num", "20")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")
            p_rest = src_to_canvas_client(page, 30, 32)
            page.mouse.click(p_rest["x"], p_rest["y"])
            page.wait_for_function("""() => {
                const app = window.__SSB_APP__;
                const ed = app.editorView;
                const asset = app.store.getAsset(ed.draft.assetId);
                const anal = app.assetManager.getCachedCellPixelAnalysis(asset, ed.draft.alphaThreshold, ed.draft.mask);
                return Boolean(anal && !anal.allTransparent && anal.alphaBounds);
            }""", timeout=5000)

            # Clear all mask strokes also works
            page.click("#btn-ed-mask-clear")
            page.click("#btn-draft-apply")
            assert page.evaluate("() => !window.__SSB_APP__.store.project.cells['0:0'].mask")
            record("E05", True, "Speck erased -> Fit Alpha/anchor/metadata updated (w 48->32); Atlas/Strip/Frame 0-diff; erased-empty warns & exports alpha=0; Restore & Clear Mask work")
        except Exception as e:
            record("E05", False, str(e))

        # ------------------------------------------------------------------
        # E06: Save/Open .ssb V3 round-trip (pixel-exact), Recovery snapshot, V2 compat, invalid V3 rejected
        # ------------------------------------------------------------------
        try:
            import_and_slice_12_frames(page, 64, 64)
            # First save an unmasked V2 .ssb to test V2 backward compatibility
            _, ssb_v2_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.saveProject({ asCopy: false })"))
            with zipfile.ZipFile(io.BytesIO(ssb_v2_bytes), "r") as zf:
                m_v2 = json.loads(zf.read("manifest.json").decode("utf-8"))
                assert m_v2["schemaVersion"] == 2, f"Unmasked project should save as V2, got {m_v2['schemaVersion']}"

            # Paint overlapping erase + restore + erase strokes on cell 0:0
            page.select_option("#ed-view-zoom", "2")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "16")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            p_a = src_to_canvas_client(page, 22, 24)
            p_b = src_to_canvas_client(page, 40, 42)
            page.mouse.move(p_a["x"], p_a["y"]); page.mouse.down(); page.mouse.move(p_b["x"], p_b["y"], steps=4); page.mouse.up()

            page.click("#btn-ed-tool-restore")
            page.fill("#ed-brush-size-num", "10")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            p_c = src_to_canvas_client(page, 40, 24)
            p_d = src_to_canvas_client(page, 22, 42)
            page.mouse.move(p_c["x"], p_c["y"]); page.mouse.down(); page.mouse.move(p_d["x"], p_d["y"], steps=4); page.mouse.up()

            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "6")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            p_e = src_to_canvas_client(page, 31, 33)
            page.mouse.click(p_e["x"], p_e["y"])
            page.click("#btn-draft-apply")

            _, png_before = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, ssb_v3_bytes = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.saveProject({ asCopy: false })"))
            with zipfile.ZipFile(io.BytesIO(ssb_v3_bytes), "r") as zf:
                m_v3 = json.loads(zf.read("manifest.json").decode("utf-8"))
                assert m_v3["schemaVersion"] == 3, f"Masked project should save as V3, got {m_v3['schemaVersion']}"
                assert len(m_v3["cells"]["0:0"]["mask"]["strokes"]) == 3

            # Test IndexedDB Recovery save & load with V3 mask
            rec_ok = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                if (app.recovery.status !== 'available') return { skipped: true };
                const sv = await app.recovery.saveSnapshotNow(app.store.project, app.store.revision, app.assetManager);
                if (!sv.ok) return { ok: false, reason: sv.reason || sv.error };
                const snap = await app.recovery.loadValidSnapshot();
                return {
                    ok: Boolean(snap && snap.project.schemaVersion === 3 && snap.project.cells['0:0'].mask.strokes.length === 3),
                    strokes: snap?.project?.cells?.['0:0']?.mask?.strokes?.length || 0
                };
            }""")
            assert rec_ok.get("skipped") or rec_ok.get("ok"), f"Recovery V3 failed: {rec_ok}"

            # Reset, reopen V3 .ssb, and compare exported PNG pixel-for-pixel!
            reset_project(page, cols=4, rows=4, cw=64, ch=64)
            tmp_v3 = Path(tempfile.mktemp(suffix=".ssb"))
            tmp_v3.write_bytes(ssb_v3_bytes)
            page.set_input_files("#file-open-project", str(tmp_v3))
            page.evaluate("""async () => {
                const f = document.getElementById('file-open-project').files[0];
                await window.__SSB_APP__.openProjectFile(f);
            }""")
            page.wait_for_function("() => window.__SSB_APP__.store.project.cells['0:0']?.mask?.strokes?.length === 3", timeout=5000)
            _, png_after = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            assert Image.open(io.BytesIO(png_before)).tobytes() == Image.open(io.BytesIO(png_after)).tobytes(), "PNG mismatch after V3 .ssb reopen!"

            # Test bad V3 manifest (out-of-bounds mask point) rejected WITHOUT replacing open session
            bad_v3_buf = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(ssb_v3_bytes), "r") as zin, zipfile.ZipFile(bad_v3_buf, "w") as zout:
                bad_m = json.loads(zin.read("manifest.json").decode("utf-8"))
                bad_m["cells"]["0:0"]["mask"]["strokes"][0]["points"][0] = [99999, 10]
                zout.writestr("manifest.json", json.dumps(bad_m))
                for info in zin.infolist():
                    if info.filename != "manifest.json":
                        zout.writestr(info.filename, zin.read(info.filename))
            tmp_bad = Path(tempfile.mktemp(suffix=".ssb"))
            tmp_bad.write_bytes(bad_v3_buf.getvalue())
            active_id_before = page.evaluate("() => window.__SSB_APP__.store.project.projectId")
            page.set_input_files("#file-open-project", str(tmp_bad))
            page.evaluate("""async () => {
                const f = document.getElementById('file-open-project').files[0];
                window.__SSB_APP__.openProjectFile(f);
            }""")
            page.wait_for_selector("#dialog-confirm[open]", timeout=5000)
            page.locator("#dialog-confirm button").click()
            assert page.evaluate("() => window.__SSB_APP__.store.project.projectId") == active_id_before
            assert page.evaluate("() => window.__SSB_APP__.store.project.cells['0:0'].mask.strokes.length") == 3

            # Test opening V2 .ssb works cleanly as unmasked
            tmp_v2 = Path(tempfile.mktemp(suffix=".ssb"))
            tmp_v2.write_bytes(ssb_v2_bytes)
            page.set_input_files("#file-open-project", str(tmp_v2))
            page.evaluate("""async () => {
                const f = document.getElementById('file-open-project').files[0];
                await window.__SSB_APP__.openProjectFile(f);
            }""")
            page.wait_for_function("() => !window.__SSB_APP__.store.project.cells['0:0'].mask", timeout=5000)

            tmp_v3.unlink(missing_ok=True)
            tmp_bad.unlink(missing_ok=True)
            tmp_v2.unlink(missing_ok=True)
            record("E06", True, f"V3 .ssb round-trip PNG pixel-exact; Recovery={rec_ok}; invalid V3 rejected preserving session; V2 opens unmasked")
        except Exception as e:
            record("E06", False, str(e))

        # ------------------------------------------------------------------
        # E07: Copy/Swap cell, Paste Transform (no mask), Replace image (no mask), Edit crop (source coords), Draft guard & pointercancel
        # ------------------------------------------------------------------
        try:
            import_and_slice_12_frames(page, 64, 64)
            # Erase a point at source (20, 20) in cell 0:0 and apply
            page.select_option("#ed-view-zoom", "2")
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "10")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")
            p20 = src_to_canvas_client(page, 20, 20)
            page.mouse.click(p20["x"], p20["y"])

            # Verify pointercancel does not leave brush stuck
            page.mouse.move(p20["x"], p20["y"])
            page.mouse.down()
            page.locator("#editor-canvas").dispatch_event("pointercancel")
            page.mouse.up()
            assert page.evaluate("() => window.__SSB_APP__.editorView.brushState === null"), "brushState stuck after pointercancel!"

            # Verify draft guard fires when trying to switch cell with unsaved eraser stroke
            page.evaluate("() => { window.__SSB_APP__.selectCellWithGuard(0, 1); }")
            page.wait_for_selector("#dialog-confirm[open]", timeout=5000)
            page.locator("#dialog-confirm").get_by_role("button", name="Áp dụng", exact=True).click()
            page.wait_for_function("() => window.__SSB_APP__.activeCellKey === '0:1' && Boolean(window.__SSB_APP__.store.project.cells['0:0'].mask)", timeout=5000)

            # 1. Copy cell 0:0 -> paste into cell 0:2 (carries mask!)
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                app.selectCell(0, 0);
                app.copySelectedCells();
                app.selectCell(0, 2);
                const p = app.pasteClipboard();
                // confirm overwrite modal
                setTimeout(() => {
                    const btn = document.querySelector('#dialog-confirm button.btn-primary');
                    if (btn) btn.click();
                }, 50);
                await p;
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.store.project.cells['0:2'].mask)", timeout=5000)

            # 2. Copy transform of 0:0 (zoom 1.2) -> paste transform onto 0:1 (must NOT paste mask!)
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const c0 = app.store.project.cells['0:0'];
                app.store.setCellTransform(0, 0, { ...c0, zoom: 1.2 });
                app.selectCell(0, 0);
                app.copyActiveTransform();
                app.selectCell(0, 1);
                await app.pasteClipboard();
            }""")
            c1_state = page.evaluate("() => ({ zoom: window.__SSB_APP__.store.project.cells['0:1'].zoom, hasMask: Boolean(window.__SSB_APP__.store.project.cells['0:1'].mask) })")
            assert c1_state["zoom"] == 1.2 and c1_state["hasMask"] is False, f"Paste transform leaked mask: {c1_state}"

            # 3. Swap 0:0 <-> 0:3 carries mask to 0:3
            page.evaluate("() => window.__SSB_APP__.store.moveOrSwapCell('0:0', '0:3', { copy: false })")
            assert page.evaluate("() => Boolean(window.__SSB_APP__.store.project.cells['0:3'].mask) && !window.__SSB_APP__.store.project.cells['0:0'].mask")

            # 4. Replace image in 0:2 starts with NO mask
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-single').files[0];
                const p = app.handleIncomingFiles([f], { targetCell: { row: 0, col: 2 }, directSingle: true });
                setTimeout(() => {
                    const btn = document.querySelector('#dialog-confirm button.btn-primary');
                    if (btn) btn.click();
                }, 80);
                await p;
            }""")
            page.wait_for_function("() => !window.__SSB_APP__.store.project.cells['0:2'].mask", timeout=5000)

            # 5. Edit crop region of f_0 (used in 0:3 at zoom=1.2 -> set zoom=1 first) shifts crop to x=10,y=10,w=44,h=44
            # Source stroke at (20,20) must now appear at local (10,10) inside 44x44 crop (NOT stretched!)
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                const c3 = app.store.project.cells['0:3'];
                app.store.setCellTransform(0, 3, { ...c3, zoom: 1, offsetX: 0, offsetY: 0 });
                app.store.updateAssetRegion('f_0', { x: 10, y: 10, w: 44, h: 44 }, { createNew: false });
            }""")
            _, frame3_png = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'frames', framesScope: 'selected-cells', selectedCells: ['0:3'], format: 'image/png' })"))
            _, px3 = load_rgba(frame3_png)
            # In 64x64 cell, 44x44 crop scales by 64/44 = 1.4545; local (10,10) -> output (14.5, 14.5); local (20,20) -> output (29, 29)
            assert px3[15, 15][3] == 0, f"Edited crop did not intersect source stroke at local (10,10)->out(15,15): {px3[15,15]}"
            assert px3[32, 32][3] == 255, f"Edited crop stretched/shifted stroke wrongly onto center (32,32): {px3[32,32]}"

            assert len(network_requests) == 0, f"Unexpected network requests: {network_requests}"
            assert len(page_errors) == 0, f"Unexpected page errors: {page_errors}"
            record("E07", True, "Copy/Swap carry mask; Paste Transform preserves no-mask; Replace clears mask; Crop edit intersects in source coords; draft guard & pointercancel clean; 0 network/page errors")
        except Exception as e:
            record("E07", False, str(e))

        # ------------------------------------------------------------------
        # E08 (PR2-P1): Multi-paste/duplicate budget guard + just-under-limit Save/Open/Recovery + 117,760-point compact manifest
        # ------------------------------------------------------------------
        try:
            reset_project(page, cols=20, rows=2, cw=64, ch=64)
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-single').files[0];
                await app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                const strokes500 = Array.from({ length: 500 }, (_, i) => ({
                    op: 'erase', radius: 2, points: [[i % 64, Math.floor(i / 64)]]
                }));
                app.store.setCellTransform(0, 0, { ...app.store.project.cells['0:0'], mask: { strokes: strokes500 } });
                app.selectCell(0, 0);
                app.copySelectedCells();
            }""")

            # 1. Paste 500-stroke cell into 16 other cells (total 8,500 > 8,192) -> rejected cleanly, state/history unchanged!
            over_res = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const revBefore = app.store.revision;
                const undoBefore = app.store.undoStack.length;
                app.selectRectRange(0, 1, 0, 16);
                await app.pasteClipboard();
                return {
                    revUnchanged: app.store.revision === revBefore,
                    undoUnchanged: app.store.undoStack.length === undoBefore,
                    cellCount: Object.keys(app.store.project.cells).length
                };
            }""")
            assert over_res == {"revUnchanged": True, "undoUnchanged": True, "cellCount": 1}, f"Over-limit paste mutated state: {over_res}"

            # 2. Paste into 15 other cells (total 8,000 <= 8,192) -> succeeds, Save/Open .ssb & Recovery all pass!
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                app.selectRectRange(0, 1, 0, 15);
                const p = app.pasteClipboard();
                setTimeout(() => {
                    const btn = document.querySelector('#dialog-confirm button.btn-primary');
                    if (btn) btn.click();
                }, 50);
                await p;
            }""")
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 16", timeout=5000)

            _, ssb_8000 = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.saveProject({ asCopy: false })"))
            rec_8000 = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                if (app.recovery.status !== 'available') return { skipped: true };
                const sv = await app.recovery.saveSnapshotNow(app.store.project, app.store.revision, app.assetManager);
                const snap = sv.ok ? await app.recovery.loadValidSnapshot() : null;
                return { ok: Boolean(sv.ok && snap && Object.keys(snap.project.cells).length === 16) };
            }""")
            assert rec_8000.get("skipped") or rec_8000.get("ok"), f"Recovery 8000 strokes failed: {rec_8000}"

            tmp_8000 = Path(tempfile.mktemp(suffix=".ssb"))
            tmp_8000.write_bytes(ssb_8000)
            reset_project(page, cols=4, rows=4, cw=64, ch=64)
            page.set_input_files("#file-open-project", str(tmp_8000))
            page.evaluate("async () => { await window.__SSB_APP__.openProjectFile(document.getElementById('file-open-project').files[0]); }")
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 16", timeout=5000)
            tmp_8000.unlink(missing_ok=True)

            # 3. Large valid manifest: 117,760 points (~1.89 MiB compact JSON) saves < 8 MiB, reopens, and passes Recovery!
            reset_project(page, cols=16, rows=1, cw=64, ch=64)
            page.set_input_files("#file-import-single", str(FIX / "t02_rect_400x200.png"))
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-single').files[0];
                await app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                const bigMask = {
                    strokes: Array.from({ length: 16 }, (_, s) => ({
                        op: 'erase', radius: 2,
                        points: Array.from({ length: 736 }, (_, p) => [(p * 3) % 64, (s * 4 + (p % 4)) % 64])
                    }))
                };
                const base = app.store.project.cells['0:0'];
                const updates = {};
                for (let c = 0; c < 10; c++) updates[`0:${c}`] = { ...base, mask: bigMask };
                const res = app.store.applyMultipleCellTransforms(updates, '117760pts');
                if (!res.committed) throw new Error('Big commit failed: ' + res.error);
            }""")
            _, ssb_big = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.saveProject({ asCopy: false })"))
            with zipfile.ZipFile(io.BytesIO(ssb_big), "r") as zf:
                m_bytes = zf.read("manifest.json")
                assert len(m_bytes) < 8 * 1024 * 1024, f"Compact manifest exceeded 8 MiB: {len(m_bytes)}"
            rec_big = page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                if (app.recovery.status !== 'available') return { skipped: true };
                const sv = await app.recovery.saveSnapshotNow(app.store.project, app.store.revision, app.assetManager);
                return { ok: sv.ok, err: sv.error || sv.reason || '' };
            }""")
            assert rec_big.get("skipped") or rec_big.get("ok"), f"Big manifest Recovery failed: {rec_big}"
            tmp_big = Path(tempfile.mktemp(suffix=".ssb"))
            tmp_big.write_bytes(ssb_big)
            reset_project(page, cols=4, rows=4, cw=64, ch=64)
            page.set_input_files("#file-open-project", str(tmp_big))
            page.evaluate("async () => { await window.__SSB_APP__.openProjectFile(document.getElementById('file-open-project').files[0]); }")
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 10", timeout=5000)
            tmp_big.unlink(missing_ok=True)
            record("E08", True, f"8500-stroke paste rejected safely; 8000-stroke paste + 117,760-pt manifest ({len(m_bytes)/1024/1024:.2f} MiB) Save/Open & Recovery PASS")
        except Exception as e:
            record("E08", False, str(e))

        # ------------------------------------------------------------------
        # E09 (PR2-P2): Edge brush accuracy (64x64 in 64x96 cell, click (32,8) r=10 -> ~2 rows, NOT 10) + 1px crop-expand stability
        # ------------------------------------------------------------------
        try:
            # 1. Create solid 64x64 opaque PNG and place in 64x96 cell (image occupies y=16..80)
            tmp_solid64 = Path(tempfile.mktemp(suffix="_solid64.png"))
            Image.new("RGBA", (64, 64), (255, 60, 60, 255)).save(tmp_solid64)
            reset_project(page, cols=1, rows=1, cw=64, ch=96)
            page.set_input_files("#file-import-single", str(tmp_solid64))
            page.evaluate("""async () => {
                const f = document.getElementById('file-import-single').files[0];
                await window.__SSB_APP__.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                window.__SSB_APP__.selectCell(0, 0);
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.editorView._pointerGeom && window.__SSB_APP__.assetManager.getAssetDrawableSync(window.__SSB_APP__.store.project.assets[0], window.__SSB_APP__.store.project.sources[0]))", timeout=5000)

            page.select_option("#ed-view-zoom", "2")
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "20")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")

            # Real mouse click at cell output coordinate (32, 8) -> source (32, -8)
            pt_cell_32_8 = page.evaluate("""() => {
                const ed = window.__SSB_APP__.editorView;
                ed.canvas.scrollIntoView({ block: 'center', inline: 'center' });
                const rect = ed.canvas.getBoundingClientRect();
                const bx = 32 * ed._renderDpr * ed.previewScale;
                const by = 8 * ed._renderDpr * ed.previewScale;
                return {
                    x: rect.left + bx * (rect.width / ed.canvas.width),
                    y: rect.top + by * (rect.height / ed.canvas.height)
                };
            }""")
            page.mouse.click(pt_cell_32_8["x"], pt_cell_32_8["y"])
            page.click("#btn-draft-apply")

            _, png_edge = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px_edge = load_rgba(png_edge)
            # Only y=16, 17 should be erased at x=32; y=18..25 MUST stay solid (alpha=255)!
            erased_rows = [y for y in range(16, 80) if px_edge[32, y][3] == 0]
            assert erased_rows == [16, 17], f"Expected ONLY rows [16, 17] erased at x=32, got {erased_rows}"
            assert px_edge[32, 18][3] == 255 and px_edge[32, 24][3] == 255
            tmp_solid64.unlink(missing_ok=True)

            # 2. 1px brush on rightmost pixel (x=63) of 64x64 crop inside 128x64 source -> expand crop to 80x64 -> stays at x=63!
            tmp_solid128 = Path(tempfile.mktemp(suffix="_solid128.png"))
            Image.new("RGBA", (128, 64), (40, 180, 255, 255)).save(tmp_solid128)
            reset_project(page, cols=1, rows=1, cw=64, ch=64)
            page.set_input_files("#file-import-images", str(tmp_solid128))
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-images').files[0];
                await app.handleIncomingFiles([f], { libraryOnly: true });
                const src = app.store.project.sources[0];
                app.store.addSourcesAndAssets('crop64', [], [
                    { id: 'a_edge1px', sourceId: src.id, name: 'crop64', isRegion: true, region: { x: 0, y: 0, w: 64, h: 64 } }
                ], [{ row: 0, col: 0, assetId: 'a_edge1px' }]);
                app.selectCell(0, 0);
            }""")
            page.wait_for_function("() => Boolean(window.__SSB_APP__.editorView._pointerGeom && window.__SSB_APP__.assetManager.getAssetDrawableSync(window.__SSB_APP__.store.getAsset('a_edge1px'), window.__SSB_APP__.store.project.sources[0]))", timeout=5000)

            page.select_option("#ed-view-zoom", "2")
            page.click("#btn-ed-tool-erase")
            page.fill("#ed-brush-size-num", "1")
            page.locator("#ed-brush-size-num").dispatch_event("change")
            page.evaluate("() => window.__SSB_APP__.editorView.render()")

            # Click right inside rightmost pixel 63 (x=63.6, y=32.5)
            pt_r63 = src_to_canvas_client(page, 63.6, 32.5)
            page.mouse.click(pt_r63["x"], pt_r63["y"])
            page.click("#btn-draft-apply")

            # Expand crop to (0, 0, 80, 64) and cell to 80x64 (1:1 scale)
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.store.applyGridChange({ cols: 1, rows: 1, cellWidth: 80, cellHeight: 64 });
                app.store.updateAssetRegion('a_edge1px', { x: 0, y: 0, w: 80, h: 64 }, { createNew: false });
            }""")
            _, png_exp = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, px_exp = load_rgba(png_exp)
            assert px_exp[63, 32][3] == 0, f"1px erase jumped away from x=63: {px_exp[63, 32]}"
            assert px_exp[64, 32][3] == 255, f"1px erase jumped into x=64: {px_exp[64, 32]}"
            assert px_exp[62, 32][3] == 255
            tmp_solid128.unlink(missing_ok=True)
            record("E09", True, "Real-mouse edge click (32,8) r=10 erased ONLY rows [16,17]; 1px brush stayed locked at source x=63 after crop expand 64->80")
        except Exception as e:
            record("E09", False, str(e))

        # ------------------------------------------------------------------
        # E10 (PR2-P2): Clipped cell bounds match exported PNG exactly (offsetX=+24 -> w=40) & V1 metadata matches base schema
        # ------------------------------------------------------------------
        try:
            tmp_solid = Path(tempfile.mktemp(suffix="_clip64.png"))
            Image.new("RGBA", (64, 64), (100, 220, 120, 255)).save(tmp_solid)
            reset_project(page, cols=1, rows=1, cw=64, ch=64)
            page.set_input_files("#file-import-single", str(tmp_solid))
            page.evaluate("""async () => {
                const app = window.__SSB_APP__;
                const f = document.getElementById('file-import-single').files[0];
                await app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                app.store.setCellTransform(0, 0, { ...app.store.project.cells['0:0'], offsetX: 24, offsetY: 0 });
            }""")
            _, png_clip = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"))
            _, json_v1_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'json' })"))
            _, json_v2_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'json', includeContentBounds: true })"))

            im_c, _ = load_rgba(png_clip)
            bb = im_c.getbbox()
            assert bb == (24, 0, 64, 64), f"Expected PNG bbox (24,0,64,64), got {bb}"

            # Validate V1 output strictly against base schemas/atlas-v1.schema.json (top-level, atlas, frames, anchorCellPx)
            v1 = json.loads(json_v1_b.decode("utf-8"))
            v1_schema = json.loads((ROOT / "schemas" / "atlas-v1.schema.json").read_text(encoding="utf-8"))
            assert set(v1.keys()) == set(v1_schema["required"]) and set(v1.keys()).issubset(set(v1_schema["properties"].keys())), f"Top-level V1 keys mismatch: {set(v1.keys())}"
            assert set(v1["atlas"].keys()).issubset(set(v1_schema["properties"]["atlas"]["properties"].keys())), f"Atlas V1 keys mismatch: {set(v1['atlas'].keys())}"
            allowed_v1_frame_keys = set(v1_schema["properties"]["frames"]["items"]["properties"].keys())
            assert v1["schemaVersion"] == 1
            assert set(v1["frames"][0].keys()).issubset(allowed_v1_frame_keys), f"Unexpected V1 keys: {set(v1['frames'][0].keys()) - allowed_v1_frame_keys}"
            assert "contentBoundsCellPx" not in v1["frames"][0]
            if v1["frames"][0]["anchorCellPx"] is not None:
                assert set(v1["frames"][0]["anchorCellPx"].keys()) == {"x", "y"}

            # Validate V2 output matches exact clipped PNG bbox (x=24, y=0, w=40, h=64)
            v2 = json.loads(json_v2_b.decode("utf-8"))
            assert v2["schemaVersion"] == 2
            assert v2["frames"][0]["contentBoundsCellPx"] == {"x": 24, "y": 0, "w": 40, "h": 64}, f"Clipped bounds mismatch: {v2['frames'][0]}"

            # Completely off-cell offsetX=100 -> PNG empty & V2 contentBoundsCellPx is null
            page.evaluate("() => { const app = window.__SSB_APP__; app.store.setCellTransform(0, 0, { ...app.store.project.cells['0:0'], offsetX: 100 }); }")
            _, json_off_b = download_bytes(lambda: page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'json', includeContentBounds: true })"))
            v2_off = json.loads(json_off_b.decode("utf-8"))
            assert v2_off["frames"][0]["contentBoundsCellPx"] is None, f"Off-cell bounds must be null: {v2_off['frames'][0]}"
            tmp_solid.unlink(missing_ok=True)
            record("E10", True, "Offset +24px in 64px cell -> PNG bbox (24,0,40,64) == JSON V2 contentBoundsCellPx; off-cell -> null; JSON V1 strictly matches base atlas-v1 schema")
        except Exception as e:
            record("E10", False, str(e))

        # E11: The final endpoint must survive the move-point threshold.
        try:
            with tempfile.TemporaryDirectory(prefix="ssb_short_stroke_") as temp_dir:
                solid = Path(temp_dir) / "solid200.png"
                Image.new("RGBA", (200, 200), (255, 60, 60, 255)).save(solid)
                reset_project(page, cols=1, rows=1, cw=200, ch=200)
                page.set_input_files("#file-import-single", str(solid))
                page.evaluate("""async () => {
                    const app = window.__SSB_APP__;
                    const f = document.getElementById('file-import-single').files[0];
                    await app.handleIncomingFiles([f], { targetCell: { row: 0, col: 0 }, directSingle: true });
                    app.selectCell(0, 0);
                }""")
                page.wait_for_function("""() => {
                    const app = window.__SSB_APP__;
                    return Boolean(app.editorView._pointerGeom && app.assetManager.getAssetDrawableSync(
                        app.store.project.assets[0], app.store.project.sources[0]));
                }""", timeout=5000)
                page.select_option("#ed-view-zoom", "1")
                page.click("#btn-ed-tool-erase")
                page.fill("#ed-brush-size-num", "128")
                page.locator("#ed-brush-size-num").dispatch_event("change")
                page.evaluate("() => window.__SSB_APP__.editorView.render()")

                start = src_to_canvas_client(page, 90, 90)
                end = src_to_canvas_client(page, 95, 90)
                page.mouse.move(start["x"], start["y"])
                page.mouse.down()
                page.mouse.move(end["x"], end["y"])
                page.mouse.up()
                page.click("#btn-draft-apply")
                _, png = download_bytes(lambda: page.evaluate(
                    "() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })"
                ))
                _, pixels = load_rgba(png)
                assert pixels[153, 90][3] == 0, "The start of the short stroke should be erased"
                assert pixels[156, 90][3] == 0, "The final 5px movement must erase past the start circle"
                assert pixels[160, 90][3] == 255, "The brush must not extend past the release circle"
            record("E11", True, "128px brush dragged 5 source pixels preserves the endpoint in exported PNG")
        except Exception as e:
            record("E11", False, str(e))

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
        print(f"\n=== Running Eraser E2E Suite (E01–E11) on Windows 11 {name} ===", flush=True)
        rep = run_eraser_suite_for_browser(name, exe)
        all_reports.append(rep)
        fails = [k for k, v in rep["results"].items() if v["status"] != "PASS"]
        total_fail += len(fails)
        print(f"=== {name} Eraser Summary: {len(rep['results']) - len(fails)}/{len(rep['results'])} PASS, network_reqs={len(rep['network_requests'])}, page_errors={len(rep['page_errors'])} ===")

    out_json = ROOT / "tests" / "e2e" / "eraser_e2e_results.json"
    out_json.write_text(json.dumps(all_reports, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved eraser E2E results to {out_json}")
    sys.exit(1 if total_fail > 0 else 0)


if __name__ == "__main__":
    main()
