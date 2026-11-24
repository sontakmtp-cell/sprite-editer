/**
 * Sprite Sheet Builder V2.0 — Transform Sync Engine (Spec §6.5).
 * Supports:
 * 1. copy-transform (all, zoom-only, offset-only)
 * 2. sync-scale (match reference rendered alpha height or width; never auto-clamps)
 * 3. sync-anchor (align target's own anchor to reference anchorOut or guides/custom target)
 * 4. sync-scale-and-anchor (mode 2 then mode 3 in a single preview & transaction)
 */

import { deepClone, parseCellKey } from './constants.js';
import {
  computeCellGeometry,
  computeAlignAnchorOffset,
  computeSyncZoom,
  analyzeRectInCell
} from './geometry.js';

/**
 * Plan a Transform Sync operation across target cell keys.
 *
 * @param {object} params
 * @param {object} params.project
 * @param {string} params.referenceKey  e.g. "0:0"
 * @param {string[]} params.targetKeys  e.g. ["0:1", "0:2", ...]
 * @param {'copy-transform'|'sync-scale'|'sync-anchor'|'sync-scale-and-anchor'} params.mode
 * @param {'all'|'zoom'|'offset'} [params.copyFields='all']
 * @param {'height'|'width'} [params.scaleDimension='height']
 * @param {'reference-anchor'|'guides'|'custom'} [params.anchorTargetType='reference-anchor']
 * @param {'both'|'x'|'y'} [params.anchorAxis='both']
 * @param {{x:number, y:number}} [params.customTargetPx]
 * @param {{x:number, y:number}} [params.activeGuidesNormalized]
 * @param {function} params.getAlphaBounds  (assetId, threshold) => {x,y,w,h}|null
 * @param {boolean} [params.skipInvalidConfirmed=false]
 */
export function planTransformSync({
  project,
  referenceKey,
  targetKeys,
  mode,
  copyFields = 'all',
  scaleDimension = 'height',
  anchorTargetType = 'reference-anchor',
  anchorAxis = 'both',
  customTargetPx = null,
  activeGuidesNormalized = null,
  getAlphaBounds,
  skipInvalidConfirmed = false
}) {
  const { cellWidth, cellHeight } = project.grid;
  const refCell = project.cells[referenceKey];
  if (!refCell) {
    return { ok: false, fatalError: 'Ô tham chiếu trống hoặc không tồn tại.', items: [], updates: {} };
  }
  const refAsset = project.assets.find((a) => a.id === refCell.assetId);
  if (!refAsset) {
    return { ok: false, fatalError: 'Asset của ô tham chiếu không tồn tại.', items: [], updates: {} };
  }

  const refAlpha = getAlphaBounds(refAsset.id, refCell.alphaThreshold);
  const refGeom = computeCellGeometry({
    cellWidth,
    cellHeight,
    region: refAsset.region,
    transform: refCell,
    alphaBounds: refAlpha
  });
  if (!refGeom) {
    return { ok: false, fatalError: 'Không tính được hình học cho ô tham chiếu (kiểm tra Fit Alpha/bounds).', items: [], updates: {} };
  }

  const needsScale = mode === 'sync-scale' || mode === 'sync-scale-and-anchor';
  const needsAnchor = mode === 'sync-anchor' || mode === 'sync-scale-and-anchor';

  let targetRenderedDim = null;
  if (needsScale) {
    if (!refGeom.renderedAlphaRect) {
      return {
        ok: false,
        fatalError: 'Ô tham chiếu không có vùng alpha hợp lệ để đồng bộ tỷ lệ hiển thị.',
        items: [],
        updates: {}
      };
    }
    targetRenderedDim =
      scaleDimension === 'width'
        ? refGeom.renderedAlphaRect.w
        : refGeom.renderedAlphaRect.h;
  }

  let anchorTargetPx = null;
  if (needsAnchor) {
    if (anchorTargetType === 'reference-anchor') {
      if (!Number.isFinite(refGeom.anchorOutX) || !Number.isFinite(refGeom.anchorOutY)) {
        return {
          ok: false,
          fatalError: 'Ô tham chiếu không có anchor hợp lệ.',
          items: [],
          updates: {}
        };
      }
      anchorTargetPx = { x: refGeom.anchorOutX, y: refGeom.anchorOutY };
    } else if (anchorTargetType === 'guides') {
      const g = activeGuidesNormalized || project.settings.guides;
      anchorTargetPx = { x: g.x * cellWidth, y: g.y * cellHeight };
    } else if (anchorTargetType === 'custom' && customTargetPx) {
      anchorTargetPx = { x: customTargetPx.x, y: customTargetPx.y };
    } else {
      return { ok: false, fatalError: 'Đích anchor không hợp lệ.', items: [], updates: {} };
    }
  }

  const items = [];
  const updates = {};
  let skippedEmptyCount = 0;
  let errorCount = 0;
  let warningCount = 0;

  const uniqueKeys = [...new Set(targetKeys)];

  for (const key of uniqueKeys) {
    const pos = parseCellKey(key);
    const cell = project.cells[key];
    if (!cell) {
      skippedEmptyCount++;
      continue;
    }
    const asset = project.assets.find((a) => a.id === cell.assetId);
    if (!asset) {
      errorCount++;
      items.push({ key, pos, status: 'error', error: 'Thiếu asset nguồn.' });
      continue;
    }

    const nextCell = deepClone(cell);
    const warnings = [];
    const targetAlpha = getAlphaBounds(asset.id, nextCell.alphaThreshold);

    if (mode === 'copy-transform') {
      if (copyFields === 'all') {
        nextCell.fitMode = refCell.fitMode;
        nextCell.alphaThreshold = refCell.alphaThreshold;
        nextCell.zoom = refCell.zoom;
        nextCell.offsetX = refCell.offsetX;
        nextCell.offsetY = refCell.offsetY;
      } else if (copyFields === 'zoom') {
        nextCell.zoom = refCell.zoom;
      } else if (copyFields === 'offset') {
        nextCell.offsetX = refCell.offsetX;
        nextCell.offsetY = refCell.offsetY;
      }

      const checkAlpha = getAlphaBounds(asset.id, nextCell.alphaThreshold);
      if (nextCell.fitMode === 'alpha' && !checkAlpha) {
        errorCount++;
        items.push({ key, pos, status: 'error', error: 'Không có alpha bounds hợp lệ cho Fit Alpha.' });
        continue;
      }

      const nextGeom = computeCellGeometry({
        cellWidth,
        cellHeight,
        region: asset.region,
        transform: nextCell,
        alphaBounds: checkAlpha
      });
      if (!nextGeom) {
        errorCount++;
        items.push({ key, pos, status: 'error', error: 'Transform sau sao chép không hợp lệ.' });
        continue;
      }
      const clipCheck = analyzeRectInCell(
        nextGeom.renderedAlphaRect || { x: nextGeom.localX, y: nextGeom.localY, w: nextGeom.drawW, h: nextGeom.drawH },
        cellWidth,
        cellHeight
      );
      if (clipCheck.completelyOutside) warnings.push('Nhân vật hoàn toàn ngoài khung ô.');
      else if (clipCheck.clipped) warnings.push('Có phần nội dung vượt biên ô.');

      if (warnings.length > 0) warningCount++;
      updates[key] = nextCell;
      items.push({ key, pos, status: warnings.length ? 'warning' : 'ok', warnings, nextCell, nextGeom });
      continue;
    }

    // Mode 2 / Mode 3 / Mode 2+3
    let geom = computeCellGeometry({
      cellWidth,
      cellHeight,
      region: asset.region,
      transform: nextCell,
      alphaBounds: targetAlpha
    });
    if (!geom) {
      errorCount++;
      items.push({ key, pos, status: 'error', error: 'Không tính được hình học hiện tại của ô đích.' });
      continue;
    }

    if (needsScale) {
      if (!targetAlpha) {
        errorCount++;
        items.push({ key, pos, status: 'error', error: 'Ô đích không có alpha bounds hợp lệ để đồng bộ tỷ lệ.' });
        continue;
      }
      const alphaDim = scaleDimension === 'width' ? targetAlpha.w : targetAlpha.h;
      const syncRes = computeSyncZoom({
        targetRenderedDim,
        alphaDim,
        fit: geom.fit
      });
      if (!syncRes.ok) {
        errorCount++;
        items.push({
          key,
          pos,
          status: 'error',
          outOfRange: Boolean(syncRes.outOfRange),
          computedZoom: syncRes.zoomNew,
          error: syncRes.reason
        });
        continue;
      }
      nextCell.zoom = syncRes.zoomNew;
      geom = computeCellGeometry({
        cellWidth,
        cellHeight,
        region: asset.region,
        transform: nextCell,
        alphaBounds: targetAlpha
      });
    }

    if (needsAnchor) {
      // Use target's OWN anchor, never copy reference pixel coords across different sources (Spec §6.5)
      if (!geom || !geom.anchorSource) {
        errorCount++;
        items.push({ key, pos, status: 'error', error: 'Ô đích không có anchor hợp lệ (ví dụ thiếu alpha bounds cho đáy giữa alpha).' });
        continue;
      }
      const aligned = computeAlignAnchorOffset({
        cellWidth,
        cellHeight,
        centerX: geom.centerX,
        centerY: geom.centerY,
        scale: geom.scale,
        ax: geom.anchorSource.ax,
        ay: geom.anchorSource.ay,
        tx: anchorTargetPx.x,
        ty: anchorTargetPx.y,
        currentOffsetX: nextCell.offsetX,
        currentOffsetY: nextCell.offsetY,
        axis: anchorAxis
      });
      if (!aligned) {
        errorCount++;
        items.push({ key, pos, status: 'error', error: 'Không tính được offset căn anchor.' });
        continue;
      }
      nextCell.offsetX = aligned.offsetX;
      nextCell.offsetY = aligned.offsetY;
      geom = computeCellGeometry({
        cellWidth,
        cellHeight,
        region: asset.region,
        transform: nextCell,
        alphaBounds: targetAlpha
      });
    }

    const rectToCheck =
      geom.renderedAlphaRect || { x: geom.localX, y: geom.localY, w: geom.drawW, h: geom.drawH };
    const clipCheck = analyzeRectInCell(rectToCheck, cellWidth, cellHeight);
    if (clipCheck.completelyOutside) warnings.push('Nhân vật hoàn toàn ngoài khung ô.');
    else if (clipCheck.clipped) warnings.push('Có phần nội dung vượt biên ô.');

    if (warnings.length > 0) warningCount++;
    updates[key] = nextCell;
    items.push({ key, pos, status: warnings.length ? 'warning' : 'ok', warnings, nextCell, nextGeom: geom });
  }

  const validUpdateCount = Object.keys(updates).length;
  const blockedByErrors = errorCount > 0 && !skipInvalidConfirmed;

  return {
    ok: true,
    items,
    updates,
    validUpdateCount,
    skippedEmptyCount,
    errorCount,
    warningCount,
    blockedByErrors,
    canCommit: validUpdateCount > 0 && !blockedByErrors
  };
}
