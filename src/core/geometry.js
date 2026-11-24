/**
 * Sprite Sheet Builder V2.0 — Shared Geometry Engine (Spec §6 & §7).
 * Used identically by preview renderer, editor, transform sync, preflight, and export.
 */

import { LIMITS } from './constants.js';

/**
 * Compute alpha bounding box relative to region R=(0,0,rw,rh) from RGBA pixel buffer.
 * Includes pixels strictly exceeding alphaThreshold (0..254).
 * Returns { x, y, w, h } or null if no pixel exceeds threshold.
 */
export function computeAlphaBoundsFromRGBA(rgba, width, height, alphaThreshold = 8) {
  if (!rgba || width <= 0 || height <= 0) return null;
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < LIMITS.MIN_ALPHA_THRESHOLD || alphaThreshold > LIMITS.MAX_ALPHA_THRESHOLD) {
    throw new RangeError(`alphaThreshold không hợp lệ: ${alphaThreshold}`);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const a = rgba[rowOffset + x * 4 + 3];
      if (a > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1
  };
}

/**
 * Exact transparency check: returns true iff EVERY pixel has alpha === 0.
 * Distinct from heuristic alphaThreshold! (Spec §5.3 & §6.2)
 */
export function isCompletelyTransparentRGBA(rgba, width, height) {
  if (!rgba || width <= 0 || height <= 0) return true;
  const total = width * height * 4;
  for (let i = 3; i < total; i += 4) {
    if (rgba[i] !== 0) return false;
  }
  return true;
}

/**
 * Compute exact visible bounds (alpha > 0) for strict clipping detection.
 */
export function computeVisibleBoundsFromRGBA(rgba, width, height) {
  return computeAlphaBoundsFromRGBA(rgba, width, height, 0);
}

/**
 * Resolve fit box B = (bx, by, bw, bh) relative to region R = (rx, ry, rw, rh).
 * Returns null if fitMode === 'alpha' and alphaBounds is missing/invalid.
 */
export function resolveFitBox(region, fitMode, alphaBounds) {
  if (!region || region.w <= 0 || region.h <= 0) return null;
  if (fitMode === 'alpha') {
    if (!alphaBounds || alphaBounds.w <= 0 || alphaBounds.h <= 0) {
      return null;
    }
    return {
      bx: alphaBounds.x,
      by: alphaBounds.y,
      bw: alphaBounds.w,
      bh: alphaBounds.h
    };
  }
  return {
    bx: 0,
    by: 0,
    bw: region.w,
    bh: region.h
  };
}

/**
 * Resolve anchor point in source-region coordinates (relative to R).
 */
export function resolveAnchorSource(anchor, region, fitBox, alphaBounds) {
  const mode = anchor?.mode || 'fit-center';
  if (mode === 'custom') {
    const ax = Number(anchor.x);
    const ay = Number(anchor.y);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
    if (ax < 0 || ay < 0 || ax > region.w || ay > region.h) return null;
    return { ax, ay, mode: 'custom' };
  }
  if (mode === 'alpha-bottom-center') {
    if (!alphaBounds || alphaBounds.w <= 0 || alphaBounds.h <= 0) return null;
    return {
      ax: alphaBounds.x + alphaBounds.w / 2,
      ay: alphaBounds.y + alphaBounds.h,
      mode: 'alpha-bottom-center'
    };
  }
  // Default: 'fit-center'
  if (!fitBox) return null;
  return {
    ax: fitBox.bx + fitBox.bw / 2,
    ay: fitBox.by + fitBox.bh / 2,
    mode: 'fit-center'
  };
}

/**
 * Core mandatory geometry computation (Spec §7).
 * Never rounds intermediate values.
 *
 * @param {object} params
 * @param {number} params.cellWidth
 * @param {number} params.cellHeight
 * @param {number} [params.row=0]
 * @param {number} [params.col=0]
 * @param {{x:number,y:number,w:number,h:number}} params.region  Source region R
 * @param {{fitMode:string, zoom:number, offsetX:number, offsetY:number, anchor?:object}} params.transform
 * @param {{x:number,y:number,w:number,h:number}|null} [params.alphaBounds]
 * @returns {object|null}
 */
export function computeCellGeometry({
  cellWidth,
  cellHeight,
  row = 0,
  col = 0,
  region,
  transform,
  alphaBounds = null
}) {
  if (!Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }
  if (!region || !Number.isFinite(region.w) || !Number.isFinite(region.h) || region.w <= 0 || region.h <= 0) {
    return null;
  }
  const zoom = Number(transform?.zoom);
  const offsetX = Number(transform?.offsetX ?? 0);
  const offsetY = Number(transform?.offsetY ?? 0);
  const fitMode = transform?.fitMode || 'contain';

  if (!Number.isFinite(zoom) || zoom < LIMITS.MIN_ZOOM || zoom > LIMITS.MAX_ZOOM) {
    return null;
  }
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
    return null;
  }

  const fitBox = resolveFitBox(region, fitMode, alphaBounds);
  if (!fitBox || fitBox.bw <= 0 || fitBox.bh <= 0) {
    return null;
  }

  const fit = Math.min(cellWidth / fitBox.bw, cellHeight / fitBox.bh);
  const scale = fit * zoom;
  const centerX = fitBox.bx + fitBox.bw / 2;
  const centerY = fitBox.by + fitBox.bh / 2;
  const localX = cellWidth / 2 - centerX * scale + offsetX;
  const localY = cellHeight / 2 - centerY * scale + offsetY;
  const drawW = region.w * scale;
  const drawH = region.h * scale;
  const atlasX = col * cellWidth;
  const atlasY = row * cellHeight;

  const anchorSource = resolveAnchorSource(transform?.anchor, region, fitBox, alphaBounds);
  const anchorOutX = anchorSource ? localX + anchorSource.ax * scale : null;
  const anchorOutY = anchorSource ? localY + anchorSource.ay * scale : null;

  let renderedAlphaRect = null;
  if (alphaBounds && alphaBounds.w > 0 && alphaBounds.h > 0) {
    renderedAlphaRect = {
      x: localX + alphaBounds.x * scale,
      y: localY + alphaBounds.y * scale,
      w: alphaBounds.w * scale,
      h: alphaBounds.h * scale
    };
  }

  return {
    fitBox,
    fit,
    scale,
    centerX,
    centerY,
    localX,
    localY,
    drawW,
    drawH,
    atlasX,
    atlasY,
    destX: atlasX + localX,
    destY: atlasY + localY,
    anchorSource,
    anchorOutX,
    anchorOutY,
    renderedAlphaRect
  };
}

/**
 * Align anchor (ax, ay) to target (tx, ty) in cell coordinates without changing scale (Spec §7).
 * Supports aligning both axes, X only, or Y only.
 */
export function computeAlignAnchorOffset({
  cellWidth,
  cellHeight,
  centerX,
  centerY,
  scale,
  ax,
  ay,
  tx,
  ty,
  currentOffsetX = 0,
  currentOffsetY = 0,
  axis = 'both' // 'both' | 'x' | 'y'
}) {
  if (
    !Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) ||
    !Number.isFinite(centerX) || !Number.isFinite(centerY) ||
    !Number.isFinite(scale) || scale <= 0 ||
    !Number.isFinite(ax) || !Number.isFinite(ay)
  ) {
    return null;
  }

  let offsetX = currentOffsetX;
  let offsetY = currentOffsetY;

  if (axis === 'both' || axis === 'x') {
    if (!Number.isFinite(tx)) return null;
    offsetX = tx - cellWidth / 2 + (centerX - ax) * scale;
  }
  if (axis === 'both' || axis === 'y') {
    if (!Number.isFinite(ty)) return null;
    offsetY = ty - cellHeight / 2 + (centerY - ay) * scale;
  }

  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  return { offsetX, offsetY };
}

/**
 * Compute new zoom so target cell's alpha dimension (height or width) matches targetRenderedDim (Spec §7).
 * Never auto-clamps; returns outOfRange flag if outside [0.25, 4.0].
 */
export function computeSyncZoom({ targetRenderedDim, alphaDim, fit }) {
  if (!Number.isFinite(targetRenderedDim) || targetRenderedDim <= 0) {
    return { ok: false, reason: 'Kích thước mục tiêu không hợp lệ.' };
  }
  if (!Number.isFinite(alphaDim) || alphaDim <= 0) {
    return { ok: false, reason: 'Vùng alpha đích không hợp lệ hoặc trống.' };
  }
  if (!Number.isFinite(fit) || fit <= 0) {
    return { ok: false, reason: 'Hệ số fit không hợp lệ.' };
  }

  const zoomNew = targetRenderedDim / (alphaDim * fit);
  if (!Number.isFinite(zoomNew)) {
    return { ok: false, reason: 'Zoom tính ra không hữu hạn.' };
  }
  if (zoomNew < LIMITS.MIN_ZOOM || zoomNew > LIMITS.MAX_ZOOM) {
    return {
      ok: false,
      outOfRange: true,
      zoomNew,
      reason: `Zoom cần thiết (${(zoomNew * 100).toFixed(1)}%) vượt giới hạn ${Math.round(LIMITS.MIN_ZOOM * 100)}%–${Math.round(LIMITS.MAX_ZOOM * 100)}%.`
    };
  }
  return { ok: true, zoomNew };
}

/**
 * Scale cell offsets proportionally when changing cell dimensions (Spec §4.1).
 */
export function scaleOffsetsForCellResize(offsetX, offsetY, oldW, oldH, newW, newH) {
  return {
    offsetX: offsetX * (newW / oldW),
    offsetY: offsetY * (newH / oldH)
  };
}

/**
 * Check whether a rendered rect is clipped by cell bounds [0, cellWidth] x [0, cellHeight]
 * or completely outside the cell.
 * Uses small epsilon (1e-4) to avoid floating-point false positives on exact edge fits.
 */
export function analyzeRectInCell(rect, cellWidth, cellHeight, eps = 1e-4) {
  if (!rect || rect.w <= 0 || rect.h <= 0) {
    return { clipped: false, completelyOutside: true };
  }
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;

  const completelyOutside =
    right <= eps ||
    left >= cellWidth - eps ||
    bottom <= eps ||
    top >= cellHeight - eps;

  const clipped =
    !completelyOutside &&
    (left < -eps || top < -eps || right > cellWidth + eps || bottom > cellHeight + eps);

  return { clipped, completelyOutside };
}
