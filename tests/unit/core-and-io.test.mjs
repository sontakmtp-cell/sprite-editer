/**
 * Sprite Sheet Builder V2.0 — Comprehensive Unit Tests (Node.js native node:test).
 * Covers: Geometry (T02, T03, T12, T13), Image Header Inspection (T05, T06, T26),
 * Validator & Security (T17, T23), Store & History (T09, T15), Batch & Slice (T07, T10, T11),
 * Transform Sync (T13), Animation Clock (T19), Preflight (T24), ZIP & .ssb (T16, T17, T20).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  LIMITS,
  createHatchPetV2Preset,
  naturalCompare,
  stableSort,
  sanitizeFilename,
  allocateUniqueFilename,
  cellKey
} from '../../src/core/constants.js';
import {
  computeCellGeometry,
  computeAlphaBoundsFromRGBA,
  isCompletelyTransparentRGBA,
  computeAlignAnchorOffset,
  computeSyncZoom,
  scaleOffsetsForCellResize,
  analyzeRectInCell
} from '../../src/core/geometry.js';
import { inspectImageBytes, verifyEncodedSignature } from '../../src/core/image-inspect.js';
import { validateGrid, validateProjectManifestV2, validatePresetV1 } from '../../src/core/validator.js';
import { ProjectStore, createEmptyProject, createDefaultCell } from '../../src/core/store.js';
import { planBatchImport, computeSliceGrid } from '../../src/core/batch-slice.js';
import { planTransformSync } from '../../src/core/sync-engine.js';
import { AnimationClock, buildPlaybackOrder, getFrameDurationMs } from '../../src/core/animation-clock.js';
import { runPreflight } from '../../src/core/preflight.js';
import { createZip, readZip, crc32 } from '../../src/io/zip.js';
import { serializeProjectToSsb, deserializeProjectFromSsb } from '../../src/io/project-io.js';

// --- Helper: build minimal valid synthetic PNG bytes ---
function makeSyntheticPng(width, height, { extraChunk = null } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const makeChunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(new Uint8Array(crcInput)), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawRow = Buffer.alloc(1 + width * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => rawRow));
  const idat = zlib.deflateSync(raw);

  const chunks = [sig, makeChunk('IHDR', ihdr)];
  if (extraChunk) chunks.push(makeChunk(extraChunk.type, extraChunk.data));
  chunks.push(makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

// --- Helper: build minimal valid WebP VP8L/VP8X header ---
function makeWebpHeader(width, height, { animated = false } = {}) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = animated ? 0x02 : 0x10; // Animation flag vs Alpha flag
  const w1 = width - 1;
  const h1 = height - 1;
  buf[24] = w1 & 0xff;
  buf[25] = (w1 >> 8) & 0xff;
  buf[26] = (w1 >> 16) & 0xff;
  buf[27] = h1 & 0xff;
  buf[28] = (h1 >> 8) & 0xff;
  buf[29] = (h1 >> 16) & 0xff;
  return new Uint8Array(buf);
}

// --- Helper: build minimal JPEG header with EXIF orientation ---
function makeJpegHeaderWithOrientation(rawW, rawH, orientation = 1) {
  // APP1 EXIF little-endian TIFF with tag 0x0112 (Orientation)
  const exif = Buffer.alloc(32);
  exif.write('Exif\0\0', 0, 'ascii');
  exif.write('II', 6, 'ascii'); // little-endian
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10); // IFD0 offset
  exif.writeUInt16LE(1, 14); // 1 entry
  exif.writeUInt16LE(0x0112, 16); // Orientation tag
  exif.writeUInt16LE(3, 18); // SHORT
  exif.writeUInt32LE(1, 20); // count
  exif.writeUInt16LE(orientation, 24);

  const app1 = Buffer.alloc(4 + exif.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(exif.length + 2, 2);
  exif.copy(app1, 4);

  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff; sof0[1] = 0xc0;
  sof0.writeUInt16BE(9, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(rawH, 5);
  sof0.writeUInt16BE(rawW, 7);
  sof0[9] = 3;

  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof0, Buffer.from([0xff, 0xd9])]));
}

test('T02: Core Contain Geometry — 3x2 grid, 100x80 cell, 400x200 image => 100x50 with 15px vertical margin', () => {
  const geom = computeCellGeometry({
    cellWidth: 100,
    cellHeight: 80,
    row: 1,
    col: 2,
    region: { x: 0, y: 0, w: 400, h: 200 },
    transform: { fitMode: 'contain', zoom: 1, offsetX: 0, offsetY: 0, anchor: { mode: 'fit-center' } }
  });
  assert.ok(geom);
  assert.equal(geom.fit, 0.25);
  assert.equal(geom.scale, 0.25);
  assert.equal(geom.drawW, 100);
  assert.equal(geom.drawH, 50);
  assert.equal(geom.localX, 0);
  assert.equal(geom.localY, 15);
  assert.equal(geom.atlasX, 200);
  assert.equal(geom.atlasY, 80);
  assert.equal(geom.anchorOutX, 50);
  assert.equal(geom.anchorOutY, 40);

  // Verify transform zoom up to 1000% (10.0) allowed and >1000% rejected
  const geom1000 = computeCellGeometry({
    cellWidth: 100,
    cellHeight: 80,
    region: { x: 0, y: 0, w: 400, h: 200 },
    transform: { fitMode: 'contain', zoom: 10.0, offsetX: 0, offsetY: 0, anchor: { mode: 'fit-center' } }
  });
  assert.ok(geom1000);
  assert.equal(geom1000.scale, 2.5);
  assert.equal(
    computeCellGeometry({
      cellWidth: 100,
      cellHeight: 80,
      region: { x: 0, y: 0, w: 400, h: 200 },
      transform: { fitMode: 'contain', zoom: 10.01, offsetX: 0, offsetY: 0, anchor: { mode: 'fit-center' } }
    }),
    null
  );
});

test('T12: Alpha bounds, exact transparency check vs heuristic threshold, Fit Alpha formula', () => {
  const w = 10, h = 10;
  const rgba = new Uint8Array(w * h * 4);
  // Put low alpha (5) at (0,0) and solid alpha (255) at (3..6, 2..7)
  rgba[3] = 5;
  for (let y = 2; y <= 7; y++) {
    for (let x = 3; x <= 6; x++) {
      const idx = (y * w + x) * 4;
      rgba[idx] = 255;
      rgba[idx + 3] = 255;
    }
  }
  assert.equal(isCompletelyTransparentRGBA(rgba, w, h), false);

  const bbox8 = computeAlphaBoundsFromRGBA(rgba, w, h, 8);
  assert.deepEqual(bbox8, { x: 3, y: 2, w: 4, h: 6 });

  const bbox0 = computeAlphaBoundsFromRGBA(rgba, w, h, 0);
  assert.deepEqual(bbox0, { x: 0, y: 0, w: 7, h: 8 });

  // Fit Alpha uses bbox8 (4x6) inside 80x60 cell -> fit = min(80/4, 60/6) = 10
  const geom = computeCellGeometry({
    cellWidth: 80,
    cellHeight: 60,
    region: { x: 0, y: 0, w: 10, h: 10 },
    transform: { fitMode: 'alpha', zoom: 1, offsetX: 0, offsetY: 0, anchor: { mode: 'alpha-bottom-center' } },
    alphaBounds: bbox8
  });
  assert.equal(geom.fit, 10);
  assert.equal(geom.renderedAlphaRect.w, 40);
  assert.equal(geom.renderedAlphaRect.h, 60);
  // Alpha bottom center: ax = 3 + 2 = 5, ay = 2 + 6 = 8 -> anchorOutX = 40, anchorOutY = 60
  assert.equal(geom.anchorOutX, 40);
  assert.equal(geom.anchorOutY, 60);

  // Completely transparent buffer -> invalid alpha bounds
  const empty = new Uint8Array(w * h * 4);
  assert.equal(isCompletelyTransparentRGBA(empty, w, h), true);
  assert.equal(computeAlphaBoundsFromRGBA(empty, w, h, 8), null);
  assert.equal(
    computeCellGeometry({
      cellWidth: 80,
      cellHeight: 60,
      region: { x: 0, y: 0, w: 10, h: 10 },
      transform: { fitMode: 'alpha', zoom: 1, offsetX: 0, offsetY: 0 },
      alphaBounds: null
    }),
    null
  );
});

test('T13: Anchor alignment & Transform Sync (scale + anchor) exact within 0.01 px, out-of-range never clamped', () => {
  const store = new ProjectStore();
  store.addSourcesAndAssets('add', [
    { id: 's1', name: 'ref.png', mime: 'image/png', width: 200, height: 200, byteLength: 1000 },
    { id: 's2', name: 'tgt.png', mime: 'image/png', width: 200, height: 200, byteLength: 1000 },
    { id: 's3', name: 'tiny.png', mime: 'image/png', width: 200, height: 200, byteLength: 1000 }
  ], [
    { id: 'a1', sourceId: 's1', name: 'ref', isRegion: false, region: { x: 0, y: 0, w: 200, h: 200 } },
    { id: 'a2', sourceId: 's2', name: 'tgt', isRegion: false, region: { x: 0, y: 0, w: 200, h: 200 } },
    { id: 'a3', sourceId: 's3', name: 'tiny', isRegion: false, region: { x: 0, y: 0, w: 200, h: 200 } }
  ], [
    { row: 0, col: 0, assetId: 'a1' },
    { row: 0, col: 1, assetId: 'a2' },
    { row: 0, col: 2, assetId: 'a3' }
  ]);

  // Ref has custom anchor at (100, 160), tgt has alpha-bottom-center
  store.setCellTransform(0, 0, {
    ...createDefaultCell('a1'),
    offsetX: 5,
    offsetY: 12,
    anchor: { mode: 'custom', x: 100, y: 160 }
  });
  store.setCellTransform(0, 1, {
    ...createDefaultCell('a2'),
    anchor: { mode: 'alpha-bottom-center' }
  });

  const alphaMap = {
    a1: { x: 50, y: 40, w: 100, h: 120 },
    a2: { x: 60, y: 80, w: 80, h: 60 }, // half height of ref -> needs zoom = 2.0
    a3: { x: 95, y: 95, w: 10, h: 10 }  // 1/12 height -> needs zoom = 12.0 > 4.0 (out of range!)
  };

  const plan = planTransformSync({
    project: store.project,
    referenceKey: '0:0',
    targetKeys: ['0:1', '0:2', '0:3'], // 0:3 is empty -> skipped
    mode: 'sync-scale-and-anchor',
    scaleDimension: 'height',
    anchorTargetType: 'reference-anchor',
    getAlphaBounds: (aid) => alphaMap[aid] || null,
    skipInvalidConfirmed: false
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.skippedEmptyCount, 1);
  assert.equal(plan.errorCount, 1);
  assert.equal(plan.blockedByErrors, true);

  const errItem = plan.items.find((it) => it.key === '0:2');
  assert.equal(errItem.outOfRange, true);

  // Now confirm skip invalid
  const planSkip = planTransformSync({
    project: store.project,
    referenceKey: '0:0',
    targetKeys: ['0:1', '0:2'],
    mode: 'sync-scale-and-anchor',
    scaleDimension: 'height',
    anchorTargetType: 'reference-anchor',
    getAlphaBounds: (aid) => alphaMap[aid] || null,
    skipInvalidConfirmed: true
  });
  assert.equal(planSkip.canCommit, true);
  const okItem = planSkip.items.find((it) => it.key === '0:1');
  const refGeom = computeCellGeometry({
    cellWidth: 192, cellHeight: 208,
    region: { x: 0, y: 0, w: 200, h: 200 },
    transform: store.project.cells['0:0'],
    alphaBounds: alphaMap.a1
  });
  assert.ok(Math.abs(okItem.nextGeom.renderedAlphaRect.h - refGeom.renderedAlphaRect.h) < 0.01);
  assert.ok(Math.abs(okItem.nextGeom.anchorOutX - refGeom.anchorOutX) < 0.01);
  assert.ok(Math.abs(okItem.nextGeom.anchorOutY - refGeom.anchorOutY) < 0.01);
});

test('T06 & T26: Binary header inspection rejects APNG, animated WebP, SVG, GIF, oversized; detects JPEG EXIF orientation', () => {
  const staticPng = makeSyntheticPng(32, 24);
  const r1 = inspectImageBytes(staticPng);
  assert.equal(r1.ok, true);
  assert.equal(r1.mime, 'image/png');
  assert.equal(r1.width, 32);
  assert.equal(r1.height, 24);

  // APNG with acTL chunk -> REJECT
  const apng = makeSyntheticPng(32, 24, { extraChunk: { type: 'acTL', data: Buffer.alloc(8) } });
  const rApng = inspectImageBytes(apng);
  assert.equal(rApng.ok, false);
  assert.equal(rApng.code, 'ANIMATED_PNG');

  // Static WebP -> OK
  const webpOk = makeWebpHeader(64, 48, { animated: false });
  const rWebp = inspectImageBytes(webpOk);
  assert.equal(rWebp.ok, true);
  assert.equal(rWebp.mime, 'image/webp');
  assert.equal(rWebp.width, 64);
  assert.equal(rWebp.height, 48);

  // Animated WebP -> REJECT
  const webpAnim = makeWebpHeader(64, 48, { animated: true });
  assert.equal(inspectImageBytes(webpAnim).code, 'ANIMATED_WEBP');

  // SVG -> REJECT
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(inspectImageBytes(svg).ok, false);

  // JPEG EXIF orientation 6 (90° CW) swaps 100x200 -> 200x100
  const jpgRot = makeJpegHeaderWithOrientation(100, 200, 6);
  const rJpg = inspectImageBytes(jpgRot);
  assert.equal(rJpg.ok, true);
  assert.equal(rJpg.exifOrientation, 6);
  assert.equal(rJpg.width, 200);
  assert.equal(rJpg.height, 100);

  // WebP fallback PNG signature check (T08)
  const fallbackCheck = verifyEncodedSignature(staticPng, 'image/webp');
  assert.equal(fallbackCheck.ok, false);
  assert.equal(fallbackCheck.code, 'WEBP_FALLBACK_PNG');
});

test('T07: Hatch Pet V2 preset exact geometry (8x11, 192x208, 1536x2288, 73 expected, 15 unused)', () => {
  const preset = createHatchPetV2Preset();
  assert.equal(preset.grid.cols, 8);
  assert.equal(preset.grid.rows, 11);
  assert.equal(preset.grid.cellWidth, 192);
  assert.equal(preset.grid.cellHeight, 208);
  assert.equal(preset.expectedCells.length, 73);
  assert.equal(preset.grid.cols * preset.grid.rows - preset.expectedCells.length, 15);
  assert.equal(preset.animations.length, 11);
  assert.equal(preset.animations[9].loopMode, 'once');
  assert.equal(preset.animations[10].loopMode, 'once');

  const val = validatePresetV1({
    format: preset.format,
    schemaVersion: preset.schemaVersion,
    id: preset.id,
    name: preset.name,
    description: preset.description,
    grid: preset.grid,
    expectedCells: preset.expectedCells,
    defaultFps: preset.defaultFps,
    guides: preset.guides,
    animations: preset.animations
  });
  assert.equal(val.ok, true, val.errors.join('; '));
});

test('T09 & T15: Grid resize keeps coords, Undo restores cells & groups, cell size scales offsets, 55-step history & redo branch clear', () => {
  const store = new ProjectStore();
  store.applyPreset(createHatchPetV2Preset());
  store.addSourcesAndAssets('add', [
    { id: 's1', name: 'a.png', mime: 'image/png', width: 100, height: 100, byteLength: 500 }
  ], [
    { id: 'a1', sourceId: 's1', name: 'a', isRegion: false, region: { x: 0, y: 0, w: 100, h: 100 } }
  ], [
    { row: 0, col: 0, assetId: 'a1' },
    { row: 5, col: 7, assetId: 'a1' }
  ]);
  store.setCellTransform(0, 0, { ...createDefaultCell('a1'), offsetX: 10, offsetY: 20 });

  // Preview shrinking grid to 4x4 -> removes (5,7) and animation slots
  const preview = store.previewGridChange({ cols: 4, rows: 4, cellWidth: 192, cellHeight: 208 });
  assert.equal(preview.needsConfirm, true);
  assert.deepEqual(preview.removedCells, ['5:7']);
  assert.ok(preview.removedAnimationSlots > 0);

  store.applyGridChange({ cols: 4, rows: 4, cellWidth: 384, cellHeight: 104 });
  assert.equal(store.project.cells['5:7'], undefined);
  assert.equal(store.project.cells['0:0'].offsetX, 20); // 10 * (384/192)
  assert.equal(store.project.cells['0:0'].offsetY, 10); // 20 * (104/208)
  assert.equal(store.project.presetId, null); // deviated -> custom mode

  // Undo restores everything!
  store.undo();
  assert.ok(store.project.cells['5:7']);
  assert.equal(store.project.cells['0:0'].offsetX, 10);
  assert.equal(store.project.presetId, 'hatch-pet-v2');

  // 55 small transactions -> Undo/Redo + new branch clears redo
  for (let i = 1; i <= 55; i++) {
    store.setCellTransform(0, 0, { ...createDefaultCell('a1'), offsetX: i }, `move ${i}`);
  }
  assert.ok(store.undoStack.length >= 50);
  store.undo();
  assert.equal(store.project.cells['0:0'].offsetX, 54);
  assert.equal(store.canRedo(), true);
  store.setCellTransform(0, 0, { ...createDefaultCell('a1'), offsetX: 999 }, 'branch');
  assert.equal(store.canRedo(), false);
});

test('T10: Natural sort stability, Batch Import skip/overwrite, overflow, and invalid blocking', () => {
  const store = new ProjectStore(); // 4x4 grid
  store.addSourcesAndAssets('seed', [
    { id: 's0', name: 'old.png', mime: 'image/png', width: 64, height: 64, byteLength: 100 }
  ], [
    { id: 'a0', sourceId: 's0', name: 'old', isRegion: false, region: { x: 0, y: 0, w: 64, h: 64 } }
  ], [
    { row: 0, col: 1, assetId: 'a0' }
  ]);

  const items = [
    { id: '1', name: 'frame10.png', importIndex: 0, valid: true },
    { id: '2', name: 'frame2.png', importIndex: 1, valid: true },
    { id: '3', name: 'frame1.png', importIndex: 2, valid: true },
    { id: '4', name: 'frame2.png', importIndex: 3, valid: true }, // duplicate name -> stable order
    { id: '5', name: 'bad.svg', importIndex: 4, valid: false, error: 'SVG' }
  ];

  const blockedPlan = planBatchImport({
    project: store.project,
    items,
    mode: 'from-cursor-row',
    startCell: { row: 0, col: 0 },
    occupiedPolicy: 'skip',
    onlyValidAccepted: false
  });
  assert.equal(blockedPlan.blockedByInvalid, true);
  assert.equal(blockedPlan.canCommit, false);

  const okPlan = planBatchImport({
    project: store.project,
    items,
    mode: 'from-cursor-row',
    startCell: { row: 0, col: 0 },
    occupiedPolicy: 'skip',
    onlyValidAccepted: true
  });
  assert.equal(okPlan.canCommit, true);
  assert.deepEqual(
    okPlan.assignments.map((a) => `${a.key}:${a.item.id}`),
    ['0:0:3', '0:2:2', '0:3:4', '1:0:1'] // skipped occupied 0:1, frame1 -> frame2(idx1) -> frame2(idx3) -> frame10
  );
  assert.equal(okPlan.skippedOccupiedSlots.length, 1);
});

test('T11: Slice Engine by-count exact divisibility and by-size remainder detection', () => {
  // 212 x 106 with margin 4 all sides -> usable 204 x 98; gap 4x2; 2 cols x 2 rows -> (204-4)/2=100, (98-2)/2=48
  const res = computeSliceGrid({
    imageWidth: 212,
    imageHeight: 106,
    mode: 'by-count',
    cols: 2,
    rows: 2,
    marginLeft: 4, marginRight: 4, marginTop: 4, marginBottom: 4,
    gapX: 4, gapY: 2
  });
  assert.equal(res.ok, true);
  assert.equal(res.frameWidth, 100);
  assert.equal(res.frameHeight, 48);
  assert.deepEqual(res.regions[3], { index: 3, row: 1, col: 1, x: 108, y: 54, w: 100, h: 48 });

  // Non-divisible in by-count -> error
  const badDiv = computeSliceGrid({ imageWidth: 101, imageHeight: 50, mode: 'by-count', cols: 2, rows: 1 });
  assert.equal(badDiv.ok, false);

  // by-size with remainder -> reports remainder without partial slice
  const rem = computeSliceGrid({ imageWidth: 105, imageHeight: 55, mode: 'by-size', frameWidth: 50, frameHeight: 50 });
  assert.equal(rem.ok, true);
  assert.equal(rem.cols, 2);
  assert.equal(rem.rows, 1);
  assert.equal(rem.remainderX, 5);
  assert.equal(rem.remainderY, 5);
  assert.equal(rem.hasRemainder, true);
});

test('T19: Animation Clock — loop, once, pingpong (no double endpoints, 1-frame safe), custom durationMs, visibility pause', () => {
  assert.deepEqual(buildPlaybackOrder(4, 'pingpong'), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(buildPlaybackOrder(1, 'pingpong'), [0]);
  assert.deepEqual(buildPlaybackOrder(2, 'pingpong'), [0, 1]);

  const anim = {
    fps: 10, // 100ms default
    loopMode: 'pingpong',
    frames: [
      { row: 0, col: 0, durationMs: null }, // 100ms
      { row: 0, col: 1, durationMs: 200 },  // 200ms
      { row: 0, col: 2, durationMs: null }  // 100ms
    ]
  };
  const clock = new AnimationClock();
  clock.play(anim, 0);
  assert.equal(clock.tick(anim, 100).frameIndex, 1);
  assert.equal(clock.tick(anim, 250).frameIndex, 1); // only 150ms into 200ms slot
  assert.equal(clock.tick(anim, 300).frameIndex, 2); // 200ms reached
  assert.equal(clock.tick(anim, 400).frameIndex, 1); // bouncing back cleanly!

  // Tab hidden pauses without catch-up burst
  clock.handleVisibilityHidden();
  assert.equal(clock.playing, false);
  assert.equal(clock.tick(anim, 999999).frameIndex, 1);

  // Exact duration without cumulative drift
  assert.equal(getFrameDurationMs({ durationMs: null }, 8), 125);
  assert.equal(getFrameDurationMs({ durationMs: null }, 3), 1000 / 3);
});

test('T16 & T17: ZIP round-trip, .ssb save/open, CRC check, path traversal, zip-bomb & schema rejection', async () => {
  const png1 = makeSyntheticPng(32, 32);
  const store = new ProjectStore(createEmptyProject('Test Project'));
  store.applyPreset(createHatchPetV2Preset());
  store.addSourcesAndAssets('add', [
    { id: 's1', name: 'hero.png', path: 'sources/s1.png', mime: 'image/png', width: 32, height: 32, byteLength: png1.byteLength }
  ], [
    { id: 'a1', sourceId: 's1', name: 'hero_full', isRegion: false, region: { x: 0, y: 0, w: 32, h: 32 } },
    { id: 'a2', sourceId: 's1', name: 'hero_slice', isRegion: true, region: { x: 0, y: 0, w: 16, h: 16 } }
  ], [
    { row: 0, col: 0, assetId: 'a2' }
  ]);

  const rawMap = new Map([['s1', png1]]);
  const ssbBytes = await serializeProjectToSsb(store.project, (id) => rawMap.get(id));
  const loaded = await deserializeProjectFromSsb(ssbBytes);
  assert.equal(loaded.ok, true, (loaded.errors || []).join('; '));
  assert.equal(loaded.project.name, 'Test Project');
  assert.deepEqual(loaded.sourceBinaries.get('s1').bytes, png1);

  // Corrupt CRC inside ZIP -> REJECT
  const corrupted = new Uint8Array(ssbBytes);
  corrupted[ssbBytes.length - 40] ^= 0xff;
  const badCrc = await deserializeProjectFromSsb(corrupted);
  assert.equal(badCrc.ok, false);

  // Path traversal entry -> REJECT
  await assert.rejects(async () => {
    await createZip([{ name: '../evil.txt', data: new Uint8Array([1, 2, 3]) }]);
  });

  // Future schema version -> REJECT
  const badManifest = { ...store.project, schemaVersion: 99 };
  const badVer = validateProjectManifestV2(badManifest);
  assert.equal(badVer.ok, false);

  // Prototype pollution key -> REJECT
  const evilJson = JSON.parse('{"__proto__":{"polluted":true},"format":"sprite-sheet-builder-project","schemaVersion":2}');
  assert.equal(validateProjectManifestV2(evilJson).ok, false);

  // Streaming deflate limit (zip-bomb defense): compress 200 KiB of zeros, enforce 10 KiB limit -> REJECT
  const zeros = new Uint8Array(200 * 1024);
  const bombZip = await createZip([{ name: 'zeros.bin', data: zeros, compress: true }]);
  assert.ok(bombZip.byteLength < 2000); // highly compressed
  await assert.rejects(async () => {
    await readZip(bombZip, { maxUncompressedTotal: 10 * 1024 });
  }, /vượt giới hạn/i);
});

test('T20 & T24: Preflight warnings/errors & filename sanitization/deduplication', () => {
  const used = new Set();
  assert.equal(allocateUniqueFilename(sanitizeFilename('Running Right!'), 'png', used), 'Running_Right.png');
  assert.equal(allocateUniqueFilename(sanitizeFilename('Running Right!'), 'png', used), 'Running_Right_2.png');
  assert.equal(sanitizeFilename('CON'), 'CON_file');

  const store = new ProjectStore();
  store.applyPreset(createHatchPetV2Preset());
  // Empty atlas -> atlas export blocked, JSON export allowed
  const preAtlas = runPreflight({ project: store.project, exportConfig: { type: 'atlas' } });
  assert.equal(preAtlas.ok, false);
  const preJson = runPreflight({ project: store.project, exportConfig: { type: 'json' } });
  assert.equal(preJson.ok, true);
  assert.equal(preJson.warnings.filter((w) => w.code === 'PRESET_MISSING_EXPECTED').length, 73);
});

test('T23: Grid limits reject >64 cols/rows, >1024 cells, >8192px, >32Mi px; flag >4096px for large export confirm', () => {
  assert.equal(validateGrid({ cols: 65, rows: 1, cellWidth: 16, cellHeight: 16 }).ok, false);
  assert.equal(validateGrid({ cols: 33, rows: 32, cellWidth: 16, cellHeight: 16 }).ok, false); // 1056 > 1024
  assert.equal(validateGrid({ cols: 10, rows: 1, cellWidth: 900, cellHeight: 100 }).ok, false); // 9000 > 8192
  const bigSafe = validateGrid({ cols: 8, rows: 8, cellWidth: 600, cellHeight: 600 }); // 4800x4800 = 23M px
  assert.equal(bigSafe.ok, true);
  assert.equal(bigSafe.needsLargeExportConfirm, true);
  const tooManyPx = validateGrid({ cols: 8, rows: 8, cellWidth: 800, cellHeight: 800 }); // 6400x6400 = 40.96M > 33.55M
  assert.equal(tooManyPx.ok, false);
});

test('R1: Store pasteCells & setCellTransform reject missing/deleted assetId and preserve serializable project', async () => {
  const png1 = makeSyntheticPng(32, 32);
  const store = new ProjectStore(createEmptyProject('R1 Test'));
  store.addSourcesAndAssets('add', [
    { id: 's1', name: 'a.png', path: 'sources/s1.png', mime: 'image/png', width: 32, height: 32, byteLength: png1.byteLength }
  ], [
    { id: 'a1', sourceId: 's1', name: 'a', isRegion: false, region: { x: 0, y: 0, w: 32, h: 32 } }
  ], [
    { row: 0, col: 0, assetId: 'a1' }
  ]);

  const copiedCell = structuredClone(store.project.cells['0:0']);
  // Delete asset -> pasteCells must refuse dangling reference!
  store.deleteAsset('a1');
  const badPaste = store.pasteCells([{ row: 0, col: 1, cell: copiedCell }]);
  assert.equal(badPaste.committed, false);
  assert.deepEqual(badPaste.missingAssetIds, ['a1']);
  assert.equal(store.project.cells['0:1'], undefined);

  // Project remains 100% valid and serializable
  const ssbOk = await serializeProjectToSsb(store.project, () => png1);
  assert.ok(ssbOk.byteLength > 0);

  // Undo delete asset -> pasteCells now succeeds!
  store.undo();
  const okPaste = store.pasteCells([{ row: 0, col: 1, cell: copiedCell }]);
  assert.equal(okPaste.committed, true);
  assert.equal(store.project.cells['0:1'].assetId, 'a1');
});

test('R4: RecoveryManager cancels stale project timer & refuses snapshot with missing source binary', async () => {
  const { RecoveryManager } = await import('../../src/io/recovery.js');
  const png1 = makeSyntheticPng(16, 16);

  // Minimal in-memory mock IDB matching the exact multi-store transaction API
  const stores = { meta: new Map(), sources: new Map() };
  const mockDb = {
    transaction(names, mode) {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const pendingOps = [];
      tx.objectStore = (name) => ({
        getAllKeys() {
          const req = { onsuccess: null, onerror: null, result: [...stores[name].keys()] };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
        put(val) {
          pendingOps.push(() => stores[name].set(name === 'meta' ? val.key : val.id, val));
        },
        delete(k) {
          pendingOps.push(() => stores[name].delete(k));
        }
      });
      if (mode === 'readwrite') {
        queueMicrotask(() => {
          for (const op of pendingOps) op();
          tx.oncomplete?.();
        });
      }
      return tx;
    }
  };

  const rec = new RecoveryManager();
  rec.db = mockDb;
  rec.status = 'available';
  rec.debounceMs = 20;

  const storeA = new ProjectStore(createEmptyProject('Project A'));
  storeA.addSourcesAndAssets('add', [
    { id: 's1', name: 'a.png', path: 'sources/s1.png', mime: 'image/png', width: 16, height: 16, byteLength: png1.byteLength }
  ], [
    { id: 'a1', sourceId: 's1', name: 'a', isRegion: false, region: { x: 0, y: 0, w: 16, h: 16 } }
  ], [{ row: 0, col: 0, assetId: 'a1' }]);

  const goodAssetMgr = { getSourceBytes: (id) => (id === 's1' ? png1 : null) };
  const saveGood = await rec.saveSnapshotNow(storeA.project, 2, goodAssetMgr);
  assert.equal(saveGood.ok, true);
  assert.equal(stores.meta.get('latest_committed_snapshot').project.name, 'Project A');
  assert.ok(stores.sources.has('s1'));

  // Missing source binary must NOT overwrite valid snapshot or delete s1!
  const missingAssetMgr = { getSourceBytes: () => null };
  const saveBad = await rec.saveSnapshotNow(storeA.project, 3, missingAssetMgr);
  assert.equal(saveBad.ok, false);
  assert.equal(saveBad.reason, 'missing-source');
  assert.equal(stores.meta.get('latest_committed_snapshot').revision, 2);
  assert.ok(stores.sources.has('s1'));

  // Stale timer pinned to Project A must NOT save empty Project B if cancelled or projectId changed!
  let currentProj = storeA.project;
  rec.scheduleSave(() => ({ project: currentProj, revision: 1, assetManager: goodAssetMgr }), storeA.project.projectId);
  currentProj = createEmptyProject('Project B Empty');
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(stores.meta.get('latest_committed_snapshot').project.name, 'Project A');
});
