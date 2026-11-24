/**
 * Sprite Sheet Builder V2.0 — Preflight Inspector (Spec §11.4).
 * Separates blocking errors from confirmable warnings; never mutates project data.
 */

import { LIMITS, cellKey, parseCellKey } from './constants.js';
import { computeCellGeometry, analyzeRectInCell } from './geometry.js';
import { hasCellMask } from './mask.js';
import { validateGrid } from './validator.js';

function computeMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Run preflight validation on a committed project snapshot.
 *
 * @param {object} params
 * @param {object} params.project
 * @param {object} [params.exportConfig]  { type: 'atlas'|'strip'|'frames'|'zip'|'json', format, groupIds, selectedCells, stripDirection, includeEmptyGridFrames }
 * @param {function} params.inspectAssetPixels  (assetId, threshold) => { ok, missingSource, decodeError, allTransparent, alphaBounds, visibleBounds }
 */
export function runPreflight({
  project,
  exportConfig = { type: 'atlas', format: 'image/png' },
  inspectAssetPixels
}) {
  const errors = [];
  const warnings = [];
  const { grid } = project;
  const gridRes = validateGrid(grid);

  if (!gridRes.ok) {
    for (const msg of gridRes.errors) {
      errors.push({ code: 'INVALID_GRID', message: msg, cellKey: null });
    }
  }

  // Check resources limits
  if (project.sources.length > LIMITS.MAX_SOURCES) {
    errors.push({ code: 'LIMIT_SOURCES', message: `Vượt giới hạn ${LIMITS.MAX_SOURCES} nguồn ảnh.`, cellKey: null });
  }
  if (project.assets.length > LIMITS.MAX_ASSETS) {
    errors.push({ code: 'LIMIT_ASSETS', message: `Vượt giới hạn ${LIMITS.MAX_ASSETS} asset.`, cellKey: null });
  }

  // Verify preset expected / unused cells
  const expectedSet = project.expectedCells ? new Set(project.expectedCells) : null;
  if (expectedSet) {
    for (const k of expectedSet) {
      if (!project.cells[k]) {
        const pos = parseCellKey(k);
        warnings.push({
          code: 'PRESET_MISSING_EXPECTED',
          message: `Ô dự kiến của preset tại hàng ${pos.row + 1}, cột ${pos.col + 1} đang trống.`,
          cellKey: k
        });
      }
    }
    for (const k of Object.keys(project.cells)) {
      if (!expectedSet.has(k)) {
        const pos = parseCellKey(k);
        warnings.push({
          code: 'PRESET_UNUSED_OCCUPIED',
          message: `Có ảnh nằm trong ô dư preset tại hàng ${pos.row + 1}, cột ${pos.col + 1}.`,
          cellKey: k
        });
      }
    }
  }

  // Inspect every filled cell
  const cellGeometries = new Map();
  const cellPixelInfos = new Map();
  const filledKeys = Object.keys(project.cells);

  for (const key of filledKeys) {
    const pos = parseCellKey(key);
    const cell = project.cells[key];
    const label = pos ? `hàng ${pos.row + 1}, cột ${pos.col + 1}` : key;
    const asset = project.assets.find((a) => a.id === cell.assetId);

    if (!asset) {
      errors.push({ code: 'BROKEN_ASSET_REF', message: `Ô (${label}) trỏ tới asset không tồn tại.`, cellKey: key });
      continue;
    }
    const source = project.sources.find((s) => s.id === asset.sourceId);
    if (!source) {
      errors.push({ code: 'BROKEN_SOURCE_REF', message: `Ô (${label}) trỏ tới nguồn ảnh không tồn tại.`, cellKey: key });
      continue;
    }

    if (
      !Number.isFinite(cell.zoom) ||
      cell.zoom < LIMITS.MIN_ZOOM ||
      cell.zoom > LIMITS.MAX_ZOOM ||
      !Number.isFinite(cell.offsetX) ||
      !Number.isFinite(cell.offsetY)
    ) {
      errors.push({ code: 'INVALID_TRANSFORM', message: `Ô (${label}) có transform NaN/vô hạn hoặc zoom ngoài ${Math.round(LIMITS.MIN_ZOOM * 100)}–${Math.round(LIMITS.MAX_ZOOM * 100)}%.`, cellKey: key });
      continue;
    }

    const pixInfo = inspectAssetPixels ? inspectAssetPixels(asset.id, cell.alphaThreshold, cell, key) : { ok: true };
    cellPixelInfos.set(key, pixInfo);

    if (pixInfo.missingSource) {
      errors.push({ code: 'MISSING_SOURCE_BINARY', message: `Thiếu dữ liệu nhị phân nguồn ảnh tại ô (${label}).`, cellKey: key });
      continue;
    }
    if (pixInfo.decodeError) {
      errors.push({ code: 'DECODE_ERROR', message: `Không giải mã được ảnh tại ô (${label}): ${pixInfo.decodeError}`, cellKey: key });
      continue;
    }

    const cellHasMask = hasCellMask(cell);
    if (pixInfo.allTransparent) {
      warnings.push({
        code: cellHasMask ? 'MASK_ALL_TRANSPARENT' : 'ALL_TRANSPARENT',
        message: cellHasMask
          ? `Ô (${label}) đã bị tẩy hết phần nhìn thấy — sẽ xuất ô trong suốt (vẫn có thể Khôi phục hoặc Bỏ toàn bộ vết tẩy).`
          : `Nguồn ảnh tại ô (${label}) hoàn toàn trong suốt (alpha = 0).`,
        cellKey: key
      });
      if (cellHasMask) {
        // Erased-empty cell must NOT block atlas export even when fitMode === 'alpha'
        continue;
      }
    }

    if (cell.fitMode === 'alpha' && !pixInfo.alphaBounds) {
      if (cellHasMask) {
        warnings.push({
          code: 'MASK_NO_ALPHA_BOUNDS',
          message: `Ô (${label}) dùng Fit Alpha nhưng sau khi tẩy không còn pixel vượt ngưỡng alpha ${cell.alphaThreshold} — sẽ xuất ô trong suốt.`,
          cellKey: key
        });
        continue;
      }
      errors.push({
        code: 'INVALID_FIT_ALPHA',
        message: `Ô (${label}) dùng Fit Alpha nhưng không có pixel vượt ngưỡng alpha ${cell.alphaThreshold}.`,
        cellKey: key
      });
      continue;
    }

    const geom = computeCellGeometry({
      cellWidth: grid.cellWidth,
      cellHeight: grid.cellHeight,
      row: pos?.row ?? 0,
      col: pos?.col ?? 0,
      region: asset.region,
      transform: cell,
      alphaBounds: pixInfo.alphaBounds || null
    });

    if (!geom) {
      errors.push({ code: 'GEOMETRY_ERROR', message: `Không tính được hình học cho ô (${label}).`, cellKey: key });
      continue;
    }
    cellGeometries.set(key, geom);

    // Clipping / outside-frame warnings (distinguish exact alpha>0 vs heuristic threshold, Spec §11.4)
    const exactVisible = pixInfo.visibleBounds;
    if (exactVisible) {
      const exactRect = {
        x: geom.localX + exactVisible.x * geom.scale,
        y: geom.localY + exactVisible.y * geom.scale,
        w: exactVisible.w * geom.scale,
        h: exactVisible.h * geom.scale
      };
      const exactAnalysis = analyzeRectInCell(exactRect, grid.cellWidth, grid.cellHeight);
      if (exactAnalysis.completelyOutside) {
        warnings.push({
          code: 'OUTSIDE_CELL',
          message: `Ảnh tại ô (${label}) nằm hoàn toàn ngoài khung ô (kiểm tra theo alpha thực tế > 0).`,
          cellKey: key
        });
      } else if (exactAnalysis.clipped) {
        const heurRect = geom.renderedAlphaRect;
        const heurClipped = heurRect
          ? analyzeRectInCell(heurRect, grid.cellWidth, grid.cellHeight).clipped
          : false;
        warnings.push({
          code: 'ALPHA_CLIPPED',
          message: heurClipped
            ? `Vùng nội dung tại ô (${label}) vượt biên ô (alpha thực tế > 0 và ngưỡng ${cell.alphaThreshold}).`
            : `Pixel alpha mờ tại ô (${label}) vượt biên ô (alpha thực tế > 0; vùng ngưỡng ${cell.alphaThreshold} vẫn nằm trong ô).`,
          cellKey: key
        });
      }
    }
  }

  // Animation group checks (empty slots + size variance warning)
  for (const anim of project.animations) {
    if (anim.frames.length === 0) {
      warnings.push({
        code: 'EMPTY_ANIMATION_GROUP',
        message: `Nhóm animation "${anim.name}" chưa có frame nào.`,
        cellKey: null,
        animationId: anim.id
      });
      continue;
    }

    const heights = [];
    for (let i = 0; i < anim.frames.length; i++) {
      const f = anim.frames[i];
      const k = cellKey(f.row, f.col);
      if (!project.cells[k]) {
        warnings.push({
          code: 'ANIMATION_EMPTY_SLOT',
          message: `Nhóm "${anim.name}" có ô trống ở slot #${i + 1} (hàng ${f.row + 1}, cột ${f.col + 1}).`,
          cellKey: k,
          animationId: anim.id
        });
      } else {
        const g = cellGeometries.get(k);
        if (g?.renderedAlphaRect && g.renderedAlphaRect.h > 0) {
          heights.push({ key: k, pos: f, h: g.renderedAlphaRect.h, slotIndex: i });
        }
      }
    }

    // Size variance check (default 20% from median rendered alpha height; null=default 0.2, 0=disabled)
    const threshold =
      anim.sizeVarianceThreshold === 0
        ? 0
        : (anim.sizeVarianceThreshold ?? LIMITS.DEFAULT_SIZE_VARIANCE_THRESHOLD);

    if (threshold > 0 && heights.length >= 2) {
      const medianH = computeMedian(heights.map((x) => x.h));
      if (medianH > 0) {
        for (const item of heights) {
          const diffRatio = Math.abs(item.h - medianH) / medianH;
          if (diffRatio > threshold) {
            warnings.push({
              code: 'SIZE_VARIANCE',
              message: `Nhóm "${anim.name}" — ô (${item.pos.row + 1},${item.pos.col + 1}) có chiều cao nội dung (${item.h.toFixed(1)} px) chênh ${(diffRatio * 100).toFixed(0)}% so với trung vị nhóm (${medianH.toFixed(1)} px, ngưỡng ${(threshold * 100).toFixed(0)}%).`,
              cellKey: item.key,
              animationId: anim.id
            });
          }
        }
      }
    }
  }

  // Export-scope specific blocking checks (Spec §11.1, §11.4)
  const expType = exportConfig?.type || 'atlas';
  if (expType === 'atlas') {
    if (filledKeys.length === 0) {
      errors.push({
        code: 'NO_IMAGES_IN_SCOPE',
        message: 'Atlas chưa có ảnh nào để xuất ảnh. (Chỉ có thể xuất JSON metadata độc lập cho lưới trống.)',
        cellKey: null
      });
    }
  } else if (expType === 'strip') {
    const groupIds = exportConfig.groupIds || [];
    const direction = exportConfig.stripDirection || 'horizontal';
    const selectedAnims = project.animations.filter((a) => groupIds.includes(a.id));
    if (selectedAnims.length === 0) {
      errors.push({ code: 'NO_GROUP_SELECTED', message: 'Chưa chọn nhóm animation nào để xuất strip.', cellKey: null });
    }
    for (const anim of selectedAnims) {
      const hasAnyImage = anim.frames.some((f) => Boolean(project.cells[cellKey(f.row, f.col)]));
      if (!hasAnyImage) {
        errors.push({
          code: 'NO_IMAGES_IN_GROUP',
          message: `Nhóm "${anim.name}" không có frame ảnh nào để xuất strip.`,
          cellKey: null,
          animationId: anim.id
        });
      }
      const stripW = direction === 'horizontal' ? anim.frames.length * grid.cellWidth : grid.cellWidth;
      const stripH = direction === 'vertical' ? anim.frames.length * grid.cellHeight : grid.cellHeight;
      const stripPx = stripW * stripH;
      if (stripW > LIMITS.MAX_ATLAS_DIM || stripH > LIMITS.MAX_ATLAS_DIM || stripPx > LIMITS.MAX_ATLAS_PIXELS) {
        errors.push({
          code: 'STRIP_TOO_LARGE',
          message: `Strip nhóm "${anim.name}" (${stripW}×${stripH} px) vượt giới hạn canvas (${LIMITS.MAX_ATLAS_DIM} px / 32 Mi pixel). Hãy chọn xuất frame riêng.`,
          cellKey: null,
          animationId: anim.id
        });
      }
    }
  } else if (expType === 'frames') {
    const scope = exportConfig.framesScope || 'all-filled';
    if (scope === 'selected-cells') {
      const keys = (exportConfig.selectedCells || []).filter((k) => exportConfig.includeEmptyGridFrames || Boolean(project.cells[k]));
      if (keys.length === 0) {
        errors.push({ code: 'NO_IMAGES_IN_SCOPE', message: 'Không có ô hợp lệ nào trong vùng chọn để xuất frame.', cellKey: null });
      }
    } else if (scope === 'groups') {
      const selectedAnims = project.animations.filter((a) => (exportConfig.groupIds || []).includes(a.id));
      const anyValid = selectedAnims.some((a) => a.frames.some((f) => Boolean(project.cells[cellKey(f.row, f.col)])));
      if (!anyValid) {
        errors.push({ code: 'NO_IMAGES_IN_SCOPE', message: 'Các nhóm đã chọn không có frame ảnh nào để xuất.', cellKey: null });
      }
    } else if (filledKeys.length === 0 && !exportConfig.includeEmptyGridFrames) {
      errors.push({ code: 'NO_IMAGES_IN_SCOPE', message: 'Không có ô chứa ảnh nào để xuất frame riêng.', cellKey: null });
    }
  } else if (expType === 'zip') {
    const includeAtlas = exportConfig.includeAtlas !== false;
    const includeJson = Boolean(exportConfig.includeJson);
    const includeStrips = Boolean(exportConfig.includeStrips);
    const includeFrames = Boolean(exportConfig.includeFrames);
    if (!includeAtlas && !includeJson && !includeStrips && !includeFrames) {
      errors.push({ code: 'EMPTY_ZIP_PLAN', message: 'Chưa chọn thành phần nào để đóng gói ZIP.', cellKey: null });
    }
    if ((includeAtlas || includeFrames) && filledKeys.length === 0 && !includeJson) {
      errors.push({ code: 'NO_IMAGES_IN_SCOPE', message: 'Không có ảnh nào trong phạm vi xuất gói ZIP.', cellKey: null });
    }
    if (includeStrips) {
      const direction = exportConfig.stripDirection || 'horizontal';
      const selectedAnims = project.animations.filter((a) => (exportConfig.groupIds || []).includes(a.id));
      for (const anim of selectedAnims) {
        const stripW = direction === 'horizontal' ? anim.frames.length * grid.cellWidth : grid.cellWidth;
        const stripH = direction === 'vertical' ? anim.frames.length * grid.cellHeight : grid.cellHeight;
        if (stripW > LIMITS.MAX_ATLAS_DIM || stripH > LIMITS.MAX_ATLAS_DIM || stripW * stripH > LIMITS.MAX_ATLAS_PIXELS) {
          errors.push({
            code: 'STRIP_TOO_LARGE',
            message: `Strip nhóm "${anim.name}" (${stripW}×${stripH} px) vượt giới hạn canvas. Hãy bỏ chọn strip này và xuất frame riêng.`,
            cellKey: null,
            animationId: anim.id
          });
        }
      }
    }
  }
  // Note: expType === 'json' allows valid empty grid (Spec §11.4)!

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    needsLargeExportConfirm: gridRes.needsLargeExportConfirm && (expType === 'atlas' || (expType === 'zip' && exportConfig.includeAtlas !== false))
  };
}
