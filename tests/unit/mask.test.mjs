/**
 * Sprite Sheet Builder — Per-Cell Eraser/Restore Mask Unit Tests (E01–E07 core logic).
 * Tests hard-round brush rasterization, 1-point clicks, fast gap-free strokes,
 * alpha-preserving restore (0/128/255), non-zero crop coords, crop edit intersection,
 * polyline simplification, budget limits, V2/V3 schema validation, .ssb V2/V3 round-trip,
 * store operations, and preflight behavior when erased empty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
  LIMITS,
  PROJECT_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION_V3
} from '../../src/core/constants.js';
import {
  hasCellMask,
  projectHasMasks,
  getMaskSignature,
  simplifyStrokePoints,
  checkMaskBudget,
  rasterizeMaskAlpha,
  applyMaskAlphaToRGBA
} from '../../src/core/mask.js';
import { computeAlphaBoundsFromRGBA, isCompletelyTransparentRGBA } from '../../src/core/geometry.js';
import { validateProjectManifest, validateProjectManifestV2 } from '../../src/core/validator.js';
import { ProjectStore, createDefaultCell } from '../../src/core/store.js';
import { runPreflight } from '../../src/core/preflight.js';
import { crc32 } from '../../src/io/zip.js';
import { serializeProjectToSsb, deserializeProjectFromSsb } from '../../src/io/project-io.js';

function makeSyntheticPng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const makeChunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(new Uint8Array(Buffer.concat([typeBuf, data]))), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rawRow = Buffer.alloc(1 + width * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => rawRow));
  const idat = zlib.deflateSync(raw);
  return new Uint8Array(Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0))]));
}

function makeTestProjectWithSource(width = 256, height = 64) {
  const pngBytes = makeSyntheticPng(width, height);
  const store = new ProjectStore();
  store.addSourcesAndAssets(
    'init',
    [{ id: 's1', name: 'strip.png', mime: 'image/png', width, height, byteLength: pngBytes.byteLength }],
    [
      { id: 'a1', sourceId: 's1', name: 'f1', isRegion: true, region: { x: 0, y: 0, w: 64, h: 64 } },
      { id: 'a2', sourceId: 's1', name: 'f2', isRegion: true, region: { x: 64, y: 0, w: 64, h: 64 } }
    ],
    [
      { row: 0, col: 0, assetId: 'a1' },
      { row: 0, col: 1, assetId: 'a2' }
    ]
  );
  return { store, pngBytes };
}

test('E01/E03/E04 Mask Rasterization: 1-point click, 1px brush, gap-free fast drag, and alpha 0/128/255 exact restore', () => {
  const w = 64;
  const h = 64;
  // Build RGBA buffer: x=0..19 alpha=0, x=20..39 alpha=128, x=40..63 alpha=255
  const srcRgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (x >= 20 && x < 40) {
        srcRgba[o] = 200; srcRgba[o + 1] = 100; srcRgba[o + 2] = 50; srcRgba[o + 3] = 128;
      } else if (x >= 40) {
        srcRgba[o] = 40; srcRgba[o + 1] = 220; srcRgba[o + 2] = 180; srcRgba[o + 3] = 255;
      }
    }
  }

  // 1. Single-point click with 1px brush (radius=0.5) at exact integer (50, 30) erases pixel (50, 30)
  const m1px = rasterizeMaskAlpha(w, h, 0, 0, [{ op: 'erase', radius: 0.5, points: [[50, 30]] }]);
  assert.equal(m1px[30 * w + 50], 0);
  assert.equal(m1px[30 * w + 52], 255);

  // 2. Fast drag with only 2 endpoints across 50 pixels leaves ZERO gaps along the line
  const mFast = rasterizeMaskAlpha(w, h, 0, 0, [{ op: 'erase', radius: 3, points: [[5, 32], [55, 32]] }]);
  for (let x = 5; x <= 55; x++) {
    assert.equal(mFast[32 * w + x], 0, `Gap found at x=${x}`);
  }

  // 3. Erase across all 3 alpha zones (0, 128, 255), then Restore across same line -> exact original alpha!
  const mEraseRestore = rasterizeMaskAlpha(w, h, 0, 0, [
    { op: 'erase', radius: 6, points: [[10, 32], [54, 32]] },
    { op: 'restore', radius: 6, points: [[10, 32], [54, 32]] }
  ]);
  const outRgba = applyMaskAlphaToRGBA(srcRgba, mEraseRestore);
  // Alpha 0 stays 0 (never painted opaque!)
  assert.equal(outRgba[(32 * w + 10) * 4 + 3], 0);
  // Alpha 128 restored to exact 128 (never painted 255!)
  assert.equal(outRgba[(32 * w + 30) * 4 + 3], 128);
  assert.equal(outRgba[(32 * w + 30) * 4], 200);
  // Alpha 255 restored to exact 255
  assert.equal(outRgba[(32 * w + 50) * 4 + 3], 255);
  assert.equal(outRgba[(32 * w + 50) * 4 + 1], 220);
});

test('E03/E07 Mask Crop Coords: non-zero region origin & crop edit keeps strokes in source coords without stretching', () => {
  // Region starts at source (64, 16), size 64x48. Erase at source (80, 32) -> local (16, 16)
  const strokes = [{ op: 'erase', radius: 4, points: [[80, 32]] }];
  const mOrig = rasterizeMaskAlpha(64, 48, 64, 16, strokes);
  assert.equal(mOrig[16 * 64 + 16], 0);
  assert.equal(mOrig[16 * 64 + 40], 255);

  // Now shift crop origin right by 10 px to (74, 16), size 40x48:
  // Source (80, 32) must now appear at local (6, 16) — NOT stretched or shifted to (16, 16)!
  const mCropped = rasterizeMaskAlpha(40, 48, 74, 16, strokes);
  assert.equal(mCropped[16 * 40 + 6], 0);
  assert.equal(mCropped[16 * 40 + 16], 255);

  // Crop completely disjoint from stroke (100, 16, 40, 48): entire crop untouched
  const mDisjoint = rasterizeMaskAlpha(40, 48, 100, 16, strokes);
  assert.equal(mDisjoint.every((v) => v === 255), true);
});

test('Mask simplification & signature determinism', () => {
  // Dense straight line of 200 points simplifies down to 2 exact endpoints
  const dense = [];
  for (let i = 0; i < 200; i++) dense.push([10 + i * 0.5, 20]);
  const simp = simplifyStrokePoints(dense, 0.25);
  assert.equal(simp.length, 2);
  assert.deepEqual(simp[0], [10, 20]);
  assert.deepEqual(simp[1], [109.5, 20]);

  const mA = { strokes: [{ op: 'erase', radius: 6, points: [[10, 20], [30, 40]] }] };
  const mB = { strokes: [{ op: 'erase', radius: 6, points: [[10, 20], [30, 40]] }] };
  const mC = { strokes: [{ op: 'restore', radius: 6, points: [[10, 20], [30, 40]] }] };
  assert.equal(getMaskSignature(mA), getMaskSignature(mB));
  assert.notEqual(getMaskSignature(mA), getMaskSignature(mC));
  assert.equal(getMaskSignature(null), '');
});

test('E06 Schema V2/V3 validation, strict rejection of invalid/oversized masks, and .ssb V2/V3 round-trip', async () => {
  const { store, pngBytes } = makeTestProjectWithSource(256, 64);

  // 1. Unmasked project serializes as V2 and round-trips cleanly
  const ssbV2 = await serializeProjectToSsb(store.project, () => pngBytes);
  const resV2 = await deserializeProjectFromSsb(ssbV2);
  assert.equal(resV2.ok, true);
  assert.equal(resV2.project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(projectHasMasks(resV2.project), false);

  // 2. V2 manifest MUST reject `cell.mask` (no silent loosening of V2)
  const illegalV2 = structuredClone(resV2.project);
  illegalV2.cells['0:0'].mask = { strokes: [{ op: 'erase', radius: 6, points: [[10, 10]] }] };
  assert.equal(validateProjectManifest(illegalV2).ok, false);
  assert.equal(validateProjectManifestV2(illegalV2).ok, false);

  // 3. Project with mask serializes automatically as V3 and round-trips identically
  const maskedCell = {
    ...store.project.cells['0:0'],
    mask: {
      strokes: [
        { op: 'erase', radius: 6, points: [[56, 28], [58, 34]] },
        { op: 'restore', radius: 3, points: [[57, 30]] }
      ]
    }
  };
  store.setCellTransform(0, 0, maskedCell, 'Tẩy ô 1');
  const ssbV3 = await serializeProjectToSsb(store.project, () => pngBytes);
  const resV3 = await deserializeProjectFromSsb(ssbV3);
  assert.equal(resV3.ok, true);
  assert.equal(resV3.project.schemaVersion, PROJECT_SCHEMA_VERSION_V3);
  assert.deepEqual(resV3.project.cells['0:0'].mask, maskedCell.mask);
  assert.equal(hasCellMask(resV3.project.cells['0:1']), false);

  // 4. Clearing all masks returns serialized output cleanly to V2
  const clearedCell = { ...store.project.cells['0:0'] };
  delete clearedCell.mask;
  store.setCellTransform(0, 0, clearedCell, 'Bỏ vết tẩy');
  const ssbBackV2 = await serializeProjectToSsb(store.project, () => pngBytes);
  const resBackV2 = await deserializeProjectFromSsb(ssbBackV2);
  assert.equal(resBackV2.ok, true);
  assert.equal(resBackV2.project.schemaVersion, PROJECT_SCHEMA_VERSION);

  // 5. Strict V3 rejection cases
  const makeBadV3 = (mask) => {
    const p = structuredClone(resV3.project);
    p.cells['0:0'].mask = mask;
    return validateProjectManifest(p);
  };
  assert.equal(makeBadV3({ strokes: [{ op: 'blur', radius: 6, points: [[10, 10]] }] }).ok, false, 'invalid op');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 0.1, points: [[10, 10]] }] }).ok, false, 'radius too small');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 65, points: [[10, 10]] }] }).ok, false, 'radius too large');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [] }] }).ok, false, 'empty points');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[Number.NaN, 10]] }] }).ok, false, 'NaN point');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[-1, 10]] }] }).ok, false, 'negative coord');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[300, 10]] }] }).ok, false, 'coord > source.width');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[10, 10]], extra: 1 }] }).ok, false, 'unknown stroke field');
  assert.equal(makeBadV3({ strokes: [], extra: true }).ok, false, 'unknown mask field');

  // Exceeding MAX_MASK_POINTS_PER_STROKE (1024) rejected both by validator & checkMaskBudget
  const tooManyPts = Array.from({ length: LIMITS.MAX_MASK_POINTS_PER_STROKE + 1 }, (_, i) => [i % 64, 10]);
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 4, points: tooManyPts }] }).ok, false);
  const budgetRes = checkMaskBudget(store.project, '0:0', { strokes: [{ op: 'erase', radius: 4, points: tooManyPts }] });
  assert.equal(budgetRes.ok, false);
  assert.equal(budgetRes.code, 'STROKE_MAX_POINTS');

  // Exceeding MAX_MASK_STROKES_PER_CELL (512) rejected
  const tooManyStrokes = Array.from({ length: LIMITS.MAX_MASK_STROKES_PER_CELL + 1 }, () => ({
    op: 'erase', radius: 4, points: [[10, 10]]
  }));
  assert.equal(makeBadV3({ strokes: tooManyStrokes }).ok, false);
});

test('E05/E07 Preflight & Store Rules: erased-empty Fit Alpha warns without blocking; copy/swap carry mask, replace clears mask', () => {
  const { store } = makeTestProjectWithSource(256, 64);

  // Set Fit Alpha + mask on cell 0:0
  const mask = { strokes: [{ op: 'erase', radius: 32, points: [[32, 32]] }] };
  store.setCellTransform(0, 0, {
    ...store.project.cells['0:0'],
    fitMode: 'alpha',
    offsetX: 5,
    mask
  });

  // Preflight when cell 0:0 is masked-empty: warning MASK_ALL_TRANSPARENT, ZERO blocking errors!
  const report = runPreflight({
    project: store.project,
    exportConfig: { type: 'atlas', format: 'image/png' },
    inspectAssetPixels: (assetId, thr, cell, key) => {
      if (key === '0:0') {
        return { ok: true, allTransparent: true, visibleBounds: null, alphaBounds: null };
      }
      return { ok: true, allTransparent: false, visibleBounds: { x: 10, y: 10, w: 30, h: 30 }, alphaBounds: { x: 10, y: 10, w: 30, h: 30 } };
    }
  });
  assert.equal(report.ok, true, `Erased-empty Fit Alpha should NOT block export: ${JSON.stringify(report.errors)}`);
  assert.ok(report.warnings.some((w) => w.code === 'MASK_ALL_TRANSPARENT' && w.cellKey === '0:0'));

  // Undo restores both transform AND mask in 1 step
  store.undo();
  assert.equal(hasCellMask(store.project.cells['0:0']), false);
  assert.equal(store.project.cells['0:0'].offsetX, 0);
  store.redo();
  assert.deepEqual(store.project.cells['0:0'].mask, mask);
  assert.equal(store.project.cells['0:0'].offsetX, 5);

  // Swap 0:0 <-> 0:1 moves mask to 0:1
  store.moveOrSwapCell('0:0', '0:1', { copy: false });
  assert.deepEqual(store.project.cells['0:1'].mask, mask);
  assert.equal(hasCellMask(store.project.cells['0:0']), false);

  // Copy 0:1 -> 0:2 carries mask
  store.moveOrSwapCell('0:1', '0:2', { copy: true });
  assert.deepEqual(store.project.cells['0:2'].mask, mask);

  // Replacing image in 0:2 via addSourcesAndAssets starts with NO mask
  store.addSourcesAndAssets('replace', [], [], [{ row: 0, col: 2, assetId: 'a2' }]);
  assert.equal(hasCellMask(store.project.cells['0:2']), false);

  // Editing asset region of a1 keeps cell 0:1's mask strokes in source coords intact
  store.updateAssetRegion('a1', { x: 8, y: 8, w: 48, h: 48 }, { createNew: false });
  assert.deepEqual(store.project.cells['0:1'].mask, mask);
});
