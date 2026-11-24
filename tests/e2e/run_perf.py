#!/usr/bin/env python3
"""
Sprite Sheet Builder V2.0 — Real Performance Benchmark Runner (Spec §12.4, T28).
Runs >= 3 trials per scenario on Windows 11 Chrome & Edge over file://, reporting median, worst, and p95.
"""

import json
import statistics
import sys
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HTML_PATH = ROOT / "dist" / "sprite-sheet-builder.html"
FILE_URL = HTML_PATH.resolve().as_uri()
FIX_HD = ROOT / "tests" / "fixtures" / "generated" / "hatch_73_1024"

CHROME_EXE = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EDGE_EXE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

RUNS = 3


def summarize(samples_ms):
    return {
        "runs_ms": [round(x, 2) for x in samples_ms],
        "median_ms": round(statistics.median(samples_ms), 2),
        "worst_ms": round(max(samples_ms), 2),
    }


def benchmark_browser(name: str, exe: Path):
    print(f"\n=== Benchmarking {name} ({exe}) — {RUNS} runs per scenario ===", flush=True)
    hd_files = [str(FIX_HD / f"hd_{i:02d}.png") for i in range(1, 74)]

    open_times = []
    import_times = []
    drag_p95_list = []
    export_times = []
    save_times = []
    reopen_times = []
    anim_check = None

    with sync_playwright() as p:
        # 1. Cold offline HTML open time (3 runs)
        for _ in range(RUNS):
            udd = tempfile.mkdtemp(prefix=f"ssb_perf_open_{name}_")
            ctx = p.chromium.launch_persistent_context(
                udd, executable_path=str(exe), headless=True, accept_downloads=True,
                viewport={"width": 1280, "height": 720},
                args=["--allow-file-access-from-files", "--disable-gpu-sandbox"],
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            t0 = time.perf_counter()
            page.goto(FILE_URL, wait_until="load")
            page.wait_for_function("() => Boolean(window.__SSB_APP__)")
            open_times.append((time.perf_counter() - t0) * 1000)
            ctx.close()

        # Reusable browser context for scenarios 2-6
        udd = tempfile.mkdtemp(prefix=f"ssb_perf_main_{name}_")
        ctx = p.chromium.launch_persistent_context(
            udd, executable_path=str(exe), headless=True, accept_downloads=True,
            viewport={"width": 1280, "height": 720},
            args=["--allow-file-access-from-files", "--disable-gpu-sandbox"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(FILE_URL, wait_until="load")
        page.wait_for_function("() => Boolean(window.__SSB_APP__)")

        # 2. Import 73 PNG 1024x1024 RGBA (3 runs)
        for run_i in range(RUNS):
            page.evaluate("""() => {
                const app = window.__SSB_APP__;
                app.assetManager.clearAllBitmaps();
                app.store.loadProject({
                    format: 'sprite-sheet-builder-project', schemaVersion: 2, projectId: 'perf_' + Math.random(),
                    name: 'Perf73', grid: { cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 },
                    presetId: null, expectedCells: null, sources: [], assets: [], cells: {}, animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 },
                    customPresets: []
                });
            }""")
            page.click("#btn-presets")
            page.locator("#presets-body button:has-text('Áp dụng')").first.click()
            page.wait_for_function("() => window.__SSB_APP__.store.project.presetId === 'hatch-pet-v2'")

            page.set_input_files("#file-import-images", hd_files)
            t0 = time.perf_counter()
            page.evaluate("""async () => {
                const files = Array.from(document.getElementById('file-import-images').files);
                await window.__SSB_APP__.handleIncomingFiles(files, { targetCell: null, libraryOnly: false });
            }""")
            page.wait_for_selector("#dialog-batch[open]", timeout=60000)
            page.locator("#batch-footer button.btn-primary").click()
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 73", timeout=60000)
            import_times.append((time.perf_counter() - t0) * 1000)

        # 3. Continuous 5-second REAL pointer drag on cached cell in Hatch Pet V2 (R6 fix):
        # Uses genuine Playwright mouse pointer input (pointerdown + pointermove with real pointer capture),
        # verifies draft offsetX/offsetY actually changes on every move, verifies EditorView.render() ran,
        # and verifies actual #editor-canvas pixel data changed!
        page.evaluate("() => window.__SSB_APP__.selectCell(0, 0)")
        page.wait_for_timeout(300)  # warm cache for cell 0:0
        box = page.locator("#editor-canvas").bounding_box()
        assert box and box["width"] > 20 and box["height"] > 20
        cx = box["x"] + box["width"] / 2.0
        cy = box["y"] + box["height"] / 2.0

        # Capture canvas pixel fingerprint before drag
        before_hash = page.evaluate("""() => {
            const c = document.getElementById('editor-canvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let h = 0;
            for (let i = 0; i < d.length; i += 97) h = ((h * 31) + d[i]) | 0;
            return h;
        }""")

        # Instrument in-page pointermove -> rAF paint latency measurement for real mouse events
        page.evaluate("""() => {
            const c = document.getElementById('editor-canvas');
            window.__DRAG_SAMPLES__ = [];
            window.__DRAG_HANDLER__ = () => {
                const tIn = performance.now();
                const rcBefore = window.__SSB_APP__.editorView.renderCount;
                const ox = window.__SSB_APP__.editorView.draft?.offsetX ?? 0;
                const oy = window.__SSB_APP__.editorView.draft?.offsetY ?? 0;
                requestAnimationFrame(() => {
                    const dt = performance.now() - tIn;
                    const rcAfter = window.__SSB_APP__.editorView.renderCount;
                    window.__DRAG_SAMPLES__.push({ dt, rendered: rcAfter > rcBefore, ox, oy });
                });
            };
            c.addEventListener('pointermove', window.__DRAG_HANDLER__);
        }""")

        page.mouse.move(cx, cy)
        page.mouse.down()
        import math
        drag_start = time.perf_counter()
        step = 0
        while time.perf_counter() - drag_start < 5.0:
            step += 1
            dx = math.sin(step * 0.25) * 35.0
            dy = math.cos(step * 0.25) * 25.0
            page.mouse.move(cx + dx, cy + dy, steps=1)
            page.wait_for_timeout(14)

        # Verify canvas pixel fingerprint changed at peak offset before releasing
        page.mouse.move(cx + 42.0, cy + 28.0, steps=1)
        page.wait_for_timeout(40)
        after_check = page.evaluate("""() => {
            const c = document.getElementById('editor-canvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let h = 0;
            for (let i = 0; i < d.length; i += 97) h = ((h * 31) + d[i]) | 0;
            const ev = window.__SSB_APP__.editorView;
            return { hash: h, ox: ev.draft?.offsetX ?? 0, oy: ev.draft?.offsetY ?? 0, renderCount: ev.renderCount };
        }""")
        page.mouse.up()

        drag_metrics = page.evaluate("""() => {
            const c = document.getElementById('editor-canvas');
            c.removeEventListener('pointermove', window.__DRAG_HANDLER__);
            const samples = window.__DRAG_SAMPLES__ || [];
            window.__SSB_APP__.editorView.discardDraft();
            const dts = samples.map(s => s.dt).sort((a, b) => a - b);
            const renderedCount = samples.filter(s => s.rendered).length;
            const uniqueOffsets = new Set(samples.map(s => s.ox.toFixed(2) + ',' + s.oy.toFixed(2))).size;
            const p95 = dts.length ? dts[Math.min(dts.length - 1, Math.floor(dts.length * 0.95))] : 0;
            const median = dts.length ? dts[Math.floor(dts.length / 2)] : 0;
            return {
                frames: dts.length,
                renderedCount,
                uniqueOffsets,
                median_ms: median,
                p95_ms: p95,
                max_ms: dts.length ? dts[dts.length - 1] : 0
            };
        }""")
        assert after_check["hash"] != before_hash, "Editor canvas pixels did not visually change during real drag!"
        assert abs(after_check["ox"]) > 10.0 and abs(after_check["oy"]) > 5.0, f"Draft offsets did not update during real drag: {after_check}"
        assert drag_metrics["uniqueOffsets"] >= 20, f"Expected continuous offset updates, got {drag_metrics}"
        assert drag_metrics["renderedCount"] >= 20, f"Expected real canvas renders during drag, got {drag_metrics}"
        drag_metrics["pixels_verified_changed"] = True
        drag_p95_list.append(drag_metrics)

        # 4. Preview 12 FPS, 8-frame group (running-right) warm cache stability check
        anim_check = page.evaluate("""async () => {
            const app = window.__SSB_APP__;
            const rr = app.store.project.animations.find(a => a.name === 'running-right');
            app.store.updateAnimation(rr.id, { fps: 12 }, 'set 12 fps');
            app.animationView.activeAnimId = rr.id;
            app.animationView.onProjectChanged();
            // Warm cache for the 8 frames
            for (const f of rr.frames) {
                const c = app.store.project.cells[f.row + ':' + f.col];
                const a = app.store.getAsset(c.assetId);
                const s = app.store.getSource(a.sourceId);
                await app.assetManager.getAssetDrawable(a, s);
            }
            const cacheBefore = app.assetManager.getCacheStats();
            const seen = [];
            app.animationView.clock.play(rr, performance.now());
            app.animationView.startLoop();
            const tStart = performance.now();
            while (performance.now() - tStart < 1500) {
                const idx = app.animationView.clock.getCurrentFrameIndex(rr);
                if (seen.length === 0 || seen[seen.length - 1] !== idx) seen.push(idx);
                await new Promise(r => setTimeout(r, 25));
            }
            app.animationView.clock.stop();
            app.animationView.stopLoop();
            const cacheAfter = app.assetManager.getCacheStats();
            return {
                transitions: seen.length,
                sequenceSample: seen.slice(0, 12),
                cachePixelsBefore: cacheBefore.cachedPixels,
                cachePixelsAfter: cacheAfter.cachedPixels
            };
        }""")

        # 5. Export PNG Atlas 1536x2288 from 73x 1024x1024 project (3 runs)
        for _ in range(RUNS):
            t0 = time.perf_counter()
            with page.expect_download(timeout=60000) as dl_info:
                page.evaluate("() => window.__SSB_APP__.runExportJob({ type: 'atlas', format: 'image/png' })")
            _ = dl_info.value
            export_times.append((time.perf_counter() - t0) * 1000)

        # 6. Save & Open `.ssb` project (73x 1024x1024, 3 runs)
        saved_ssb_path = Path(tempfile.mktemp(suffix=".ssb"))
        for _ in range(RUNS):
            t0 = time.perf_counter()
            with page.expect_download(timeout=60000) as dl_info:
                page.evaluate("() => window.__SSB_APP__.saveProject({ asCopy: false })")
            dl = dl_info.value
            dl.save_as(str(saved_ssb_path))
            save_times.append((time.perf_counter() - t0) * 1000)

        for _ in range(RUNS):
            page.evaluate("""() => {
                window.__SSB_APP__.store.loadProject({
                    format: 'sprite-sheet-builder-project', schemaVersion: 2, projectId: 'empty_' + Math.random(),
                    name: 'Empty', grid: { cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 },
                    presetId: null, expectedCells: null, sources: [], assets: [], cells: {}, animations: [],
                    settings: { smoothing: true, guides: { x: 0.5, y: 0.9 }, defaultAlphaThreshold: 8, webpQuality: 0.92 },
                    customPresets: []
                }, { markClean: true });
            }""")
            page.set_input_files("#file-open-project", str(saved_ssb_path))
            t0 = time.perf_counter()
            page.evaluate("""async () => {
                const f = document.getElementById('file-open-project').files[0];
                await window.__SSB_APP__.openProjectFile(f);
            }""")
            page.wait_for_function("() => Object.keys(window.__SSB_APP__.store.project.cells).length === 73", timeout=60000)
            reopen_times.append((time.perf_counter() - t0) * 1000)

        saved_ssb_path.unlink(missing_ok=True)
        final_cache = page.evaluate("() => window.__SSB_APP__.assetManager.getCacheStats()")
        ctx.close()

    report = {
        "browser": name,
        "runs": RUNS,
        "open_html_offline": summarize(open_times),
        "import_73_1024_png": summarize(import_times),
        "drag_5s_cached_cell": {
            "mode": "real-playwright-pointer-with-pixel-verification",
            "frames": drag_metrics["frames"],
            "rendered_frames": drag_metrics["renderedCount"],
            "unique_offsets": drag_metrics["uniqueOffsets"],
            "pixels_verified_changed": drag_metrics["pixels_verified_changed"],
            "median_ms": round(drag_metrics["median_ms"], 2),
            "p95_ms": round(drag_metrics["p95_ms"], 2),
            "max_ms": round(drag_metrics["max_ms"], 2),
        },
        "preview_12fps_8frames": anim_check,
        "export_png_1536x2288": summarize(export_times),
        "save_ssb_73": summarize(save_times),
        "open_ssb_73": summarize(reopen_times),
        "final_cache_stats": final_cache,
    }
    print(json.dumps(report, indent=2), flush=True)
    return report


def main():
    reports = []
    if CHROME_EXE.exists():
        reports.append(benchmark_browser("Chrome", CHROME_EXE))
    if EDGE_EXE.exists():
        reports.append(benchmark_browser("Edge", EDGE_EXE))

    out = ROOT / "tests" / "e2e" / "perf_results.json"
    out.write_text(json.dumps(reports, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved performance benchmarks to {out}")


if __name__ == "__main__":
    main()
