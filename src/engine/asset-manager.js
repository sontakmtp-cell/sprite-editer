/**
 * Sprite Sheet Builder V2.0 — Asset Manager with 64 Mi px LRU Cache, Bleed-Free Region Bitmaps,
 * Concurrency-Limited Decode Queue & Pixel Bounds Cache (Spec §5.1, §6.2, §7, §12.1, §12.2).
 */

import { LIMITS, generateId, mimeToExt } from '../core/constants.js';
import { inspectImageBytes } from '../core/image-inspect.js';
import {
  computeAlphaBoundsFromRGBA,
  computeVisibleBoundsFromRGBA,
  isCompletelyTransparentRGBA
} from '../core/geometry.js';

function closeBitmapSafe(bmp) {
  if (bmp && typeof bmp.close === 'function') {
    try { bmp.close(); } catch {}
  } else if (bmp && bmp instanceof HTMLCanvasElement) {
    bmp.width = 0;
    bmp.height = 0;
  }
}

export class AssetManager {
  constructor(opts = {}) {
    this.maxCachePixels = opts.maxCachePixels ?? LIMITS.MAX_CACHE_PIXELS;
    this.maxConcurrentDecodes = opts.maxConcurrentDecodes ?? 2;

    // Raw compressed source storage: sourceId -> { bytes: Uint8Array, mime: string, byteLength: number }
    this.rawSources = new Map();

    // Unified LRU bitmap cache (sources + cropped regions + thumbnails)
    // key -> { bitmap, pixels, kind, sourceId }
    this.bitmapCache = new Map();
    this.cachedPixels = 0;
    this.evictionCount = 0;

    // Cached pixel analysis per asset region (recomputed lazily on demand, small JSON objects)
    // regionCacheKey -> { allTransparent, visibleBounds, alphaBoundsByThreshold: Map<number, bbox|null> }
    this.pixelAnalysisCache = new Map();

    // Pending decode deduplication map: cacheKey -> Promise
    this.pendingDecodes = new Map();

    // Concurrency queue
    this._activeDecodes = 0;
    this._decodeQueue = [];
    this._activeJobTokens = new Set();

    // Optional test hook for simulating slow decode (T21)
    this.decodeDelayMs = 0;
  }

  _enqueueDecode(taskFn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this._activeDecodes++;
        try {
          if (this.decodeDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.decodeDelayMs));
          }
          resolve(await taskFn());
        } catch (err) {
          reject(err);
        } finally {
          this._activeDecodes--;
          if (this._decodeQueue.length > 0) {
            const next = this._decodeQueue.shift();
            next();
          }
        }
      };

      if (this._activeDecodes < this.maxConcurrentDecodes) {
        run();
      } else {
        this._decodeQueue.push(run);
      }
    });
  }

  _cacheGet(key) {
    const entry = this.bitmapCache.get(key);
    if (!entry) return null;
    // Refresh LRU order (move to end)
    this.bitmapCache.delete(key);
    this.bitmapCache.set(key, entry);
    return entry.bitmap;
  }

  _cacheSet(key, bitmap, pixels, kind, sourceId) {
    if (this.bitmapCache.has(key)) {
      const prev = this.bitmapCache.get(key);
      this.cachedPixels -= prev.pixels;
      closeBitmapSafe(prev.bitmap);
      this.bitmapCache.delete(key);
    }

    // Evict LRU entries until within pixel budget (never evict the single item being inserted)
    while (this.cachedPixels + pixels > this.maxCachePixels && this.bitmapCache.size > 0) {
      const oldestKey = this.bitmapCache.keys().next().value;
      const oldest = this.bitmapCache.get(oldestKey);
      this.bitmapCache.delete(oldestKey);
      this.cachedPixels -= oldest.pixels;
      closeBitmapSafe(oldest.bitmap);
      this.evictionCount++;
    }

    this.bitmapCache.set(key, { bitmap, pixels, kind, sourceId });
    this.cachedPixels += pixels;
  }

  registerSourceBinary(sourceId, bytes, mime) {
    this.rawSources.set(sourceId, {
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      mime,
      byteLength: bytes.byteLength
    });
  }

  hasSourceBinary(sourceId) {
    return this.rawSources.has(sourceId);
  }

  getSourceBytes(sourceId) {
    return this.rawSources.get(sourceId)?.bytes || null;
  }

  getSourceByteLength(sourceId) {
    return this.rawSources.get(sourceId)?.byteLength || 0;
  }

  /**
   * Inspect, validate, and decode-verify an uploaded File/Blob/Uint8Array (Spec §5.1).
   * Returns source descriptor + raw bytes without mutating project state yet.
   */
  async inspectAndVerifyFile(file, existingUsage = { totalSourcePixels: 0, totalSourceBytes: 0, sourceCount: 0 }) {
    const name = file.name || 'image.png';
    if (file.size === 0) {
      return { ok: false, name, error: 'File rỗng (0 byte).' };
    }
    if (file.size > LIMITS.MAX_SOURCE_BYTES) {
      return {
        ok: false,
        name,
        error: `Dung lượng file (${(file.size / (1024 * 1024)).toFixed(2)} MiB) vượt giới hạn 20 MiB.`
      };
    }

    let bytes;
    try {
      const buf = await file.arrayBuffer();
      bytes = new Uint8Array(buf);
    } catch {
      return { ok: false, name, error: 'Không thể đọc dữ liệu file (có thể là thư mục hoặc file bị khóa).' };
    }

    const header = inspectImageBytes(bytes);
    if (!header.ok) {
      return { ok: false, name, code: header.code, error: header.error };
    }

    // Verify real browser decode and reconcile decoded dimensions (handles EXIF orientation!)
    let decoded;
    try {
      decoded = await this._decodeBytesToBitmap(bytes, header.mime);
    } catch (err) {
      return { ok: false, name, error: `Giải mã ảnh thất bại (file hỏng): ${err.message || err}` };
    }

    const realW = decoded.width;
    const realH = decoded.height;
    closeBitmapSafe(decoded);

    if (realW <= 0 || realH <= 0 || realW > LIMITS.MAX_SOURCE_DIM || realH > LIMITS.MAX_SOURCE_DIM) {
      return { ok: false, name, error: `Kích thước ảnh sau giải mã (${realW}×${realH}) vượt giới hạn ${LIMITS.MAX_SOURCE_DIM} px.` };
    }
    const pixels = realW * realH;
    if (pixels > LIMITS.MAX_SOURCE_PIXELS) {
      return { ok: false, name, error: `Tổng số pixel (${pixels.toLocaleString('vi-VN')}) vượt giới hạn 16 Mi pixel.` };
    }

    const sourceId = generateId('src');
    return {
      ok: true,
      name,
      source: {
        id: sourceId,
        name,
        path: `sources/${sourceId}.${mimeToExt(header.mime)}`,
        mime: header.mime,
        width: realW,
        height: realH,
        byteLength: bytes.byteLength,
        importedAt: Date.now(),
        exifOrientation: header.exifOrientation || 1
      },
      bytes
    };
  }

  /**
   * Decode raw image bytes into an ImageBitmap with EXIF orientation applied consistently (Spec §5.1, T26).
   */
  async _decodeBytesToBitmap(bytes, mime) {
    if (this.decodeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.decodeDelayMs));
    }
    const blob = new Blob([bytes], { type: mime });
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch {
        // Fallback if options unsupported
        return await createImageBitmap(blob);
      }
    }
    // Fallback via HTMLImageElement
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Image element decode error'));
        el.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Decode or fetch cached full source bitmap.
   */
  async getSourceBitmap(sourceId) {
    const cacheKey = `src:${sourceId}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;

    if (this.pendingDecodes.has(cacheKey)) {
      return this.pendingDecodes.get(cacheKey);
    }

    const raw = this.rawSources.get(sourceId);
    if (!raw) return null;

    const promise = this._enqueueDecode(async () => {
      const bmp = await this._decodeBytesToBitmap(raw.bytes, raw.mime);
      const pixels = bmp.width * bmp.height;
      this._cacheSet(cacheKey, bmp, pixels, 'source', sourceId);
      return bmp;
    }).finally(() => {
      this.pendingDecodes.delete(cacheKey);
    });

    this.pendingDecodes.set(cacheKey, promise);
    return promise;
  }

  /**
   * Get a bleed-free drawable bitmap for a specific Asset (Spec §7, T04).
   * - If full source (region covers entire source): returns full source bitmap.
   * - If sub-region (sliced asset): extracts exact 1:1 cropped bitmap into LRU cache so
   *   bilinear filtering NEVER samples pixels from neighboring frames!
   */
  async getAssetDrawable(asset, source) {
    if (!asset || !source) return null;
    const { x, y, w, h } = asset.region;
    const isFullSource = x === 0 && y === 0 && w === source.width && h === source.height;

    if (isFullSource) {
      const bmp = await this.getSourceBitmap(source.id);
      if (!bmp) return null;
      return { bitmap: bmp, drawRegion: { x: 0, y: 0, w, h }, isCropped: false };
    }

    const regKey = `reg:${source.id}:${x},${y},${w},${h}`;
    const cached = this._cacheGet(regKey);
    if (cached) {
      return { bitmap: cached, drawRegion: { x: 0, y: 0, w, h }, isCropped: true };
    }

    if (this.pendingDecodes.has(regKey)) {
      const bmp = await this.pendingDecodes.get(regKey);
      return bmp ? { bitmap: bmp, drawRegion: { x: 0, y: 0, w, h }, isCropped: true } : null;
    }

    const promise = (async () => {
      const srcBmp = await this.getSourceBitmap(source.id);
      if (!srcBmp) return null;

      let cropped;
      if (typeof createImageBitmap === 'function') {
        cropped = await createImageBitmap(srcBmp, x, y, w, h);
      } else {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(srcBmp, x, y, w, h, 0, 0, w, h);
        cropped = c;
      }
      this._cacheSet(regKey, cropped, w * h, 'region', source.id);
      return cropped;
    })().finally(() => {
      this.pendingDecodes.delete(regKey);
    });

    this.pendingDecodes.set(regKey, promise);
    const bmp = await promise;
    return bmp ? { bitmap: bmp, drawRegion: { x: 0, y: 0, w, h }, isCropped: true } : null;
  }

  /**
   * Synchronous cache lookup (returns null if not yet decoded in LRU cache).
   */
  getAssetDrawableSync(asset, source) {
    if (!asset || !source) return null;
    const { x, y, w, h } = asset.region;
    const isFullSource = x === 0 && y === 0 && w === source.width && h === source.height;
    if (isFullSource) {
      const bmp = this._cacheGet(`src:${source.id}`);
      return bmp ? { bitmap: bmp, drawRegion: { x: 0, y: 0, w, h }, isCropped: false } : null;
    }
    const bmp = this._cacheGet(`reg:${source.id}:${x},${y},${w},${h}`);
    return bmp ? { bitmap: bmp, drawRegion: { x: 0, y: 0, w, h }, isCropped: true } : null;
  }

  /**
   * Generate/fetch small thumbnail (max 96px) for Library panel (counts toward 64 Mi px LRU budget).
   */
  async getAssetThumbnailDataUrl(asset, source, maxDim = 96) {
    const thumbKey = `thumb:${source.id}:${asset.region.x},${asset.region.y},${asset.region.w},${asset.region.h}`;
    const cached = this._cacheGet(thumbKey);
    if (cached && cached.dataUrl) return cached.dataUrl;

    const drawable = await this.getAssetDrawable(asset, source);
    if (!drawable) return null;

    const scale = Math.min(maxDim / asset.region.w, maxDim / asset.region.h, 1);
    const tw = Math.max(1, Math.round(asset.region.w * scale));
    const th = Math.max(1, Math.round(asset.region.h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(drawable.bitmap, 0, 0, asset.region.w, asset.region.h, 0, 0, tw, th);
    const dataUrl = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;

    this._cacheSet(thumbKey, { dataUrl, close() {} }, tw * th, 'thumbnail', source.id);
    return dataUrl;
  }

  /**
   * Compute and cache pixel analysis (exact transparency, visible bounds, alpha bounds for threshold)
   * for an asset's region. Never runs on full atlas continuously (Spec §6.2, §12.2).
   */
  async analyzeAssetPixels(asset, source, alphaThreshold = 8) {
    if (!asset || !source) {
      return { ok: false, missingSource: true };
    }
    if (!this.rawSources.has(source.id)) {
      return { ok: false, missingSource: true };
    }

    const r = asset.region;
    const regionKey = `${source.id}:${r.x},${r.y},${r.w},${r.h}`;
    let record = this.pixelAnalysisCache.get(regionKey);

    if (record && record.alphaBoundsByThreshold.has(alphaThreshold)) {
      return {
        ok: true,
        allTransparent: record.allTransparent,
        visibleBounds: record.visibleBounds,
        alphaBounds: record.alphaBoundsByThreshold.get(alphaThreshold)
      };
    }

    let drawable;
    try {
      drawable = await this.getAssetDrawable(asset, source);
    } catch (err) {
      return { ok: false, decodeError: err.message || 'Lỗi giải mã' };
    }
    if (!drawable) {
      return { ok: false, decodeError: 'Không giải mã được bitmap' };
    }

    const canvas = document.createElement('canvas');
    canvas.width = r.w;
    canvas.height = r.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(drawable.bitmap, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    const imgData = ctx.getImageData(0, 0, r.w, r.h);
    canvas.width = 0;
    canvas.height = 0;

    if (!record) {
      const allTransparent = isCompletelyTransparentRGBA(imgData.data, r.w, r.h);
      const visibleBounds = allTransparent ? null : computeVisibleBoundsFromRGBA(imgData.data, r.w, r.h);
      record = {
        allTransparent,
        visibleBounds,
        alphaBoundsByThreshold: new Map()
      };
      this.pixelAnalysisCache.set(regionKey, record);
    }

    const alphaBounds = record.allTransparent
      ? null
      : computeAlphaBoundsFromRGBA(imgData.data, r.w, r.h, alphaThreshold);
    record.alphaBoundsByThreshold.set(alphaThreshold, alphaBounds);

    return {
      ok: true,
      allTransparent: record.allTransparent,
      visibleBounds: record.visibleBounds,
      alphaBounds
    };
  }

  /**
   * Synchronous read of cached pixel analysis (null if not analyzed yet).
   */
  getCachedPixelAnalysis(asset, alphaThreshold = 8) {
    if (!asset) return null;
    const r = asset.region;
    const regionKey = `${asset.sourceId}:${r.x},${r.y},${r.w},${r.h}`;
    const record = this.pixelAnalysisCache.get(regionKey);
    if (!record) return null;
    if (!record.alphaBoundsByThreshold.has(alphaThreshold)) return null;
    return {
      ok: true,
      allTransparent: record.allTransparent,
      visibleBounds: record.visibleBounds,
      alphaBounds: record.alphaBoundsByThreshold.get(alphaThreshold)
    };
  }

  /**
   * Check whether a specific sub-region of a source is completely transparent (alpha === 0).
   * Used by Slice Engine optional skip-empty filter (Spec §5.3).
   */
  async checkRegionsTransparency(sourceId, regions) {
    const bmp = await this.getSourceBitmap(sourceId);
    if (!bmp) throw new Error('Không giải mã được ảnh nguồn để kiểm tra vùng trống.');
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);

    const results = new Map();
    for (const reg of regions) {
      const imgData = ctx.getImageData(reg.x, reg.y, reg.w, reg.h);
      results.set(reg.index, isCompletelyTransparentRGBA(imgData.data, reg.w, reg.h));
    }
    canvas.width = 0;
    canvas.height = 0;
    return results;
  }

  /**
   * Release bitmaps, analysis caches, and raw binaries for sources no longer referenced anywhere.
   */
  garbageCollect(referencedSourceIds) {
    let freedRaw = 0;
    for (const id of [...this.rawSources.keys()]) {
      if (!referencedSourceIds.has(id)) {
        this.rawSources.delete(id);
        freedRaw++;
      }
    }
    for (const [key, entry] of [...this.bitmapCache.entries()]) {
      if (!referencedSourceIds.has(entry.sourceId)) {
        this.bitmapCache.delete(key);
        this.cachedPixels -= entry.pixels;
        closeBitmapSafe(entry.bitmap);
      }
    }
    for (const key of [...this.pixelAnalysisCache.keys()]) {
      const srcId = key.split(':')[0];
      if (!referencedSourceIds.has(srcId)) {
        this.pixelAnalysisCache.delete(key);
      }
    }
    return freedRaw;
  }

  clearAllBitmaps() {
    for (const entry of this.bitmapCache.values()) {
      closeBitmapSafe(entry.bitmap);
    }
    this.bitmapCache.clear();
    this.cachedPixels = 0;
  }

  getCacheStats() {
    return {
      cachedPixels: this.cachedPixels,
      maxCachePixels: this.maxCachePixels,
      cacheEntries: this.bitmapCache.size,
      rawSourceCount: this.rawSources.size,
      evictionCount: this.evictionCount
    };
  }
}
