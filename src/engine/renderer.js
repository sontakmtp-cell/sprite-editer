/**
 * Sprite Sheet Builder V2.0 — Shared Canvas Renderer (Spec §2.2, §7, §11.2).
 * Preview (Grid, Editor, Onion Skin, Animation) and Export share this exact cell draw routine.
 */

import { computeCellGeometry } from '../core/geometry.js';

/**
 * Draw a single sprite cell onto any 2D canvas context with strict cell clipping
 * and shared geometry calculation.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} params
 * @param {number} params.cellWidth
 * @param {number} params.cellHeight
 * @param {number} [params.originX=0]   Destination top-left X of the cell on ctx
 * @param {number} [params.originY=0]   Destination top-left Y of the cell on ctx
 * @param {object} params.region        Asset region {x, y, w, h}
 * @param {object} params.transform     Cell transform {fitMode, zoom, offsetX, offsetY, anchor}
 * @param {object|null} [params.alphaBounds]
 * @param {{bitmap:CanvasImageSource, drawRegion:{x:number,y:number,w:number,h:number}}} params.drawable
 * @param {boolean} [params.smoothing=true]
 * @param {number} [params.globalAlpha=1]
 * @returns {object|null} geometry result
 */
export function drawCellOnContext(ctx, {
  cellWidth,
  cellHeight,
  originX = 0,
  originY = 0,
  region,
  transform,
  alphaBounds = null,
  drawable,
  smoothing = true,
  globalAlpha = 1
}) {
  if (!drawable || !drawable.bitmap) return null;

  const geom = computeCellGeometry({
    cellWidth,
    cellHeight,
    row: 0,
    col: 0,
    region,
    transform,
    alphaBounds
  });
  if (!geom) return null;

  const dr = drawable.drawRegion;

  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(originX, originY, cellWidth, cellHeight);
    ctx.clip();
    ctx.imageSmoothingEnabled = Boolean(smoothing);
    if (smoothing && 'imageSmoothingQuality' in ctx) {
      ctx.imageSmoothingQuality = 'high';
    }
    if (globalAlpha !== 1) {
      ctx.globalAlpha = globalAlpha;
    }
    ctx.drawImage(
      drawable.bitmap,
      dr.x,
      dr.y,
      dr.w,
      dr.h,
      originX + geom.localX,
      originY + geom.localY,
      geom.drawW,
      geom.drawH
    );
  } finally {
    ctx.restore();
  }

  return geom;
}

/**
 * Draw checkerboard transparency pattern onto a canvas rectangle (preview ONLY — never exported).
 */
export function drawCheckerboard(ctx, x, y, w, h, tileSize = 12, colorA = '#2a2d34', colorB = '#22252b') {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = colorA;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = colorB;

  const startCol = Math.floor(x / tileSize);
  const endCol = Math.ceil((x + w) / tileSize);
  const startRow = Math.floor(y / tileSize);
  const endRow = Math.ceil((y + h) / tileSize);

  for (let r = startRow; r < endRow; r++) {
    for (let c = startCol; c < endCol; c++) {
      if ((r + c) % 2 === 0) {
        ctx.fillRect(c * tileSize, r * tileSize, tileSize, tileSize);
      }
    }
  }
  ctx.restore();
}

/**
 * Draw normalized guide lines (vertical center & horizontal baseline) inside a cell rect (preview ONLY).
 */
export function drawCellGuides(ctx, x, y, w, h, guides, scale = 1) {
  if (!guides) return;
  const gx = x + guides.x * w;
  const gy = y + guides.y * h;
  ctx.save();
  ctx.lineWidth = Math.max(1 / scale, 1);
  ctx.setLineDash([4 / scale, 3 / scale]);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
  ctx.beginPath();
  ctx.moveTo(gx, y);
  ctx.lineTo(gx, y + h);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(251, 146, 60, 0.9)';
  ctx.beginPath();
  ctx.moveTo(x, gy);
  ctx.lineTo(x + w, gy);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(251, 146, 60, 0.95)';
  ctx.beginPath();
  ctx.arc(gx, gy, 3 / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw anchor crosshair marker at cell-output coordinates (preview ONLY).
 */
export function drawAnchorMarker(ctx, originX, originY, anchorOutX, anchorOutY, scale = 1, color = '#22c55e') {
  if (!Number.isFinite(anchorOutX) || !Number.isFinite(anchorOutY)) return;
  const px = originX + anchorOutX;
  const py = originY + anchorOutY;
  const r = 6 / scale;
  ctx.save();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3 / scale;
  ctx.beginPath();
  ctx.moveTo(px - r, py);
  ctx.lineTo(px + r, py);
  ctx.moveTo(px, py - r);
  ctx.lineTo(px, py + r);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75 / scale;
  ctx.beginPath();
  ctx.moveTo(px - r, py);
  ctx.lineTo(px + r, py);
  ctx.moveTo(px, py - r);
  ctx.lineTo(px, py + r);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(px, py, 3.2 / scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
