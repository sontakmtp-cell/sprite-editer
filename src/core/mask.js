/**
 * Sprite Sheet Builder — Per-Cell Vector Eraser/Restore Mask Engine (Schema V3).
 * Pure logic, zero DOM dependency, deterministic hard-round brush rasterization,
 * polyline simplification, strict allowlist validation, and resource budgeting.
 */

import { LIMITS } from './constants.js';

const ALLOWED_STROKE_OPS = new Set(['erase', 'restore']);
const maskSigMemo = new WeakMap();

export function hasMaskStrokes(mask) {
  return Boolean(mask && Array.isArray(mask.strokes) && mask.strokes.length > 0);
}

export function hasCellMask(cell) {
  return Boolean(cell && hasMaskStrokes(cell.mask));
}

export function projectHasMasks(project) {
  if (!project || !project.cells) return false;
  for (const key of Object.keys(project.cells)) {
    if (hasCellMask(project.cells[key])) return true;
  }
  return false;
}

/**
 * Normalize cell mask: returns clean `{ strokes }` if non-empty, or `undefined` if empty.
 */
export function normalizeCellMask(mask) {
  if (!hasMaskStrokes(mask)) return undefined;
  return {
    strokes: mask.strokes.map((st) => ({
      op: st.op,
      radius: st.radius,
      points: st.points.map((pt) => [pt[0], pt[1]])
    }))
  };
}

/**
 * Round a coordinate to 2 decimal places for compact deterministic vector storage.
 */
export function roundMaskCoord(v) {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Deterministic collision-resistant signature for cache keying (source + crop + mask).
 * Uses WeakMap memoization for unchanged mask references plus dual 32-bit FNV-1a/djb2 hashes.
 */
export function getMaskSignature(mask) {
  if (!hasMaskStrokes(mask)) return '';
  if (typeof mask === 'object' && maskSigMemo.has(mask)) {
    return maskSigMemo.get(mask);
  }

  let h1 = 0x811c9dc5;
  let h2 = 5381;
  let totalPoints = 0;

  const mixInt = (n) => {
    const u = n | 0;
    h1 = Math.imul(h1 ^ (u & 0xff), 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ ((u >>> 8) & 0xff), 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ ((u >>> 16) & 0xff), 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ ((u >>> 24) & 0xff), 0x01000193) >>> 0;
    h2 = (((h2 << 5) + h2) ^ u) >>> 0;
  };

  const strokes = mask.strokes;
  mixInt(strokes.length);
  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    mixInt(st.op === 'restore' ? 2 : 1);
    mixInt(Math.round(st.radius * 1000));
    const pts = st.points;
    mixInt(pts.length);
    totalPoints += pts.length;
    for (let j = 0; j < pts.length; j++) {
      mixInt(Math.round(pts[j][0] * 100));
      mixInt(Math.round(pts[j][1] * 100));
    }
  }

  const sig = `m${strokes.length}_${totalPoints}_${h1.toString(16)}_${h2.toString(16)}`;
  if (typeof mask === 'object') {
    maskSigMemo.set(mask, sig);
  }
  return sig;
}

/**
 * Perpendicular distance squared from point P to segment AB.
 */
function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Ramer-Douglas-Peucker polyline simplification (iterative, preserves endpoints).
 * Never alters 1-point or 2-point strokes.
 */
export function simplifyStrokePoints(points, epsilon = 0.25) {
  if (!Array.isArray(points) || points.length <= 2 || epsilon <= 0) {
    return points ? points.map((p) => [p[0], p[1]]) : [];
  }

  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const epsSq = epsilon * epsilon;
  const stack = [[0, n - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    if (end - start <= 1) continue;

    const ax = points[start][0];
    const ay = points[start][1];
    const bx = points[end][0];
    const by = points[end][1];

    let maxDistSq = -1;
    let maxIdx = -1;

    for (let i = start + 1; i < end; i++) {
      const dSq = pointToSegmentDistSq(points[i][0], points[i][1], ax, ay, bx, by);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > epsSq && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push([points[i][0], points[i][1]]);
  }
  return out;
}

/**
 * Compute serialized JSON UTF-8 byte length of a mask object.
 */
export function measureMaskJsonBytes(mask) {
  if (!hasMaskStrokes(mask)) return 0;
  const str = JSON.stringify(mask);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  return str.length;
}

/**
 * Compute stroke count, point count, and serialized byte size of a single cell mask.
 */
export function estimateMaskStats(mask) {
  if (!hasMaskStrokes(mask)) {
    return { strokes: 0, points: 0, bytes: 0 };
  }
  let points = 0;
  for (let i = 0; i < mask.strokes.length; i++) {
    points += mask.strokes[i].points.length;
  }
  return {
    strokes: mask.strokes.length,
    points,
    bytes: measureMaskJsonBytes(mask)
  };
}

/**
 * Compute total mask usage across the whole project (optionally excluding one cell being edited).
 */
export function estimateProjectMaskUsage(project, excludeCellKey = null) {
  let strokes = 0;
  let points = 0;
  let bytes = 0;
  if (!project || !project.cells) return { strokes, points, bytes };
  for (const key of Object.keys(project.cells)) {
    if (key === excludeCellKey) continue;
    const cell = project.cells[key];
    if (!hasCellMask(cell)) continue;
    const st = estimateMaskStats(cell.mask);
    strokes += st.strokes;
    points += st.points;
    bytes += st.bytes;
  }
  return { strokes, points, bytes };
}

/**
 * Check whether a candidate cell mask fits within per-stroke, per-cell, and project-wide budgets.
 * Never silently truncates; returns explicit Vietnamese error when any limit is exceeded.
 */
export function checkMaskBudget(project, activeCellKey, candidateMask) {
  if (!hasMaskStrokes(candidateMask)) return { ok: true };

  if (candidateMask.strokes.length > LIMITS.MAX_MASK_STROKES_PER_CELL) {
    return {
      ok: false,
      code: 'CELL_MAX_STROKES',
      message: `Ô này đã đạt giới hạn tối đa ${LIMITS.MAX_MASK_STROKES_PER_CELL} nét tẩy/khôi phục.`
    };
  }

  let cellPoints = 0;
  for (let i = 0; i < candidateMask.strokes.length; i++) {
    const pts = candidateMask.strokes[i].points;
    if (pts.length > LIMITS.MAX_MASK_POINTS_PER_STROKE) {
      return {
        ok: false,
        code: 'STROKE_MAX_POINTS',
        message: `Nét vẽ đã đạt giới hạn tối đa ${LIMITS.MAX_MASK_POINTS_PER_STROKE} điểm — hãy nhả chuột để kết thúc nét.`
      };
    }
    cellPoints += pts.length;
  }

  if (cellPoints > LIMITS.MAX_MASK_POINTS_PER_CELL) {
    return {
      ok: false,
      code: 'CELL_MAX_POINTS',
      message: `Ô này đã đạt giới hạn tối đa ${LIMITS.MAX_MASK_POINTS_PER_CELL.toLocaleString('vi-VN')} điểm mặt nạ.`
    };
  }

  const otherUsage = estimateProjectMaskUsage(project, activeCellKey);
  const cellBytes = measureMaskJsonBytes(candidateMask);

  if (otherUsage.strokes + candidateMask.strokes.length > LIMITS.MAX_PROJECT_MASK_STROKES) {
    return {
      ok: false,
      code: 'PROJECT_MAX_STROKES',
      message: `Project đã đạt giới hạn tổng ${LIMITS.MAX_PROJECT_MASK_STROKES.toLocaleString('vi-VN')} nét mặt nạ.`
    };
  }
  if (otherUsage.points + cellPoints > LIMITS.MAX_PROJECT_MASK_POINTS) {
    return {
      ok: false,
      code: 'PROJECT_MAX_POINTS',
      message: `Project đã đạt giới hạn tổng ${LIMITS.MAX_PROJECT_MASK_POINTS.toLocaleString('vi-VN')} điểm mặt nạ.`
    };
  }
  if (otherUsage.bytes + cellBytes > LIMITS.MAX_PROJECT_MASK_BYTES) {
    return {
      ok: false,
      code: 'PROJECT_MAX_BYTES',
      message: `Tổng dung lượng dữ liệu mặt nạ trong project đã vượt giới hạn ${(LIMITS.MAX_PROJECT_MASK_BYTES / (1024 * 1024)).toFixed(0)} MiB.`
    };
  }

  return {
    ok: true,
    cellStrokes: candidateMask.strokes.length,
    cellPoints,
    cellBytes
  };
}

/**
 * Strict allowlist validator for a single cell's `mask` object in Schema V3.
 * Checks types, allowed keys, finite numbers, radius range, source coordinate bounds,
 * per-stroke & per-cell limits, and returns stats for project-wide budget accumulation.
 */
export function validateCellMaskStrict(mask, source, cellPath) {
  const errors = [];
  if (mask === null || typeof mask !== 'object' || Array.isArray(mask)) {
    return { ok: false, errors: [`${cellPath}.mask phải là object.`], strokes: 0, points: 0, bytes: 0 };
  }
  const proto = Object.getPrototypeOf(mask);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, errors: [`${cellPath}.mask không phải plain object.`], strokes: 0, points: 0, bytes: 0 };
  }
  for (const k of Object.keys(mask)) {
    if (k !== 'strokes') {
      errors.push(`Trường không được phép tại ${cellPath}.mask: "${k}".`);
    }
  }
  if (!Array.isArray(mask.strokes)) {
    errors.push(`${cellPath}.mask.strokes phải là mảng.`);
    return { ok: false, errors, strokes: 0, points: 0, bytes: 0 };
  }
  if (mask.strokes.length > LIMITS.MAX_MASK_STROKES_PER_CELL) {
    errors.push(`${cellPath}.mask.strokes (${mask.strokes.length}) vượt giới hạn ${LIMITS.MAX_MASK_STROKES_PER_CELL} nét/ô.`);
    return { ok: false, errors, strokes: mask.strokes.length, points: 0, bytes: 0 };
  }

  const maxW = source?.width ?? 0;
  const maxH = source?.height ?? 0;
  const allowedStrokeKeys = new Set(['op', 'radius', 'points']);
  let totalPoints = 0;

  for (let i = 0; i < mask.strokes.length; i++) {
    const st = mask.strokes[i];
    const stPath = `${cellPath}.mask.strokes[${i}]`;
    if (st === null || typeof st !== 'object' || Array.isArray(st)) {
      errors.push(`${stPath} không hợp lệ.`);
      break;
    }
    const stProto = Object.getPrototypeOf(st);
    if (stProto !== Object.prototype && stProto !== null) {
      errors.push(`${stPath} không phải plain object.`);
      break;
    }
    let badKey = false;
    for (const k of Object.keys(st)) {
      if (!allowedStrokeKeys.has(k)) {
        errors.push(`Trường không được phép tại ${stPath}: "${k}".`);
        badKey = true;
      }
    }
    if (badKey) break;

    if (!ALLOWED_STROKE_OPS.has(st.op)) {
      errors.push(`${stPath}.op phải là "erase" hoặc "restore".`);
      break;
    }
    if (
      typeof st.radius !== 'number' ||
      !Number.isFinite(st.radius) ||
      st.radius < LIMITS.MIN_MASK_RADIUS ||
      st.radius > LIMITS.MAX_MASK_RADIUS
    ) {
      errors.push(`${stPath}.radius phải nằm trong [${LIMITS.MIN_MASK_RADIUS}, ${LIMITS.MAX_MASK_RADIUS}].`);
      break;
    }
    if (!Array.isArray(st.points) || st.points.length < 1 || st.points.length > LIMITS.MAX_MASK_POINTS_PER_STROKE) {
      errors.push(`${stPath}.points phải là mảng từ 1 đến ${LIMITS.MAX_MASK_POINTS_PER_STROKE} điểm.`);
      break;
    }

    totalPoints += st.points.length;
    if (totalPoints > LIMITS.MAX_MASK_POINTS_PER_CELL) {
      errors.push(`${cellPath}.mask vượt giới hạn ${LIMITS.MAX_MASK_POINTS_PER_CELL} điểm/ô.`);
      break;
    }

    for (let j = 0; j < st.points.length; j++) {
      const pt = st.points[j];
      if (!Array.isArray(pt) || pt.length !== 2) {
        errors.push(`${stPath}.points[${j}] phải là cặp tọa độ [x, y].`);
        break;
      }
      const x = pt[0];
      const y = pt[1];
      if (
        typeof x !== 'number' || !Number.isFinite(x) ||
        typeof y !== 'number' || !Number.isFinite(y)
      ) {
        errors.push(`${stPath}.points[${j}] chứa số không hữu hạn.`);
        break;
      }
      if (x < 0 || y < 0 || x > maxW || y > maxH) {
        errors.push(`${stPath}.points[${j}] (${x}, ${y}) nằm ngoài phạm vi ảnh nguồn (${maxW}×${maxH}).`);
        break;
      }
    }
    if (errors.length > 0) break;
  }

  const bytes = errors.length === 0 ? measureMaskJsonBytes(mask) : 0;
  return {
    ok: errors.length === 0,
    errors,
    strokes: mask.strokes.length,
    points: totalPoints,
    bytes
  };
}

/**
 * Rasterize a single hard-round brush segment (p0 -> p1) in EXIF-oriented source coordinates
 * into a local crop alpha mask buffer `maskAlpha` (Uint8Array of length width * height).
 * - `op === 'erase'` writes 0 (transparent)
 * - `op === 'restore'` writes 255 (preserve exact original alpha)
 * Handles 1-point clicks, 1px brushes (radius=0.5), and fast long drags with zero gaps.
 */
export function rasterizeStrokeSegmentIntoAlpha(maskAlpha, width, height, regionX, regionY, op, radius, p0, p1) {
  if (!maskAlpha || width <= 0 || height <= 0 || !p0 || !p1) return;
  const val = op === 'restore' ? 255 : 0;

  // Convert source pixel coords into crop-local coords
  const ax = p0[0] - regionX;
  const ay = p0[1] - regionY;
  const bx = p1[0] - regionX;
  const by = p1[1] - regionY;

  // Stamp exact pixel(s) for very small brushes (radius < 0.75, e.g. 1px diameter = 0.5 radius)
  // so clicking or dragging a 1px brush never misses due to sub-pixel center distance > 0.5.
  if (radius < 0.75) {
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist * 2));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const sx = ax + dx * t;
      const sy = ay + dy * t;
      let px = Math.floor(sx);
      let py = Math.floor(sy);
      if (px === width && sx === width) px = width - 1;
      if (py === height && sy === height) py = height - 1;
      if (px >= 0 && px < width && py >= 0 && py < height) {
        maskAlpha[py * width + px] = val;
      }
    }
    if (radius <= 0.5) return;
  }

  // Tight bounding box intersected with crop [0, width-1] x [0, height-1]
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radius));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + radius));
  if (minX > maxX || minY > maxY) return;

  const rSq = radius * radius;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq <= 1e-12) {
    // 1-point circle
    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5 - ay;
      const cySq = cy * cy;
      if (cySq > rSq) continue;
      const rowOff = py * width;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5 - ax;
        if (cx * cx + cySq <= rSq) {
          maskAlpha[rowOff + px] = val;
        }
      }
    }
    return;
  }

  const invLenSq = 1 / lenSq;
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    const rowOff = py * width;
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      let t = ((cx - ax) * dx + (cy - ay) * dy) * invLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = cx - (ax + t * dx);
      const ey = cy - (ay + t * dy);
      if (ex * ex + ey * ey <= rSq) {
        maskAlpha[rowOff + px] = val;
      }
    }
  }
}

/**
 * Rasterize an ordered list of mask strokes onto a crop-sized alpha mask buffer (Uint8Array).
 * Starts at 255 ("keep all original pixels"), then replays erase (0) / restore (255) in order.
 */
export function rasterizeMaskAlpha(width, height, regionX, regionY, strokes) {
  const maskAlpha = new Uint8Array(width * height);
  maskAlpha.fill(255);
  if (!Array.isArray(strokes) || strokes.length === 0) return maskAlpha;

  for (let i = 0; i < strokes.length; i++) {
    const st = strokes[i];
    const pts = st.points;
    if (!pts || pts.length === 0) continue;
    if (pts.length === 1) {
      rasterizeStrokeSegmentIntoAlpha(maskAlpha, width, height, regionX, regionY, st.op, st.radius, pts[0], pts[0]);
    } else {
      for (let j = 1; j < pts.length; j++) {
        rasterizeStrokeSegmentIntoAlpha(maskAlpha, width, height, regionX, regionY, st.op, st.radius, pts[j - 1], pts[j]);
      }
    }
  }
  return maskAlpha;
}

/**
 * Pure RGBA buffer mask multiplication (for Node.js unit tests and non-DOM verification).
 * Never adds alpha to originally transparent pixels; preserves exact RGB & alpha where kept.
 */
export function applyMaskAlphaToRGBA(srcRgba, maskAlpha) {
  const out = new Uint8Array(srcRgba.length);
  const pixelCount = maskAlpha.length;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    if (maskAlpha[i] === 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
    } else {
      out[o] = srcRgba[o];
      out[o + 1] = srcRgba[o + 1];
      out[o + 2] = srcRgba[o + 2];
      out[o + 3] = srcRgba[o + 3];
    }
  }
  return out;
}
