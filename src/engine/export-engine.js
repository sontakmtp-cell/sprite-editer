/**
 * Sprite Sheet Builder V2.0 — Export Engine (Spec §11).
 * Supports Atlas PNG/WebP, Animation Strips, Individual Frames, JSON Metadata V1, and ZIP bundles.
 * Uses exact committed snapshot, sequential rendering & canvas cleanup, strict encoder verification,
 * and safe cancellation between steps.
 */

import {
  ATLAS_FORMAT,
  ATLAS_SCHEMA_VERSION,
  ATLAS_SCHEMA_VERSION_V2,
  LIMITS,
  cellKey,
  parseCellKey,
  sanitizeFilename,
  allocateUniqueFilename,
  pad3,
  mimeToExt
} from '../core/constants.js';
import { computeCellGeometry, computeAlphaBoundsFromRGBA } from '../core/geometry.js';
import { hasCellMask } from '../core/mask.js';
import { verifyEncodedSignature } from '../core/image-inspect.js';
import { getFrameDurationMs } from '../core/animation-clock.js';
import { drawCellOnContext } from './renderer.js';
import { createZip } from '../io/zip.js';

const textEncoder = new TextEncoder();

/**
 * Allocate an offscreen HTMLCanvasElement safely and verify allocation succeeded (Spec §12.2, T23).
 */
export function createOutputCanvas(width, height) {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 ||
    width > LIMITS.MAX_ATLAS_DIM || height > LIMITS.MAX_ATLAS_DIM ||
    width * height > LIMITS.MAX_ATLAS_PIXELS
  ) {
    throw new Error(`Kích thước canvas xuất (${width}×${height} px) vượt giới hạn cho phép.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error(`Trình duyệt không thể cấp phát canvas kích thước ${width}×${height} px.`);
  }
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error('Không thể khởi tạo Canvas 2D context.');
  }
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx };
}

export function disposeCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Encode a canvas to PNG or WebP Blob and verify non-null, MIME, and binary signature (Spec §11.2, T05/T08).
 */
export async function encodeCanvasStrict(canvas, mime = 'image/png', quality = 0.92, customEncoder = null) {
  let blob;
  try {
    if (customEncoder) {
      blob = await customEncoder(canvas, mime, quality);
    } else {
      blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(
            (b) => resolve(b),
            mime,
            mime === 'image/webp' ? quality : undefined
          );
        } catch (err) {
          reject(err);
        }
      });
    }
  } catch (err) {
    throw new Error(`Bộ mã hóa ảnh gặp lỗi: ${err.message || err}`);
  }

  if (!blob || blob.size === 0) {
    throw new Error(`Bộ mã hóa trả về dữ liệu rỗng cho định dạng ${mime}.`);
  }

  if (blob.type && blob.type !== mime) {
    if (mime === 'image/webp' && blob.type === 'image/png') {
      throw new Error('Trình duyệt không hỗ trợ mã hóa WebP và đã fallback sang PNG. Vui lòng chọn định dạng PNG.');
    }
    throw new Error(`MIME đầu ra (${blob.type}) không khớp định dạng yêu cầu (${mime}).`);
  }

  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sig = verifyEncodedSignature(bytes, mime);
  if (!sig.ok) {
    throw new Error(sig.error);
  }

  return { blob, bytes };
}

/**
 * Resolve cell drawable + alphaBounds asynchronously for rendering (mask-aware).
 */
async function resolveCellForRender(project, assetManager, cell) {
  const asset = project.assets.find((a) => a.id === cell.assetId);
  if (!asset) throw new Error(`Thiếu asset ${cell.assetId}`);
  const source = project.sources.find((s) => s.id === asset.sourceId);
  if (!source) throw new Error(`Thiếu nguồn ${asset.sourceId}`);

  const cellHasMask = hasCellMask(cell);
  let alphaBounds = null;
  if (cell.fitMode === 'alpha' || cell.anchor?.mode === 'alpha-bottom-center' || cellHasMask) {
    const info = await assetManager.analyzeCellPixels(asset, source, cell.alphaThreshold, cell.mask);
    if (!info.ok) throw new Error(info.decodeError || 'Không phân tích được alpha của ảnh nguồn.');
    alphaBounds = info.alphaBounds;
    if (cellHasMask && (info.allTransparent || (cell.fitMode === 'alpha' && !alphaBounds))) {
      // Erased-empty cell exports cleanly as transparent without blocking the atlas
      return { asset, source, alphaBounds: null, drawable: null, skipTransparent: true };
    }
    if (cell.fitMode === 'alpha' && !alphaBounds) {
      throw new Error(`Không có alpha bounds hợp lệ cho Fit Alpha ở asset "${asset.name}".`);
    }
  }

  const drawable = await assetManager.getCellDrawable(asset, source, cell.mask);
  if (!drawable) throw new Error(`Không giải mã được nguồn "${source.name}".`);

  return { asset, source, alphaBounds, drawable, skipTransparent: false };
}

/**
 * Render full Sprite Atlas onto a new output canvas (exact cols*cellWidth x rows*cellHeight, no DPR).
 */
export async function renderAtlasToCanvas(project, assetManager, { signal = null, onProgress = null } = {}) {
  const { cols, rows, cellWidth, cellHeight } = project.grid;
  const width = cols * cellWidth;
  const height = rows * cellHeight;
  const { canvas, ctx } = createOutputCanvas(width, height);

  try {
    const filledKeys = Object.keys(project.cells);
    const total = Math.max(1, filledKeys.length);

    for (let i = 0; i < filledKeys.length; i++) {
      if (signal?.aborted) throw new Error('CANCELLED');
      const key = filledKeys[i];
      const pos = parseCellKey(key);
      if (!pos) continue;
      const cell = project.cells[key];
      const resolved = await resolveCellForRender(project, assetManager, cell);
      if (!resolved.skipTransparent) {
        drawCellOnContext(ctx, {
          cellWidth,
          cellHeight,
          originX: pos.col * cellWidth,
          originY: pos.row * cellHeight,
          region: resolved.asset.region,
          transform: cell,
          alphaBounds: resolved.alphaBounds,
          drawable: resolved.drawable,
          smoothing: project.settings.smoothing
        });
      }

      if (onProgress) onProgress(i + 1, total, `Đang render ô ${i + 1}/${filledKeys.length}...`);
    }
    return canvas;
  } catch (err) {
    disposeCanvas(canvas);
    throw err;
  }
}

/**
 * Render one animation group into a horizontal or vertical strip canvas (Spec §11.1).
 * Preserves empty slots as transparent cells.
 */
export async function renderStripToCanvas(project, assetManager, animation, direction = 'horizontal', { signal = null } = {}) {
  const { cellWidth, cellHeight } = project.grid;
  const count = animation.frames.length;
  if (count === 0) throw new Error(`Nhóm "${animation.name}" không có frame nào.`);

  const width = direction === 'horizontal' ? count * cellWidth : cellWidth;
  const height = direction === 'vertical' ? count * cellHeight : cellHeight;

  if (width > LIMITS.MAX_ATLAS_DIM || height > LIMITS.MAX_ATLAS_DIM || width * height > LIMITS.MAX_ATLAS_PIXELS) {
    throw new Error(`Strip nhóm "${animation.name}" (${width}×${height} px) vượt giới hạn canvas. Hãy chọn xuất frame riêng.`);
  }

  const { canvas, ctx } = createOutputCanvas(width, height);
  try {
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw new Error('CANCELLED');
      const f = animation.frames[i];
      const key = cellKey(f.row, f.col);
      const cell = project.cells[key];
      if (!cell) continue; // Keep empty slot transparent

      const resolved = await resolveCellForRender(project, assetManager, cell);
      if (!resolved.skipTransparent) {
        const ox = direction === 'horizontal' ? i * cellWidth : 0;
        const oy = direction === 'vertical' ? i * cellHeight : 0;

        drawCellOnContext(ctx, {
          cellWidth,
          cellHeight,
          originX: ox,
          originY: oy,
          region: resolved.asset.region,
          transform: cell,
          alphaBounds: resolved.alphaBounds,
          drawable: resolved.drawable,
          smoothing: project.settings.smoothing
        });
      }
    }
    return canvas;
  } catch (err) {
    disposeCanvas(canvas);
    throw err;
  }
}

/**
 * Render a single cell onto a cellWidth x cellHeight canvas.
 */
export async function renderSingleCellToCanvas(project, assetManager, row, col) {
  const { cellWidth, cellHeight } = project.grid;
  const { canvas, ctx } = createOutputCanvas(cellWidth, cellHeight);
  try {
    const cell = project.cells[cellKey(row, col)];
    if (cell) {
      const resolved = await resolveCellForRender(project, assetManager, cell);
      if (!resolved.skipTransparent) {
        drawCellOnContext(ctx, {
          cellWidth,
          cellHeight,
          originX: 0,
          originY: 0,
          region: resolved.asset.region,
          transform: cell,
          alphaBounds: resolved.alphaBounds,
          drawable: resolved.drawable,
          smoothing: project.settings.smoothing
        });
      }
    }
    return canvas;
  } catch (err) {
    disposeCanvas(canvas);
    throw err;
  }
}

/**
 * Shared internal Atlas Metadata builder for Schema V1 (strictly compatible with original
 * schemas/atlas-v1.schema.json) and Schema V2 (adds clip-accurate `contentBoundsCellPx`
 * measured directly from the rendered & cell-clipped exported RGBA pixels).
 */
async function _buildAtlasMetadata(
  project,
  assetManager,
  {
    imageFilename = null,
    includeGuidesAndAnchors = true,
    schemaVersion = ATLAS_SCHEMA_VERSION,
    includeContentBounds = false
  } = {}
) {
  const { cols, rows, cellWidth, cellHeight } = project.grid;
  const emitBounds = schemaVersion === ATLAS_SCHEMA_VERSION_V2 && includeContentBounds;
  const frames = [];

  let scratch = null;
  if (emitBounds) {
    scratch = createOutputCanvas(cellWidth, cellHeight);
  }

  try {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = cellKey(r, c);
        const cell = project.cells[key];
        const frameObj = {
          id: `r${r}c${c}`,
          row: r,
          col: c,
          x: c * cellWidth,
          y: r * cellHeight,
          w: cellWidth,
          h: cellHeight,
          empty: !cell
        };

        if ((includeGuidesAndAnchors || emitBounds) && cell) {
          const asset = project.assets.find((a) => a.id === cell.assetId);
          const source = asset ? project.sources.find((s) => s.id === asset.sourceId) : null;
          if (asset && source) {
            const info = await assetManager.analyzeCellPixels(asset, source, cell.alphaThreshold, cell.mask);
            const alphaBounds = info?.alphaBounds || null;
            const erasedEmpty = hasCellMask(cell) && (info?.allTransparent || (cell.fitMode === 'alpha' && !alphaBounds));

            if (includeGuidesAndAnchors) {
              if (erasedEmpty) {
                frameObj.anchorCellPx = null;
              } else {
                const geom = computeCellGeometry({
                  cellWidth,
                  cellHeight,
                  row: r,
                  col: c,
                  region: asset.region,
                  transform: cell,
                  alphaBounds
                });
                frameObj.anchorCellPx =
                  geom && Number.isFinite(geom.anchorOutX) && Number.isFinite(geom.anchorOutY)
                    ? { x: geom.anchorOutX, y: geom.anchorOutY }
                    : null;
              }
            }

            if (emitBounds) {
              if (erasedEmpty) {
                frameObj.contentBoundsCellPx = null;
              } else {
                const drawable = await assetManager.getCellDrawable(asset, source, cell.mask);
                if (drawable && scratch) {
                  scratch.ctx.clearRect(0, 0, cellWidth, cellHeight);
                  drawCellOnContext(scratch.ctx, {
                    cellWidth,
                    cellHeight,
                    originX: 0,
                    originY: 0,
                    region: asset.region,
                    transform: cell,
                    alphaBounds,
                    drawable,
                    smoothing: project.settings.smoothing
                  });
                  const imgData = scratch.ctx.getImageData(0, 0, cellWidth, cellHeight);
                  // Measure exact alpha > 0 bounds from the actually exported, clipped cell bitmap
                  const clippedBounds = computeAlphaBoundsFromRGBA(imgData.data, cellWidth, cellHeight, 0);
                  frameObj.contentBoundsCellPx = clippedBounds
                    ? { x: clippedBounds.x, y: clippedBounds.y, w: clippedBounds.w, h: clippedBounds.h }
                    : null;
                } else {
                  frameObj.contentBoundsCellPx = null;
                }
              }
            }
          }
        } else if (emitBounds) {
          frameObj.contentBoundsCellPx = null;
        }

        frames.push(frameObj);
      }
    }
  } finally {
    if (scratch) disposeCanvas(scratch.canvas);
  }

  const animations = project.animations.map((anim) => {
    const out = {
      name: anim.name,
      fps: anim.fps,
      loopMode: anim.loopMode,
      frames: anim.frames.map((f) => ({
        frameId: `r${f.row}c${f.col}`,
        durationMs: getFrameDurationMs(f, anim.fps, true)
      }))
    };
    if (includeGuidesAndAnchors) {
      out.guidesNormalized = anim.guides ? { x: anim.guides.x, y: anim.guides.y } : null;
    }
    return out;
  });

  const atlasObj = {
    width: cols * cellWidth,
    height: rows * cellHeight,
    cols,
    rows,
    cellWidth,
    cellHeight,
    origin: 'top-left',
    indexBase: 0
  };
  if (includeGuidesAndAnchors) {
    atlasObj.guidesNormalized = { x: project.settings.guides.x, y: project.settings.guides.y };
  }

  return {
    format: ATLAS_FORMAT,
    schemaVersion,
    image: imageFilename,
    atlas: atlasObj,
    frames,
    animations
  };
}

/**
 * Build Generic Atlas JSON Metadata V1 (Spec §11.3, strictly conforms to schemas/atlas-v1.schema.json).
 */
export async function buildAtlasMetadataV1(project, assetManager, { imageFilename = null, includeGuidesAndAnchors = true } = {}) {
  return _buildAtlasMetadata(project, assetManager, {
    imageFilename,
    includeGuidesAndAnchors,
    schemaVersion: ATLAS_SCHEMA_VERSION,
    includeContentBounds: false
  });
}

/**
 * Build Atlas JSON Metadata V2 (conforms to schemas/atlas-v2.schema.json, includes clip-accurate
 * `contentBoundsCellPx` measured directly from exported cell pixels).
 */
export async function buildAtlasMetadataV2(project, assetManager, { imageFilename = null, includeGuidesAndAnchors = true } = {}) {
  return _buildAtlasMetadata(project, assetManager, {
    imageFilename,
    includeGuidesAndAnchors,
    schemaVersion: ATLAS_SCHEMA_VERSION_V2,
    includeContentBounds: true
  });
}

/**
 * Default atlas filename per Spec §11.2: spritesheet_<cols>x<rows>_<cellWidth>x<cellHeight>.<ext>
 */
export function getDefaultAtlasFilename(grid, mime = 'image/png') {
  const ext = mimeToExt(mime);
  return `spritesheet_${grid.cols}x${grid.rows}_${grid.cellWidth}x${grid.cellHeight}.${ext}`;
}

/**
 * Execute any export job sequentially, returning { filename, bytes, mime } for download.
 * Never allocates all canvases concurrently; honors AbortSignal cleanly between steps.
 */
export async function executeExportJob(project, assetManager, config, { signal = null, onProgress = null, customEncoder = null } = {}) {
  const mime = config.format === 'image/webp' ? 'image/webp' : 'image/png';
  const ext = mimeToExt(mime);
  const quality = config.webpQuality ?? project.settings.webpQuality ?? 0.92;
  const type = config.type || 'atlas';

  const useAtlasMetaV2 = config.metadataSchemaVersion === ATLAS_SCHEMA_VERSION_V2 || Boolean(config.includeContentBounds);

  if (type === 'json') {
    if (onProgress) onProgress(1, 1, 'Đang tạo JSON metadata...');
    const metaBuilder = useAtlasMetaV2 ? buildAtlasMetadataV2 : buildAtlasMetadataV1;
    const meta = await metaBuilder(project, assetManager, {
      imageFilename: null,
      includeGuidesAndAnchors: config.includeGuidesAndAnchors !== false
    });
    const bytes = textEncoder.encode(JSON.stringify(meta, null, 2));
    const baseName = `spritesheet_${project.grid.cols}x${project.grid.rows}_${project.grid.cellWidth}x${project.grid.cellHeight}`;
    return { filename: `${baseName}.json`, bytes, mime: 'application/json' };
  }

  if (type === 'atlas') {
    const canvas = await renderAtlasToCanvas(project, assetManager, { signal, onProgress });
    try {
      if (signal?.aborted) throw new Error('CANCELLED');
      if (onProgress) onProgress(1, 1, `Đang mã hóa ${ext.toUpperCase()}...`);
      const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
      if (signal?.aborted) throw new Error('CANCELLED');
      return {
        filename: getDefaultAtlasFilename(project.grid, mime),
        bytes,
        mime
      };
    } finally {
      disposeCanvas(canvas);
    }
  }

  if (type === 'strip') {
    const direction = config.stripDirection || 'horizontal';
    const dirLabel = direction === 'vertical' ? 'vertical' : 'horizontal';
    const anims = project.animations.filter((a) => (config.groupIds || []).includes(a.id));
    if (anims.length === 1) {
      const anim = anims[0];
      const canvas = await renderStripToCanvas(project, assetManager, anim, direction, { signal });
      try {
        if (signal?.aborted) throw new Error('CANCELLED');
        if (onProgress) onProgress(1, 1, `Đang mã hóa strip "${anim.name}"...`);
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        if (signal?.aborted) throw new Error('CANCELLED');
        const safeName = sanitizeFilename(anim.name, 'group');
        return {
          filename: `${safeName}_strip_${dirLabel}.${ext}`,
          bytes,
          mime
        };
      } finally {
        disposeCanvas(canvas);
      }
    }
    // Multiple strips -> package cleanly into ZIP so user gets all strips safely
    const entries = [];
    const usedNames = new Set();
    for (let i = 0; i < anims.length; i++) {
      if (signal?.aborted) throw new Error('CANCELLED');
      const anim = anims[i];
      if (onProgress) onProgress(i + 1, anims.length, `Đang xuất strip ${i + 1}/${anims.length}: ${anim.name}...`);
      const canvas = await renderStripToCanvas(project, assetManager, anim, direction, { signal });
      try {
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        const safeName = sanitizeFilename(anim.name, 'group');
        const fileName = allocateUniqueFilename(`${safeName}_strip_${dirLabel}`, ext, usedNames);
        entries.push({ name: fileName, data: bytes, compress: false });
      } finally {
        disposeCanvas(canvas);
      }
    }
    if (signal?.aborted) throw new Error('CANCELLED');
    const zipBytes = await createZip(entries, { maxTotalBytes: LIMITS.MAX_ARCHIVE_BYTES });
    const projSafe = sanitizeFilename(project.name, 'spritesheet');
    return { filename: `${projSafe}_strips.zip`, bytes: zipBytes, mime: 'application/zip' };
  }

  if (type === 'frames') {
    const entries = [];
    const usedNames = new Set();
    const frameTasks = buildFrameExportTasks(project, config);

    if (frameTasks.length === 1 && !config.forceZip) {
      const t = frameTasks[0];
      const canvas = await renderSingleCellToCanvas(project, assetManager, t.row, t.col);
      try {
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        const fname = allocateUniqueFilename(t.baseName, ext, usedNames);
        return { filename: fname, bytes, mime };
      } finally {
        disposeCanvas(canvas);
      }
    }

    for (let i = 0; i < frameTasks.length; i++) {
      if (signal?.aborted) throw new Error('CANCELLED');
      const t = frameTasks[i];
      if (onProgress) onProgress(i + 1, frameTasks.length, `Đang xuất frame ${i + 1}/${frameTasks.length}...`);
      const canvas = await renderSingleCellToCanvas(project, assetManager, t.row, t.col);
      try {
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        const fname = allocateUniqueFilename(t.baseName, ext, usedNames);
        entries.push({ name: fname, data: bytes, compress: false });
      } finally {
        disposeCanvas(canvas);
      }
    }
    if (signal?.aborted) throw new Error('CANCELLED');
    const zipBytes = await createZip(entries, { maxTotalBytes: LIMITS.MAX_ARCHIVE_BYTES });
    const projSafe = sanitizeFilename(project.name, 'spritesheet');
    return { filename: `${projSafe}_frames.zip`, bytes: zipBytes, mime: 'application/zip' };
  }

  if (type === 'zip') {
    const entries = [];
    const usedNames = new Set();
    const includeAtlas = config.includeAtlas !== false;
    const includeJson = config.includeJson !== false;
    const includeStrips = Boolean(config.includeStrips);
    const includeFrames = Boolean(config.includeFrames);

    const stripAnims = includeStrips
      ? project.animations.filter((a) => (config.groupIds || []).includes(a.id))
      : [];
    const frameTasks = includeFrames ? buildFrameExportTasks(project, config) : [];

    const totalSteps =
      (includeAtlas ? 1 : 0) +
      (includeJson ? 1 : 0) +
      stripAnims.length +
      frameTasks.length;
    let doneSteps = 0;

    let atlasFilename = null;
    if (includeAtlas) {
      if (signal?.aborted) throw new Error('CANCELLED');
      if (onProgress) onProgress(++doneSteps, totalSteps, 'Đang render và mã hóa Atlas...');
      const canvas = await renderAtlasToCanvas(project, assetManager, { signal });
      try {
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        const base = `spritesheet_${project.grid.cols}x${project.grid.rows}_${project.grid.cellWidth}x${project.grid.cellHeight}`;
        atlasFilename = allocateUniqueFilename(base, ext, usedNames);
        entries.push({ name: atlasFilename, data: bytes, compress: false });
      } finally {
        disposeCanvas(canvas);
      }
    }

    if (includeJson) {
      if (signal?.aborted) throw new Error('CANCELLED');
      if (onProgress) onProgress(++doneSteps, totalSteps, 'Đang tạo JSON metadata...');
      const metaBuilder = useAtlasMetaV2 ? buildAtlasMetadataV2 : buildAtlasMetadataV1;
      const meta = await metaBuilder(project, assetManager, {
        imageFilename: atlasFilename,
        includeGuidesAndAnchors: config.includeGuidesAndAnchors !== false
      });
      const jsonBase = atlasFilename
        ? atlasFilename.replace(/\.[^.]+$/, '')
        : `spritesheet_${project.grid.cols}x${project.grid.rows}_${project.grid.cellWidth}x${project.grid.cellHeight}`;
      const jsonFilename = allocateUniqueFilename(jsonBase, 'json', usedNames);
      entries.push({
        name: jsonFilename,
        data: textEncoder.encode(JSON.stringify(meta, null, 2)),
        compress: true
      });
    }

    const direction = config.stripDirection || 'horizontal';
    const dirLabel = direction === 'vertical' ? 'vertical' : 'horizontal';
    for (const anim of stripAnims) {
      if (signal?.aborted) throw new Error('CANCELLED');
      if (onProgress) onProgress(++doneSteps, totalSteps, `Đang xuất strip "${anim.name}"...`);
      const canvas = await renderStripToCanvas(project, assetManager, anim, direction, { signal });
      try {
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        const safeName = sanitizeFilename(anim.name, 'group');
        const stripName = allocateUniqueFilename(`strips/${safeName}_strip_${dirLabel}`, ext, usedNames);
        entries.push({ name: stripName, data: bytes, compress: false });
      } finally {
        disposeCanvas(canvas);
      }
    }

    for (const t of frameTasks) {
      if (signal?.aborted) throw new Error('CANCELLED');
      if (onProgress) onProgress(++doneSteps, totalSteps, `Đang xuất frame ${doneSteps}/${totalSteps}...`);
      const canvas = await renderSingleCellToCanvas(project, assetManager, t.row, t.col);
      try {
        const { bytes } = await encodeCanvasStrict(canvas, mime, quality, customEncoder);
        const fname = allocateUniqueFilename(`frames/${t.baseName}`, ext, usedNames);
        entries.push({ name: fname, data: bytes, compress: false });
      } finally {
        disposeCanvas(canvas);
      }
    }

    if (signal?.aborted) throw new Error('CANCELLED');
    const zipBytes = await createZip(entries, { maxTotalBytes: LIMITS.MAX_ARCHIVE_BYTES });
    const projSafe = sanitizeFilename(project.name, 'spritesheet');
    return {
      filename: `${projSafe}_bundle.zip`,
      bytes: zipBytes,
      mime: 'application/zip'
    };
  }

  throw new Error(`Loại xuất không hỗ trợ: ${type}`);
}

/**
 * Build deterministic list of frame export tasks & base names per Spec §11.2:
 * - Grid frames: r001_c001.<ext> (default filled only, optional empty)
 * - Group frames: <ten-nhom>_f001.<ext> (keeps repeated cells in timeline order)
 */
export function buildFrameExportTasks(project, config) {
  const scope = config.framesScope || 'all-filled';
  const tasks = [];

  if (scope === 'groups') {
    const anims = project.animations.filter((a) => (config.groupIds || []).includes(a.id));
    for (const anim of anims) {
      const safeGroup = sanitizeFilename(anim.name, 'group');
      for (let i = 0; i < anim.frames.length; i++) {
        const f = anim.frames[i];
        tasks.push({
          row: f.row,
          col: f.col,
          baseName: `${safeGroup}_f${pad3(i + 1)}`
        });
      }
    }
    return tasks;
  }

  if (scope === 'selected-cells') {
    const coords = (config.selectedCells || [])
      .map((k) => (typeof k === 'string' ? parseCellKey(k) : k))
      .filter(Boolean)
      .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
    for (const p of coords) {
      if (!config.includeEmptyGridFrames && !project.cells[cellKey(p.row, p.col)]) continue;
      tasks.push({
        row: p.row,
        col: p.col,
        baseName: `r${pad3(p.row + 1)}_c${pad3(p.col + 1)}`
      });
    }
    return tasks;
  }

  // Default: 'all-filled' (or all grid cells if includeEmptyGridFrames)
  for (let r = 0; r < project.grid.rows; r++) {
    for (let c = 0; c < project.grid.cols; c++) {
      if (!config.includeEmptyGridFrames && !project.cells[cellKey(r, c)]) continue;
      tasks.push({
        row: r,
        col: c,
        baseName: `r${pad3(r + 1)}_c${pad3(c + 1)}`
      });
    }
  }
  return tasks;
}

/**
 * Trigger standard browser file download via Blob URL and revoke URL cleanly.
 */
export function triggerBlobDownload(bytes, filename, mime = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 5000);
}
