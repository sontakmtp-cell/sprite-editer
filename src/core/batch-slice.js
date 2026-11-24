/**
 * Sprite Sheet Builder V2.0 — Batch Import Planner & Slice Engine (Spec §5.2 & §5.3).
 * Pure deterministic planners for preview-before-commit workflows.
 */

import { cellKey, parseCellKey, isCellInGrid, naturalCompare, stableSort } from './constants.js';

/**
 * Sort incoming batch items according to chosen sort mode while keeping stability on duplicates.
 * @param {Array<{id:string, name:string, importIndex:number, valid?:boolean}>} items
 * @param {'natural'|'import'|'reverse-natural'|'reverse-import'|'manual'} sortMode
 */
export function sortBatchItems(items, sortMode = 'natural') {
  if (sortMode === 'manual') return [...items];
  if (sortMode === 'import') {
    return stableSort(items, (a, b) => (a.importIndex ?? 0) - (b.importIndex ?? 0));
  }
  if (sortMode === 'reverse-import') {
    return stableSort(items, (a, b) => (b.importIndex ?? 0) - (a.importIndex ?? 0));
  }
  if (sortMode === 'reverse-natural') {
    return stableSort(items, (a, b) => -naturalCompare(a.name, b.name));
  }
  // Default: 'natural'
  return stableSort(items, (a, b) => naturalCompare(a.name, b.name));
}

/**
 * Compute ordered candidate cell coordinates for Batch Import modes (Spec §5.2).
 *
 * Modes:
 * - 'from-cursor-row': starting at startCell, scan left-to-right then top-to-bottom
 * - 'from-cursor-col': starting at startCell, scan top-to-bottom then left-to-right
 * - 'selected-cells': only selectedCells sorted row-major
 * - 'animation-group': unique cell slots in animation group in group order (never overflows outside group!)
 * - 'preset-expected': expectedCells in row-major order (empty cells prioritized)
 */
export function buildTargetSlots({
  project,
  mode = 'from-cursor-row',
  startCell = { row: 0, col: 0 },
  selectedCells = [],
  animationId = null,
  allowPresetUnused = false
}) {
  const { cols, rows } = project.grid;
  const expectedSet = project.expectedCells ? new Set(project.expectedCells) : null;
  const slots = [];

  const isAllowed = (r, c) => {
    if (!isCellInGrid(r, c, project.grid)) return false;
    if (expectedSet && !allowPresetUnused && !expectedSet.has(cellKey(r, c))) {
      return false;
    }
    return true;
  };

  if (mode === 'selected-cells') {
    const coords = selectedCells
      .map((k) => (typeof k === 'string' ? parseCellKey(k) : k))
      .filter((p) => p && isCellInGrid(p.row, p.col, project.grid))
      .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
    const seen = new Set();
    for (const p of coords) {
      const k = cellKey(p.row, p.col);
      if (seen.has(k)) continue;
      seen.add(k);
      if (isAllowed(p.row, p.col)) slots.push({ row: p.row, col: p.col, key: k });
    }
    return slots;
  }

  if (mode === 'animation-group') {
    const anim = project.animations.find((a) => a.id === animationId);
    if (!anim) return [];
    const seen = new Set();
    for (const f of anim.frames) {
      const k = cellKey(f.row, f.col);
      if (seen.has(k) || !isCellInGrid(f.row, f.col, project.grid)) continue;
      seen.add(k);
      // Do not filter out group slots unless user explicitly excluded unused; group scope is explicit
      slots.push({ row: f.row, col: f.col, key: k });
    }
    return slots;
  }

  if (mode === 'preset-expected') {
    if (expectedSet) {
      const coords = [...expectedSet]
        .map(parseCellKey)
        .filter((p) => p && isCellInGrid(p.row, p.col, project.grid))
        .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
      for (const p of coords) {
        slots.push({ row: p.row, col: p.col, key: cellKey(p.row, p.col) });
      }
      return slots;
    }
    // Fallback if no preset: all cells row-major
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        slots.push({ row: r, col: c, key: cellKey(r, c) });
      }
    }
    return slots;
  }

  const sr = Math.max(0, Math.min(rows - 1, startCell?.row ?? 0));
  const sc = Math.max(0, Math.min(cols - 1, startCell?.col ?? 0));

  if (mode === 'from-cursor-col') {
    for (let c = sc; c < cols; c++) {
      const rStart = c === sc ? sr : 0;
      for (let r = rStart; r < rows; r++) {
        if (isAllowed(r, c)) slots.push({ row: r, col: c, key: cellKey(r, c) });
      }
    }
    return slots;
  }

  // Default: 'from-cursor-row'
  for (let r = sr; r < rows; r++) {
    const cStart = r === sr ? sc : 0;
    for (let c = cStart; c < cols; c++) {
      if (isAllowed(r, c)) slots.push({ row: r, col: c, key: cellKey(r, c) });
    }
  }
  return slots;
}

/**
 * Plan Batch Import mapping (Spec §5.2).
 *
 * @param {object} params
 * @param {object} params.project
 * @param {Array<{id:string, name:string, importIndex:number, valid:boolean, error?:string, isBlankSlot?:boolean}>} params.items
 * @param {string} params.mode
 * @param {{row:number, col:number}} [params.startCell]
 * @param {Array<string>} [params.selectedCells]
 * @param {string|null} [params.animationId]
 * @param {'skip'|'overwrite'} [params.occupiedPolicy='skip']
 * @param {boolean} [params.allowPresetUnused=false]
 * @param {string} [params.sortMode='natural']
 * @param {boolean} [params.onlyValidAccepted=false]
 * @param {boolean} [params.preserveBlankSlots=false]  Used by Slice Engine "giữ thứ tự với khoảng trống"
 */
export function planBatchImport({
  project,
  items,
  mode = 'from-cursor-row',
  startCell = { row: 0, col: 0 },
  selectedCells = [],
  animationId = null,
  occupiedPolicy = 'skip',
  allowPresetUnused = false,
  sortMode = 'natural',
  onlyValidAccepted = false,
  preserveBlankSlots = false
}) {
  const invalidItems = items.filter((it) => !it.valid);
  const validItemsRaw = items.filter((it) => it.valid);
  const orderedValid = sortBatchItems(validItemsRaw, sortMode);

  const candidateSlots = buildTargetSlots({
    project,
    mode,
    startCell,
    selectedCells,
    animationId,
    allowPresetUnused
  });

  const assignments = [];
  const overwritten = [];
  const skippedOccupiedSlots = [];
  const skippedBlankItems = [];
  const overflowItems = [];

  let slotIdx = 0;

  for (const item of orderedValid) {
    // Advance past occupied slots if policy is 'skip'
    while (
      slotIdx < candidateSlots.length &&
      occupiedPolicy === 'skip' &&
      Boolean(project.cells[candidateSlots[slotIdx].key])
    ) {
      skippedOccupiedSlots.push(candidateSlots[slotIdx]);
      slotIdx++;
    }

    if (slotIdx >= candidateSlots.length) {
      if (!item.isBlankSlot) overflowItems.push(item);
      continue;
    }

    const slot = candidateSlots[slotIdx++];

    if (item.isBlankSlot) {
      if (preserveBlankSlots) {
        // Reserve slot without writing an image
        skippedBlankItems.push({ item, slot });
      } else {
        // Do not consume slot when compacting
        slotIdx--;
        skippedBlankItems.push({ item, slot: null });
      }
      continue;
    }

    const existing = project.cells[slot.key] || null;
    const entry = {
      item,
      row: slot.row,
      col: slot.col,
      key: slot.key,
      willOverwrite: Boolean(existing)
    };
    assignments.push(entry);
    if (existing) overwritten.push(entry);
  }

  let remainingEmptySlots = 0;
  for (let i = slotIdx; i < candidateSlots.length; i++) {
    if (!project.cells[candidateSlots[i].key]) remainingEmptySlots++;
  }

  const blockedByInvalid = invalidItems.length > 0 && !onlyValidAccepted;

  return {
    assignments,
    overwritten,
    skippedOccupiedSlots,
    skippedBlankItems,
    overflowItems,
    invalidItems,
    totalCandidateSlots: candidateSlots.length,
    remainingEmptySlots,
    blockedByInvalid,
    needsOverwriteConfirm: overwritten.length > 0,
    canCommit: !blockedByInvalid && assignments.length > 0
  };
}

/**
 * Slice Engine Grid Calculator (Spec §5.3).
 *
 * Modes:
 * - 'by-count': user supplies cols & rows; usable area MUST divide evenly into integer cell size.
 * - 'by-size': user supplies frameWidth & frameHeight; computes full integer cell count and reports remainderX/remainderY.
 */
export function computeSliceGrid({
  imageWidth,
  imageHeight,
  mode = 'by-count', // 'by-count' | 'by-size'
  cols = 1,
  rows = 1,
  frameWidth = 64,
  frameHeight = 64,
  marginLeft = 0,
  marginRight = 0,
  marginTop = 0,
  marginBottom = 0,
  gapX = 0,
  gapY = 0
}) {
  const errors = [];

  if (!Number.isInteger(imageWidth) || imageWidth < 1 || !Number.isInteger(imageHeight) || imageHeight < 1) {
    return { ok: false, errors: ['Kích thước ảnh nguồn không hợp lệ.'], regions: [] };
  }

  const nonNegInts = [
    ['Margin trái', marginLeft],
    ['Margin phải', marginRight],
    ['Margin trên', marginTop],
    ['Margin dưới', marginBottom],
    ['Gap ngang', gapX],
    ['Gap dọc', gapY]
  ];
  for (const [label, val] of nonNegInts) {
    if (!Number.isInteger(val) || val < 0) {
      errors.push(`${label} phải là số nguyên không âm.`);
    }
  }

  const usableW = imageWidth - marginLeft - marginRight;
  const usableH = imageHeight - marginTop - marginBottom;
  if (usableW <= 0 || usableH <= 0) {
    errors.push(`Vùng hữu dụng sau margin (${usableW}×${usableH} px) phải lớn hơn 0.`);
  }

  let outCols = 0;
  let outRows = 0;
  let outW = 0;
  let outH = 0;
  let remainderX = 0;
  let remainderY = 0;

  if (errors.length === 0) {
    if (mode === 'by-count') {
      if (!Number.isInteger(cols) || cols < 1) errors.push('Số cột phải là số nguyên dương.');
      if (!Number.isInteger(rows) || rows < 1) errors.push('Số hàng phải là số nguyên dương.');
      if (errors.length === 0) {
        const netW = usableW - (cols - 1) * gapX;
        const netH = usableH - (rows - 1) * gapY;
        if (netW <= 0 || netH <= 0) {
          errors.push('Tổng margin và gap vượt quá kích thước ảnh.');
        } else {
          if (netW % cols !== 0) {
            errors.push(`Chiều rộng hữu dụng sau gap (${netW} px) không chia hết cho ${cols} cột (dư ${netW % cols} px).`);
          }
          if (netH % rows !== 0) {
            errors.push(`Chiều cao hữu dụng sau gap (${netH} px) không chia hết cho ${rows} hàng (dư ${netH % rows} px).`);
          }
          if (errors.length === 0) {
            outCols = cols;
            outRows = rows;
            outW = netW / cols;
            outH = netH / rows;
          }
        }
      }
    } else if (mode === 'by-size') {
      if (!Number.isInteger(frameWidth) || frameWidth < 1) errors.push('Chiều rộng frame phải là số nguyên dương.');
      if (!Number.isInteger(frameHeight) || frameHeight < 1) errors.push('Chiều cao frame phải là số nguyên dương.');
      if (errors.length === 0) {
        if (frameWidth > usableW || frameHeight > usableH) {
          errors.push(`Kích thước frame (${frameWidth}×${frameHeight}) lớn hơn vùng hữu dụng (${usableW}×${usableH}).`);
        } else {
          outCols = Math.floor((usableW + gapX) / (frameWidth + gapX));
          outRows = Math.floor((usableH + gapY) / (frameHeight + gapY));
          outW = frameWidth;
          outH = frameHeight;
          const usedW = outCols * outW + Math.max(0, outCols - 1) * gapX;
          const usedH = outRows * outH + Math.max(0, outRows - 1) * gapY;
          remainderX = usableW - usedW;
          remainderY = usableH - usedH;
        }
      }
    } else {
      errors.push(`Chế độ tách không hợp lệ: ${mode}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, regions: [] };
  }

  const regions = [];
  let index = 0;
  for (let r = 0; r < outRows; r++) {
    for (let c = 0; c < outCols; c++) {
      const x = marginLeft + c * (outW + gapX);
      const y = marginTop + r * (outH + gapY);
      if (x < 0 || y < 0 || x + outW > imageWidth || y + outH > imageHeight) {
        return {
          ok: false,
          errors: [`Vùng cắt tại hàng ${r + 1}, cột ${c + 1} vượt biên ảnh nguồn.`],
          regions: []
        };
      }
      regions.push({
        index: index++,
        row: r,
        col: c,
        x,
        y,
        w: outW,
        h: outH
      });
    }
  }

  return {
    ok: true,
    errors: [],
    cols: outCols,
    rows: outRows,
    frameWidth: outW,
    frameHeight: outH,
    remainderX,
    remainderY,
    hasRemainder: remainderX > 0 || remainderY > 0,
    regions
  };
}
