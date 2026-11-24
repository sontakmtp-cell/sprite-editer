/**
 * Sprite Sheet Builder V2.0 — Strict Allowlist Schema Validators (Spec §10.1, §12.1, §12.3).
 * Protects against prototype pollution, excessive nesting, NaN/Infinity, duplicate IDs,
 * dangling references, out-of-bounds regions, and resource limit violations.
 */

import {
  LIMITS,
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  PRESET_FORMAT,
  PRESET_SCHEMA_VERSION,
  ATLAS_FORMAT,
  ATLAS_SCHEMA_VERSION,
  parseCellKey,
  isCellInGrid
} from './constants.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_PATH_RE = /^sources\/([A-Za-z0-9_-]+)\.(png|webp|jpg|jpeg)$/;
const ALLOWED_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg']);
const ALLOWED_FIT_MODES = new Set(['contain', 'alpha']);
const ALLOWED_ANCHOR_MODES = new Set(['fit-center', 'alpha-bottom-center', 'custom']);
const ALLOWED_LOOP_MODES = new Set(['loop', 'once', 'pingpong']);

function isPlainObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function checkDepthAndKeys(value, depth = 0) {
  if (depth > LIMITS.MAX_JSON_DEPTH) {
    return `Độ sâu JSON vượt quá giới hạn (${LIMITS.MAX_JSON_DEPTH}).`;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = checkDepthAndKeys(value[i], depth + 1);
      if (err) return err;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `Phát hiện khóa không an toàn: ${key}`;
    }
    const err = checkDepthAndKeys(value[key], depth + 1);
    if (err) return err;
  }
  return null;
}

function checkAllowedKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      return `Trường không được phép tại ${path}: "${k}".`;
    }
  }
  return null;
}

/**
 * Validate grid configuration against V2.0 hard limits (Spec §4.1, §12.1).
 */
export function validateGrid(grid) {
  const errors = [];
  if (!isPlainObject(grid)) {
    return { ok: false, errors: ['Cấu hình lưới không hợp lệ.'], needsLargeExportConfirm: false };
  }
  const extraKeyErr = checkAllowedKeys(grid, new Set(['cols', 'rows', 'cellWidth', 'cellHeight']), 'grid');
  if (extraKeyErr) errors.push(extraKeyErr);

  const { cols, rows, cellWidth, cellHeight } = grid;
  if (!Number.isInteger(cols) || cols < 1 || cols > LIMITS.MAX_COLS) {
    errors.push(`Số cột phải là số nguyên từ 1 đến ${LIMITS.MAX_COLS}.`);
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > LIMITS.MAX_ROWS) {
    errors.push(`Số hàng phải là số nguyên từ 1 đến ${LIMITS.MAX_ROWS}.`);
  }
  if (!Number.isInteger(cellWidth) || cellWidth < 1 || cellWidth > LIMITS.MAX_ATLAS_DIM) {
    errors.push(`Chiều rộng ô phải là số nguyên từ 1 đến ${LIMITS.MAX_ATLAS_DIM} px.`);
  }
  if (!Number.isInteger(cellHeight) || cellHeight < 1 || cellHeight > LIMITS.MAX_ATLAS_DIM) {
    errors.push(`Chiều cao ô phải là số nguyên từ 1 đến ${LIMITS.MAX_ATLAS_DIM} px.`);
  }

  let atlasWidth = 0;
  let atlasHeight = 0;
  let totalCells = 0;
  let atlasPixels = 0;
  let needsLargeExportConfirm = false;

  if (errors.length === 0) {
    totalCells = cols * rows;
    atlasWidth = cols * cellWidth;
    atlasHeight = rows * cellHeight;
    atlasPixels = atlasWidth * atlasHeight;

    if (totalCells > LIMITS.MAX_CELLS) {
      errors.push(`Tổng số ô (${totalCells}) vượt giới hạn ${LIMITS.MAX_CELLS} ô.`);
    }
    if (atlasWidth > LIMITS.MAX_ATLAS_DIM || atlasHeight > LIMITS.MAX_ATLAS_DIM) {
      errors.push(`Kích thước atlas (${atlasWidth}×${atlasHeight} px) vượt giới hạn ${LIMITS.MAX_ATLAS_DIM} px mỗi chiều.`);
    }
    if (atlasPixels > LIMITS.MAX_ATLAS_PIXELS) {
      errors.push(`Tổng pixel atlas (${atlasPixels.toLocaleString('vi-VN')}) vượt giới hạn ${LIMITS.MAX_ATLAS_PIXELS.toLocaleString('vi-VN')} (32 Mi pixel).`);
    }
    if (
      atlasWidth > LIMITS.SAFE_EXPORT_DIM ||
      atlasHeight > LIMITS.SAFE_EXPORT_DIM ||
      atlasPixels > LIMITS.SAFE_EXPORT_PIXELS
    ) {
      needsLargeExportConfirm = true;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    atlasWidth,
    atlasHeight,
    totalCells,
    atlasPixels,
    needsLargeExportConfirm
  };
}

function validateGuides(guides, path, allowNull = false) {
  if (allowNull && guides === null) return null;
  if (!isPlainObject(guides)) return `${path} không hợp lệ.`;
  const kErr = checkAllowedKeys(guides, new Set(['x', 'y']), path);
  if (kErr) return kErr;
  if (typeof guides.x !== 'number' || !Number.isFinite(guides.x) || guides.x < 0 || guides.x > 1) {
    return `${path}.x phải nằm trong [0, 1].`;
  }
  if (typeof guides.y !== 'number' || !Number.isFinite(guides.y) || guides.y < 0 || guides.y > 1) {
    return `${path}.y phải nằm trong [0, 1].`;
  }
  return null;
}

/**
 * Validate Custom Preset V1 JSON (Spec §4.3).
 */
export function validatePresetV1(raw) {
  const depthErr = checkDepthAndKeys(raw);
  if (depthErr) return { ok: false, errors: [depthErr] };
  if (!isPlainObject(raw)) return { ok: false, errors: ['Preset phải là JSON object.'] };

  const errors = [];
  const allowed = new Set([
    'format', 'schemaVersion', 'id', 'name', 'description',
    'grid', 'expectedCells', 'defaultFps', 'guides', 'animations'
  ]);
  const kErr = checkAllowedKeys(raw, allowed, 'preset');
  if (kErr) errors.push(kErr);

  if (raw.format !== PRESET_FORMAT) errors.push(`Định dạng preset không hợp lệ: ${raw.format}`);
  if (raw.schemaVersion !== PRESET_SCHEMA_VERSION) {
    errors.push(`Phiên bản schema preset (${raw.schemaVersion}) không được hỗ trợ (yêu cầu ${PRESET_SCHEMA_VERSION}).`);
  }
  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id)) {
    errors.push('ID preset không hợp lệ.');
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 128) {
    errors.push('Tên preset phải từ 1 đến 128 ký tự.');
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) {
    errors.push('Mô tả preset không hợp lệ.');
  }

  const gRes = validateGrid(raw.grid);
  if (!gRes.ok) errors.push(...gRes.errors);

  if (raw.defaultFps !== undefined) {
    if (typeof raw.defaultFps !== 'number' || !Number.isFinite(raw.defaultFps) || raw.defaultFps < LIMITS.MIN_FPS || raw.defaultFps > LIMITS.MAX_FPS) {
      errors.push(`defaultFps phải nằm trong ${LIMITS.MIN_FPS}–${LIMITS.MAX_FPS}.`);
    }
  }

  const guideErr = validateGuides(raw.guides, 'preset.guides', false);
  if (guideErr) errors.push(guideErr);

  if (!Array.isArray(raw.expectedCells)) {
    errors.push('expectedCells phải là mảng.');
  } else if (gRes.ok) {
    const seen = new Set();
    for (let i = 0; i < raw.expectedCells.length; i++) {
      const k = raw.expectedCells[i];
      const parsed = parseCellKey(k);
      if (!parsed || !isCellInGrid(parsed.row, parsed.col, raw.grid)) {
        errors.push(`expectedCells[${i}] (${k}) nằm ngoài lưới.`);
        break;
      }
      if (seen.has(k)) {
        errors.push(`expectedCells bị trùng ô ${k}.`);
        break;
      }
      seen.add(k);
    }
  }

  if (!Array.isArray(raw.animations) || raw.animations.length > LIMITS.MAX_ANIMATIONS) {
    errors.push(`animations phải là mảng tối đa ${LIMITS.MAX_ANIMATIONS} nhóm.`);
  } else if (gRes.ok) {
    let totalSlots = 0;
    for (let i = 0; i < raw.animations.length; i++) {
      const anim = raw.animations[i];
      if (!isPlainObject(anim)) {
        errors.push(`animations[${i}] không hợp lệ.`);
        break;
      }
      const akErr = checkAllowedKeys(anim, new Set(['name', 'fps', 'loopMode', 'guides', 'frames']), `preset.animations[${i}]`);
      if (akErr) { errors.push(akErr); break; }
      if (typeof anim.name !== 'string' || anim.name.trim().length === 0 || anim.name.length > 128) {
        errors.push(`animations[${i}].name không hợp lệ.`);
      }
      if (typeof anim.fps !== 'number' || !Number.isFinite(anim.fps) || anim.fps < LIMITS.MIN_FPS || anim.fps > LIMITS.MAX_FPS) {
        errors.push(`animations[${i}].fps không hợp lệ.`);
      }
      if (!ALLOWED_LOOP_MODES.has(anim.loopMode)) {
        errors.push(`animations[${i}].loopMode không hợp lệ.`);
      }
      if (anim.guides !== undefined) {
        const agErr = validateGuides(anim.guides, `preset.animations[${i}].guides`, true);
        if (agErr) errors.push(agErr);
      }
      if (!Array.isArray(anim.frames)) {
        errors.push(`animations[${i}].frames phải là mảng.`);
      } else {
        totalSlots += anim.frames.length;
        if (totalSlots > LIMITS.MAX_ANIMATION_SLOTS) {
          errors.push(`Tổng số slot animation vượt giới hạn ${LIMITS.MAX_ANIMATION_SLOTS}.`);
          break;
        }
        for (let j = 0; j < anim.frames.length; j++) {
          const f = anim.frames[j];
          if (!isPlainObject(f)) { errors.push(`animations[${i}].frames[${j}] không hợp lệ.`); break; }
          const fkErr = checkAllowedKeys(f, new Set(['row', 'col', 'durationMs']), `preset.animations[${i}].frames[${j}]`);
          if (fkErr) { errors.push(fkErr); break; }
          if (!isCellInGrid(f.row, f.col, raw.grid)) {
            errors.push(`animations[${i}].frames[${j}] vượt biên lưới.`);
            break;
          }
          if (f.durationMs !== null && (typeof f.durationMs !== 'number' || !Number.isFinite(f.durationMs) || f.durationMs < LIMITS.MIN_DURATION_MS || f.durationMs > LIMITS.MAX_DURATION_MS)) {
            errors.push(`animations[${i}].frames[${j}].durationMs không hợp lệ.`);
            break;
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate full Project Manifest V2 (Spec §10.1, §10.2, §12.3).
 * Returns sanitized clean copy (no prototype chain risks) when valid.
 */
export function validateProjectManifestV2(raw) {
  const depthErr = checkDepthAndKeys(raw);
  if (depthErr) return { ok: false, errors: [depthErr] };
  if (!isPlainObject(raw)) return { ok: false, errors: ['Manifest project phải là JSON object.'] };

  const errors = [];
  const allowedTop = new Set([
    'format', 'schemaVersion', 'projectId', 'name', 'grid', 'presetId',
    'expectedCells', 'sources', 'assets', 'cells', 'animations', 'settings', 'customPresets'
  ]);
  const topKeyErr = checkAllowedKeys(raw, allowedTop, 'manifest');
  if (topKeyErr) errors.push(topKeyErr);

  if (raw.format !== PROJECT_FORMAT) {
    errors.push(`Định dạng project không đúng (nhận "${raw.format}", cần "${PROJECT_FORMAT}").`);
  }
  if (raw.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    errors.push(`Phiên bản schema project (${raw.schemaVersion}) không được hỗ trợ. Ứng dụng hỗ trợ schemaVersion ${PROJECT_SCHEMA_VERSION}.`);
    return { ok: false, errors };
  }
  if (typeof raw.projectId !== 'string' || raw.projectId.trim().length === 0 || raw.projectId.length > 128) {
    errors.push('projectId không hợp lệ.');
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 200) {
    errors.push('Tên project không hợp lệ.');
  }
  if (raw.presetId !== null && (typeof raw.presetId !== 'string' || raw.presetId.length > 128)) {
    errors.push('presetId không hợp lệ.');
  }

  const gRes = validateGrid(raw.grid);
  if (!gRes.ok) errors.push(...gRes.errors);

  if (raw.expectedCells !== undefined && raw.expectedCells !== null) {
    if (!Array.isArray(raw.expectedCells)) {
      errors.push('expectedCells phải là mảng hoặc null.');
    } else if (gRes.ok) {
      const seen = new Set();
      for (const k of raw.expectedCells) {
        const p = parseCellKey(k);
        if (!p || !isCellInGrid(p.row, p.col, raw.grid) || seen.has(k)) {
          errors.push(`expectedCells chứa ô không hợp lệ hoặc trùng lặp: ${k}`);
          break;
        }
        seen.add(k);
      }
    }
  }

  // Sources
  const sourceMap = new Map();
  let totalSourcePixels = 0;
  let totalSourceBytes = 0;

  if (!Array.isArray(raw.sources)) {
    errors.push('sources phải là mảng.');
  } else if (raw.sources.length > LIMITS.MAX_SOURCES) {
    errors.push(`Số nguồn ảnh (${raw.sources.length}) vượt giới hạn ${LIMITS.MAX_SOURCES}.`);
  } else {
    const allowedSource = new Set(['id', 'name', 'path', 'mime', 'width', 'height', 'byteLength', 'importedAt', 'exifOrientation']);
    const seenPaths = new Set();
    for (let i = 0; i < raw.sources.length; i++) {
      const s = raw.sources[i];
      if (!isPlainObject(s)) { errors.push(`sources[${i}] không hợp lệ.`); continue; }
      const skErr = checkAllowedKeys(s, allowedSource, `sources[${i}]`);
      if (skErr) { errors.push(skErr); continue; }
      if (typeof s.id !== 'string' || !SAFE_ID_RE.test(s.id)) {
        errors.push(`sources[${i}].id không hợp lệ.`);
        continue;
      }
      if (sourceMap.has(s.id)) {
        errors.push(`Trùng source ID: "${s.id}".`);
        continue;
      }
      if (typeof s.name !== 'string' || s.name.length === 0 || s.name.length > 255) {
        errors.push(`sources[${i}].name không hợp lệ.`);
      }
      if (typeof s.path !== 'string' || !SOURCE_PATH_RE.test(s.path)) {
        errors.push(`sources[${i}].path không hợp lệ: "${s.path}".`);
      } else if (seenPaths.has(s.path)) {
        errors.push(`Trùng đường dẫn source: "${s.path}".`);
      } else {
        seenPaths.add(s.path);
      }
      if (!ALLOWED_MIMES.has(s.mime)) {
        errors.push(`sources[${i}].mime không được hỗ trợ: "${s.mime}".`);
      }
      if (!Number.isInteger(s.width) || s.width < 1 || s.width > LIMITS.MAX_SOURCE_DIM ||
          !Number.isInteger(s.height) || s.height < 1 || s.height > LIMITS.MAX_SOURCE_DIM) {
        errors.push(`sources[${i}] có kích thước vượt giới hạn (${s.width}×${s.height}).`);
      } else {
        const px = s.width * s.height;
        if (px > LIMITS.MAX_SOURCE_PIXELS) {
          errors.push(`sources[${i}] vượt giới hạn 16 Mi pixel.`);
        }
        totalSourcePixels += px;
      }
      if (!Number.isInteger(s.byteLength) || s.byteLength < 1 || s.byteLength > LIMITS.MAX_SOURCE_BYTES) {
        errors.push(`sources[${i}].byteLength không hợp lệ hoặc vượt 20 MiB.`);
      } else {
        totalSourceBytes += s.byteLength;
      }
      if (s.exifOrientation !== undefined && (!Number.isInteger(s.exifOrientation) || s.exifOrientation < 1 || s.exifOrientation > 8)) {
        errors.push(`sources[${i}].exifOrientation không hợp lệ.`);
      }
      sourceMap.set(s.id, s);
    }
    if (totalSourcePixels > LIMITS.MAX_PROJECT_SOURCE_PIXELS) {
      errors.push(`Tổng số pixel nguồn vượt giới hạn 256 Mi pixel.`);
    }
    if (totalSourceBytes > LIMITS.MAX_PROJECT_SOURCE_BYTES) {
      errors.push(`Tổng dung lượng nguồn vượt giới hạn 256 MiB.`);
    }
  }

  // Assets
  const assetMap = new Map();
  if (!Array.isArray(raw.assets)) {
    errors.push('assets phải là mảng.');
  } else if (raw.assets.length > LIMITS.MAX_ASSETS) {
    errors.push(`Số asset (${raw.assets.length}) vượt giới hạn ${LIMITS.MAX_ASSETS}.`);
  } else {
    const allowedAsset = new Set(['id', 'sourceId', 'name', 'isRegion', 'region']);
    const allowedRegion = new Set(['x', 'y', 'w', 'h']);
    for (let i = 0; i < raw.assets.length; i++) {
      const a = raw.assets[i];
      if (!isPlainObject(a)) { errors.push(`assets[${i}] không hợp lệ.`); continue; }
      const akErr = checkAllowedKeys(a, allowedAsset, `assets[${i}]`);
      if (akErr) { errors.push(akErr); continue; }
      if (typeof a.id !== 'string' || !SAFE_ID_RE.test(a.id)) {
        errors.push(`assets[${i}].id không hợp lệ.`);
        continue;
      }
      if (assetMap.has(a.id)) {
        errors.push(`Trùng asset ID: "${a.id}".`);
        continue;
      }
      const src = sourceMap.get(a.sourceId);
      if (!src) {
        errors.push(`assets[${i}] tham chiếu sourceId không tồn tại: "${a.sourceId}".`);
        continue;
      }
      if (typeof a.name !== 'string' || a.name.length === 0 || a.name.length > 255) {
        errors.push(`assets[${i}].name không hợp lệ.`);
      }
      if (!isPlainObject(a.region)) {
        errors.push(`assets[${i}].region không hợp lệ.`);
        continue;
      }
      const rkErr = checkAllowedKeys(a.region, allowedRegion, `assets[${i}].region`);
      if (rkErr) { errors.push(rkErr); continue; }
      const { x, y, w, h } = a.region;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h) ||
          x < 0 || y < 0 || w < 1 || h < 1 || x + w > src.width || y + h > src.height) {
        errors.push(`assets[${i}].region (${x},${y},${w},${h}) vượt biên ảnh nguồn (${src.width}×${src.height}).`);
        continue;
      }
      assetMap.set(a.id, a);
    }
  }

  // Cells
  if (!isPlainObject(raw.cells)) {
    errors.push('cells phải là object.');
  } else {
    const allowedCell = new Set(['assetId', 'fitMode', 'alphaThreshold', 'zoom', 'offsetX', 'offsetY', 'anchor']);
    const allowedAnchor = new Set(['mode', 'x', 'y']);
    for (const key of Object.keys(raw.cells)) {
      const parsed = parseCellKey(key);
      if (!parsed || (gRes.ok && !isCellInGrid(parsed.row, parsed.col, raw.grid))) {
        errors.push(`Ô "${key}" không hợp lệ hoặc nằm ngoài lưới.`);
        continue;
      }
      const cell = raw.cells[key];
      if (!isPlainObject(cell)) { errors.push(`cells["${key}"] không hợp lệ.`); continue; }
      const ckErr = checkAllowedKeys(cell, allowedCell, `cells["${key}"]`);
      if (ckErr) { errors.push(ckErr); continue; }
      const asset = assetMap.get(cell.assetId);
      if (!asset) {
        errors.push(`cells["${key}"] tham chiếu assetId không tồn tại: "${cell.assetId}".`);
        continue;
      }
      if (!ALLOWED_FIT_MODES.has(cell.fitMode)) {
        errors.push(`cells["${key}"].fitMode không hợp lệ.`);
      }
      if (!Number.isInteger(cell.alphaThreshold) || cell.alphaThreshold < LIMITS.MIN_ALPHA_THRESHOLD || cell.alphaThreshold > LIMITS.MAX_ALPHA_THRESHOLD) {
        errors.push(`cells["${key}"].alphaThreshold phải là số nguyên 0–254.`);
      }
      if (typeof cell.zoom !== 'number' || !Number.isFinite(cell.zoom) || cell.zoom < LIMITS.MIN_ZOOM || cell.zoom > LIMITS.MAX_ZOOM) {
        errors.push(`cells["${key}"].zoom phải nằm trong ${LIMITS.MIN_ZOOM}–${LIMITS.MAX_ZOOM}.`);
      }
      if (typeof cell.offsetX !== 'number' || !Number.isFinite(cell.offsetX) ||
          typeof cell.offsetY !== 'number' || !Number.isFinite(cell.offsetY)) {
        errors.push(`cells["${key}"] có offsetX/offsetY không hữu hạn.`);
      }
      if (!isPlainObject(cell.anchor)) {
        errors.push(`cells["${key}"].anchor không hợp lệ.`);
      } else {
        const ankErr = checkAllowedKeys(cell.anchor, allowedAnchor, `cells["${key}"].anchor`);
        if (ankErr) errors.push(ankErr);
        if (!ALLOWED_ANCHOR_MODES.has(cell.anchor.mode)) {
          errors.push(`cells["${key}"].anchor.mode không hợp lệ.`);
        } else if (cell.anchor.mode === 'custom') {
          const ax = cell.anchor.x;
          const ay = cell.anchor.y;
          if (typeof ax !== 'number' || !Number.isFinite(ax) || typeof ay !== 'number' || !Number.isFinite(ay) ||
              ax < 0 || ay < 0 || ax > asset.region.w || ay > asset.region.h) {
            errors.push(`cells["${key}"].anchor tùy chỉnh nằm ngoài vùng nguồn.`);
          }
        }
      }
    }
  }

  // Animations
  if (!Array.isArray(raw.animations)) {
    errors.push('animations phải là mảng.');
  } else if (raw.animations.length > LIMITS.MAX_ANIMATIONS) {
    errors.push(`Số nhóm animation vượt giới hạn ${LIMITS.MAX_ANIMATIONS}.`);
  } else {
    const seenAnimIds = new Set();
    const allowedAnim = new Set(['id', 'name', 'fps', 'loopMode', 'guides', 'sizeVarianceThreshold', 'frames']);
    const allowedFrame = new Set(['row', 'col', 'durationMs']);
    let totalSlots = 0;

    for (let i = 0; i < raw.animations.length; i++) {
      const anim = raw.animations[i];
      if (!isPlainObject(anim)) { errors.push(`animations[${i}] không hợp lệ.`); continue; }
      const akErr = checkAllowedKeys(anim, allowedAnim, `animations[${i}]`);
      if (akErr) { errors.push(akErr); continue; }
      if (typeof anim.id !== 'string' || !SAFE_ID_RE.test(anim.id)) {
        errors.push(`animations[${i}].id không hợp lệ.`);
      } else if (seenAnimIds.has(anim.id)) {
        errors.push(`Trùng animation ID: "${anim.id}".`);
      } else {
        seenAnimIds.add(anim.id);
      }
      if (typeof anim.name !== 'string' || anim.name.trim().length === 0 || anim.name.length > 128) {
        errors.push(`animations[${i}].name không hợp lệ.`);
      }
      if (typeof anim.fps !== 'number' || !Number.isFinite(anim.fps) || anim.fps < LIMITS.MIN_FPS || anim.fps > LIMITS.MAX_FPS) {
        errors.push(`animations[${i}].fps không hợp lệ.`);
      }
      if (!ALLOWED_LOOP_MODES.has(anim.loopMode)) {
        errors.push(`animations[${i}].loopMode không hợp lệ.`);
      }
      if (anim.guides !== undefined) {
        const agErr = validateGuides(anim.guides, `animations[${i}].guides`, true);
        if (agErr) errors.push(agErr);
      }
      if (anim.sizeVarianceThreshold !== undefined && anim.sizeVarianceThreshold !== null) {
        if (typeof anim.sizeVarianceThreshold !== 'number' || !Number.isFinite(anim.sizeVarianceThreshold) || anim.sizeVarianceThreshold < 0 || anim.sizeVarianceThreshold > 5) {
          errors.push(`animations[${i}].sizeVarianceThreshold không hợp lệ.`);
        }
      }
      if (!Array.isArray(anim.frames)) {
        errors.push(`animations[${i}].frames phải là mảng.`);
      } else {
        totalSlots += anim.frames.length;
        if (totalSlots > LIMITS.MAX_ANIMATION_SLOTS) {
          errors.push(`Tổng số slot animation vượt giới hạn ${LIMITS.MAX_ANIMATION_SLOTS}.`);
          break;
        }
        for (let j = 0; j < anim.frames.length; j++) {
          const f = anim.frames[j];
          if (!isPlainObject(f)) { errors.push(`animations[${i}].frames[${j}] không hợp lệ.`); break; }
          const fkErr = checkAllowedKeys(f, allowedFrame, `animations[${i}].frames[${j}]`);
          if (fkErr) { errors.push(fkErr); break; }
          if (gRes.ok && !isCellInGrid(f.row, f.col, raw.grid)) {
            errors.push(`animations[${i}].frames[${j}] (${f.row}:${f.col}) nằm ngoài lưới.`);
            break;
          }
          if (f.durationMs !== null && (typeof f.durationMs !== 'number' || !Number.isFinite(f.durationMs) || f.durationMs < LIMITS.MIN_DURATION_MS || f.durationMs > LIMITS.MAX_DURATION_MS)) {
            errors.push(`animations[${i}].frames[${j}].durationMs không hợp lệ.`);
            break;
          }
        }
      }
    }
  }

  // Settings
  if (!isPlainObject(raw.settings)) {
    errors.push('settings không hợp lệ.');
  } else {
    const skErr = checkAllowedKeys(raw.settings, new Set(['smoothing', 'guides', 'defaultAlphaThreshold', 'webpQuality']), 'settings');
    if (skErr) errors.push(skErr);
    if (typeof raw.settings.smoothing !== 'boolean') errors.push('settings.smoothing phải là boolean.');
    const sgErr = validateGuides(raw.settings.guides, 'settings.guides', false);
    if (sgErr) errors.push(sgErr);
    if (!Number.isInteger(raw.settings.defaultAlphaThreshold) || raw.settings.defaultAlphaThreshold < LIMITS.MIN_ALPHA_THRESHOLD || raw.settings.defaultAlphaThreshold > LIMITS.MAX_ALPHA_THRESHOLD) {
      errors.push('settings.defaultAlphaThreshold không hợp lệ.');
    }
    if (typeof raw.settings.webpQuality !== 'number' || !Number.isFinite(raw.settings.webpQuality) || raw.settings.webpQuality < 0.01 || raw.settings.webpQuality > 1.0) {
      errors.push('settings.webpQuality phải nằm trong 0.01–1.0.');
    }
  }

  // Custom presets
  if (!Array.isArray(raw.customPresets) || raw.customPresets.length > LIMITS.MAX_CUSTOM_PRESETS) {
    errors.push(`customPresets phải là mảng tối đa ${LIMITS.MAX_CUSTOM_PRESETS} mục.`);
  } else {
    const seenPresetIds = new Set();
    for (let i = 0; i < raw.customPresets.length; i++) {
      const pRes = validatePresetV1(raw.customPresets[i]);
      if (!pRes.ok) {
        errors.push(`customPresets[${i}]: ${pRes.errors[0]}`);
      } else if (seenPresetIds.has(raw.customPresets[i].id)) {
        errors.push(`Trùng ID preset tùy chỉnh: "${raw.customPresets[i].id}".`);
      } else {
        seenPresetIds.add(raw.customPresets[i].id);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate Atlas Metadata V1 output structure.
 */
export function validateAtlasMetadataV1(meta) {
  const errors = [];
  if (!isPlainObject(meta)) return { ok: false, errors: ['Metadata phải là object.'] };
  if (meta.format !== ATLAS_FORMAT) errors.push('format không khớp.');
  if (meta.schemaVersion !== ATLAS_SCHEMA_VERSION) errors.push('schemaVersion không khớp.');
  if (meta.image !== null && typeof meta.image !== 'string') errors.push('image phải là string hoặc null.');
  if (!isPlainObject(meta.atlas)) errors.push('atlas thiếu.');
  else {
    if (meta.atlas.origin !== 'top-left') errors.push('origin phải là top-left.');
    if (meta.atlas.indexBase !== 0) errors.push('indexBase phải là 0.');
    if (meta.atlas.width !== meta.atlas.cols * meta.atlas.cellWidth) errors.push('atlas.width không khớp.');
    if (meta.atlas.height !== meta.atlas.rows * meta.atlas.cellHeight) errors.push('atlas.height không khớp.');
  }
  if (!Array.isArray(meta.frames)) errors.push('frames phải là mảng.');
  else if (meta.atlas && meta.frames.length !== meta.atlas.cols * meta.atlas.rows) {
    errors.push('Số phần tử frames phải bằng cols × rows.');
  }
  if (!Array.isArray(meta.animations)) errors.push('animations phải là mảng.');
  return { ok: errors.length === 0, errors };
}
