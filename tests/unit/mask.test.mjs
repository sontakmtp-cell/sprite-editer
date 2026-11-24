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
  checkProjectMaskBudgets,
  rasterizeMaskAlpha,
  applyMaskAlphaToRGBA
} from '../../src/core/mask.js';
import { computeAlphaBoundsFromRGBA, isCompletelyTransparentRGBA } from '../../src/core/geometry.js';
import {
  validateProjectManifest,
  validateProjectManifestV2,
  validateAtlasMetadataV1,
  validateAtlasMetadataV2
} from '../../src/core/validator.js';
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
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[-7, 10]] }] }).ok, false, 'coord < -radius');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[263, 10]] }] }).ok, false, 'coord > source.width + radius');
  assert.equal(makeBadV3({ strokes: [{ op: 'erase', radius: 6, points: [[-4, 10]] }] }).ok, true, 'edge brush center within -radius valid');
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

test('PR2-P1: Post-operation mask budget rejects overflowing paste/duplicate/copy; accepts just-under-limit & 117,760-point compact manifest', async () => {
  const { store, pngBytes } = makeTestProjectWithSource(256, 64);
  store.applyGridChange({ cols: 20, rows: 2, cellWidth: 64, cellHeight: 64 });

  // Build 1 cell with 500 valid 1-point strokes
  const strokes500 = Array.from({ length: 500 }, (_, i) => ({
    op: 'erase',
    radius: 2,
    points: [[i % 64, Math.floor(i / 64)]]
  }));
  const rSet = store.setCellTransform(0, 0, {
    ...store.project.cells['0:0'],
    mask: { strokes: strokes500 }
  });
  assert.equal(rSet.committed, true);

  const revBefore = store.revision;
  const undoLenBefore = store.undoStack.length;

  // 1. Multi-paste into 16 other cells -> total 17 * 500 = 8,500 > 8,192 -> REJECTED without mutating state/history!
  const cell0 = store.project.cells['0:0'];
  const plan16 = Array.from({ length: 16 }, (_, i) => ({ row: 0, col: i + 1, cell: cell0 }));
  const badPaste = store.pasteCells(plan16);
  assert.equal(badPaste.committed, false);
  assert.equal(badPaste.code, 'PROJECT_MAX_STROKES');
  assert.ok(badPaste.error && badPaste.error.includes('8.192') || badPaste.error.includes('8,192') || badPaste.error.includes('8192'));
  assert.equal(store.revision, revBefore);
  assert.equal(store.undoStack.length, undoLenBefore);
  assert.equal(store.project.cells['0:2'], undefined);

  // 2. Multi-paste into 15 other cells -> total 16 * 500 = 8,000 <= 8,192 -> ACCEPTED and saves/reopens cleanly!
  const plan15 = Array.from({ length: 15 }, (_, i) => ({ row: 0, col: i + 1, cell: cell0 }));
  const okPaste = store.pasteCells(plan15);
  assert.equal(okPaste.committed, true);
  const ssb8000 = await serializeProjectToSsb(store.project, () => pngBytes);
  const res8000 = await deserializeProjectFromSsb(ssb8000);
  assert.equal(res8000.ok, true);
  assert.equal(res8000.project.schemaVersion, PROJECT_SCHEMA_VERSION_V3);

  // 3. Copying one more cell via moveOrSwapCell({ copy: true }) -> 8,500 > 8,192 -> REJECTED!
  const revAt8000 = store.revision;
  const badCopy = store.moveOrSwapCell('0:0', '1:0', { copy: true });
  assert.equal(badCopy.committed, false);
  assert.equal(badCopy.code, 'PROJECT_MAX_STROKES');
  assert.equal(store.revision, revAt8000);
  assert.equal(store.project.cells['1:0'], undefined);

  // 4. Large valid manifest: 117,760 points (~1.89 MB compact mask JSON) must validate & serialize < 8 MiB!
  const { store: bigStore, pngBytes: bigPng } = makeTestProjectWithSource(256, 64);
  bigStore.applyGridChange({ cols: 16, rows: 1, cellWidth: 64, cellHeight: 64 });
  // 10 cells * 16 strokes * 736 points = 117,760 points (each cell = 11,776 <= 16,384; stroke = 736 <= 1,024)
  const makeBigCellMask = () => ({
    strokes: Array.from({ length: 16 }, (_, s) => ({
      op: 'erase',
      radius: 2,
      points: Array.from({ length: 736 }, (_, p) => [(p * 3) % 64, (s * 4 + (p % 4)) % 64])
    }))
  });
  const bigMask = makeBigCellMask();
  const baseCell = bigStore.project.cells['0:0'];
  const updates = {};
  for (let c = 0; c < 10; c++) {
    updates[`0:${c}`] = { ...baseCell, mask: bigMask };
  }
  const bigCommit = bigStore.applyMultipleCellTransforms(updates, 'large valid mask');
  assert.equal(bigCommit.committed, true, `Large valid mask commit failed: ${bigCommit.error}`);
  const check = checkProjectMaskBudgets(bigStore.project);
  assert.equal(check.ok, true);
  assert.equal(check.points, 117760);
  assert.ok(check.manifestBytes < LIMITS.MAX_MANIFEST_BYTES, `Manifest bytes ${check.manifestBytes} >= 8 MiB`);

  const bigSsb = await serializeProjectToSsb(bigStore.project, () => bigPng);
  const bigBack = await deserializeProjectFromSsb(bigSsb);
  assert.equal(bigBack.ok, true, `Large valid manifest deserialize failed: ${bigBack.errors}`);
});

test('PR2-P2: Edge brush center outside crop clips cleanly (never pulls center inward) & 1px brush stays source-pixel-invariant on crop expand', () => {
  // 1. Solid 64x64 image (crop 0,0,64,64), brush radius=10 centered at source (32, -8)
  // Circle bottom is at y = -8 + 10 = +2 -> ONLY rows y=0 (center 0.5, dy=8.5) and y=1 (center 1.5, dy=9.5) erased;
  // row y=2 (center 2.5, dy=10.5 > 10) MUST remain untouched (255)!
  const edgeMask = rasterizeMaskAlpha(64, 64, 0, 0, [{ op: 'erase', radius: 10, points: [[32, -8]] }]);
  assert.equal(edgeMask[0 * 64 + 32], 0, 'Row 0 should be erased');
  assert.equal(edgeMask[1 * 64 + 32], 0, 'Row 1 should be erased');
  assert.equal(edgeMask[2 * 64 + 32], 255, 'Row 2 must NOT be erased (center was pulled inward!)');
  assert.equal(edgeMask[9 * 64 + 32], 255, 'Row 9 must NOT be erased');

  // 2. 1px brush at rightmost pixel (63.5, 32.5) of crop (0,0,64,64):
  // Expanding crop to (0,0,80,64) or shifting to (10,0,70,64) must keep EXACT source pixel x=63 erased!
  const onePxStroke = [{ op: 'erase', radius: 0.5, points: [[63.5, 32.5]] }];
  const m64 = rasterizeMaskAlpha(64, 64, 0, 0, onePxStroke);
  assert.equal(m64[32 * 64 + 63], 0);
  assert.equal(m64[32 * 64 + 62], 255);

  const m80 = rasterizeMaskAlpha(80, 64, 0, 0, onePxStroke);
  assert.equal(m80[32 * 80 + 63], 0, 'Source pixel 63 must remain erased after crop expand');
  assert.equal(m80[32 * 80 + 64], 255, 'Source pixel 64 must NOT become erased after crop expand');

  // 3. Raw boundary coord [64, 32] with radius=0.5 must NOT falsely snap to pixel 63 on crop width 64
  const mEdge64 = rasterizeMaskAlpha(64, 64, 0, 0, [{ op: 'erase', radius: 0.5, points: [[64, 32]] }]);
  assert.equal(mEdge64[32 * 64 + 63], 255, 'Coord 64 must not snap into pixel 63 on width=64 crop');
});

test('PR2-P2: Strict Atlas Metadata V1 rejects contentBoundsCellPx; Atlas Metadata V2 validates clipped bounds inside cell', () => {
  const baseV1 = {
    format: 'sprite-sheet-builder-atlas',
    schemaVersion: 1,
    image: 'sheet.png',
    atlas: { width: 64, height: 64, cols: 1, rows: 1, cellWidth: 64, cellHeight: 64, origin: 'top-left', indexBase: 0 },
    frames: [{ id: 'r0c0', row: 0, col: 0, x: 0, y: 0, w: 64, h: 64, empty: false, anchorCellPx: { x: 32, y: 32 } }],
    animations: []
  };
  assert.equal(validateAtlasMetadataV1(baseV1).ok, true);

  // V1 MUST reject contentBoundsCellPx
  const badV1 = structuredClone(baseV1);
  badV1.frames[0].contentBoundsCellPx = { x: 24, y: 0, w: 40, h: 64 };
  assert.equal(validateAtlasMetadataV1(badV1).ok, false);

  // V2 accepts clipped bounds inside cell and rejects unclipped out-of-cell bounds (x=24, w=64 > 64)
  const goodV2 = structuredClone(badV1);
  goodV2.schemaVersion = 2;
  assert.equal(validateAtlasMetadataV2(goodV2).ok, true);

  const unclippedV2 = structuredClone(goodV2);
  unclippedV2.frames[0].contentBoundsCellPx = { x: 24, y: 0, w: 64, h: 64 };
  assert.equal(validateAtlasMetadataV2(unclippedV2).ok, false);
});
