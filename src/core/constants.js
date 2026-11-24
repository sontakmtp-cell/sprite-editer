/**
 * Sprite Sheet Builder V2.0 — Core constants, limits, presets, and deterministic helpers.
 */

export const APP_VERSION = '2.1.0';
export const PROJECT_FORMAT = 'sprite-sheet-builder-project';
export const PROJECT_SCHEMA_VERSION = 2;
export const PROJECT_SCHEMA_VERSION_V3 = 3;
export const SUPPORTED_PROJECT_SCHEMA_VERSIONS = Object.freeze([2, 3]);
export const ATLAS_FORMAT = 'sprite-sheet-builder-atlas';
export const ATLAS_SCHEMA_VERSION = 1;
export const ATLAS_SCHEMA_VERSION_V2 = 2;
export const PRESET_FORMAT = 'sprite-sheet-builder-preset';
export const PRESET_SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  MAX_COLS: 64,
  MAX_ROWS: 64,
  MAX_CELLS: 1024,
  MAX_ATLAS_DIM: 8192,
  MAX_ATLAS_PIXELS: 32 * 1024 * 1024, // 33,554,432 (32 Mi pixels)
  SAFE_EXPORT_DIM: 4096,
  SAFE_EXPORT_PIXELS: 16 * 1024 * 1024, // 16,777,216 (16 Mi pixels)
  MAX_SOURCE_BYTES: 20 * 1024 * 1024, // 20 MiB
  MAX_SOURCE_DIM: 8192,
  MAX_SOURCE_PIXELS: 16 * 1024 * 1024, // 16,777,216 (16 Mi pixels)
  MAX_PROJECT_SOURCE_PIXELS: 256 * 1024 * 1024, // 268,435,456 (256 Mi pixels)
  MAX_PROJECT_SOURCE_BYTES: 256 * 1024 * 1024, // 256 MiB
  MAX_SOURCES: 2048,
  MAX_ASSETS: 4096,
  MAX_ANIMATIONS: 256,
  MAX_ANIMATION_SLOTS: 16384,
  MAX_CACHE_PIXELS: 64 * 1024 * 1024, // 64 Mi pixels (~256 MiB RGBA)
  MIN_HISTORY_ENTRIES: 50,
  MAX_HISTORY_ENTRIES: 100,
  MAX_HISTORY_EXTRA_BYTES: 128 * 1024 * 1024, // 128 MiB budget for history-only orphaned blobs
  MAX_ARCHIVE_BYTES: 512 * 1024 * 1024, // 512 MiB compressed or uncompressed total
  MAX_MANIFEST_BYTES: 8 * 1024 * 1024, // 8 MiB
  MAX_ARCHIVE_ENTRIES: 4096,
  MIN_ZOOM: 0.25,
  MAX_ZOOM: 10.0,
  MIN_FPS: 1,
  MAX_FPS: 60,
  MIN_DURATION_MS: 10,
  MAX_DURATION_MS: 10000,
  MIN_ALPHA_THRESHOLD: 0,
  MAX_ALPHA_THRESHOLD: 254,
  DEFAULT_ALPHA_THRESHOLD: 8,
  DEFAULT_WEBP_QUALITY: 0.92,
  DEFAULT_SIZE_VARIANCE_THRESHOLD: 0.2,
  MAX_JSON_DEPTH: 16,
  MAX_CUSTOM_PRESETS: 64,
  MIN_BRUSH_SIZE: 1,
  MAX_BRUSH_SIZE: 128,
  DEFAULT_BRUSH_SIZE: 12,
  MIN_MASK_RADIUS: 0.5,
  MAX_MASK_RADIUS: 64,
  MAX_MASK_POINTS_PER_STROKE: 1024,
  MAX_MASK_STROKES_PER_CELL: 512,
  MAX_MASK_POINTS_PER_CELL: 16384,
  MAX_PROJECT_MASK_STROKES: 8192,
  MAX_PROJECT_MASK_POINTS: 131072,
  MAX_PROJECT_MASK_BYTES: 2 * 1024 * 1024 // 2 MiB serialized mask JSON budget across project
});

export const DEFAULT_GRID = Object.freeze({
  cols: 4,
  rows: 4,
  cellWidth: 192,
  cellHeight: 208
});

export const DEFAULT_SETTINGS = Object.freeze({
  smoothing: true,
  guides: { x: 0.5, y: 0.9 },
  defaultAlphaThreshold: 8,
  webpQuality: 0.92
});

export const DEFAULT_CELL_TRANSFORM = Object.freeze({
  fitMode: 'contain',
  alphaThreshold: 8,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  anchor: Object.freeze({ mode: 'fit-center' })
});

/**
 * Built-in Preset Hatch Pet V2 (Spec §4.2):
 * 8 cols x 11 rows, 192x208 px, 1536x2288 px atlas, 88 cells (73 expected + 15 unused).
 */
export function createHatchPetV2Preset() {
  const rowsSpec = [
    { name: 'idle', count: 6, loopMode: 'loop', fps: 8 },
    { name: 'running-right', count: 8, loopMode: 'loop', fps: 8 },
    { name: 'running-left', count: 8, loopMode: 'loop', fps: 8 },
    { name: 'waving', count: 4, loopMode: 'loop', fps: 8 },
    { name: 'jumping', count: 5, loopMode: 'loop', fps: 8 },
    { name: 'failed', count: 8, loopMode: 'loop', fps: 8 },
    { name: 'waiting', count: 6, loopMode: 'loop', fps: 8 },
    { name: 'running', count: 6, loopMode: 'loop', fps: 8 },
    { name: 'review', count: 6, loopMode: 'loop', fps: 8 },
    { name: 'look directions A', count: 8, loopMode: 'once', fps: 8 },
    { name: 'look directions B', count: 8, loopMode: 'once', fps: 8 }
  ];

  const expectedCells = [];
  const animations = rowsSpec.map((spec, rowIdx) => {
    const frames = [];
    for (let col = 0; col < spec.count; col++) {
      expectedCells.push(cellKey(rowIdx, col));
      frames.push({ row: rowIdx, col, durationMs: null });
    }
    return {
      name: spec.name,
      fps: spec.fps,
      loopMode: spec.loopMode,
      guides: null,
      frames
    };
  });

  return {
    format: PRESET_FORMAT,
    schemaVersion: PRESET_SCHEMA_VERSION,
    id: 'hatch-pet-v2',
    name: 'Hatch Pet V2',
    description: '8 cột × 11 hàng, ô 192×208 px (atlas 1536×2288 px), 73 ô dự kiến và 15 ô dư.',
    builtin: true,
    grid: { cols: 8, rows: 11, cellWidth: 192, cellHeight: 208 },
    expectedCells,
    defaultFps: 8,
    guides: { x: 0.5, y: 0.9 },
    animations
  };
}

export const BUILTIN_PRESETS = Object.freeze([createHatchPetV2Preset()]);

export function cellKey(row, col) {
  return `${row}:${col}`;
}

export function parseCellKey(key) {
  if (typeof key !== 'string') return null;
  const match = /^(\d+):(\d+)$/.exec(key);
  if (!match) return null;
  const row = Number(match[1]);
  const col = Number(match[2]);
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col)) return null;
  return { row, col };
}

export function isCellInGrid(row, col, grid) {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    col >= 0 &&
    row < grid.rows &&
    col < grid.cols
  );
}

/**
 * Deterministic natural string comparison (e.g., frame1 < frame2 < frame10).
 * Case-insensitive primary comparison, case-sensitive tie-breaker.
 */
export function naturalCompare(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const re = /(\d+|\D+)/g;
  const ta = sa.match(re) || [];
  const tb = sb.match(re) || [];
  const len = Math.min(ta.length, tb.length);

  for (let i = 0; i < len; i++) {
    const pa = ta[i];
    const pb = tb[i];
    const da = pa.charCodeAt(0) >= 48 && pa.charCodeAt(0) <= 57;
    const db = pb.charCodeAt(0) >= 48 && pb.charCodeAt(0) <= 57;
    if (da && db) {
      const na = BigInt(pa);
      const nb = BigInt(pb);
      if (na !== nb) return na < nb ? -1 : 1;
      if (pa.length !== pb.length) return pa.length - pb.length;
    } else {
      const la = pa.toLowerCase();
      const lb = pb.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      if (pa !== pb) return pa < pb ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}

/**
 * Stable natural sort for items with a key extractor; ties preserve original index.
 */
export function stableSort(items, comparator) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const cmp = comparator(a.item, b.item);
      return cmp !== 0 ? cmp : a.index - b.index;
    })
    .map((wrapped) => wrapped.item);
}

/**
 * Sanitize a user-provided name into a safe cross-platform filename base.
 */
export function sanitizeFilename(name, fallback = 'untitled') {
  let s = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (!s) s = fallback;

  // Guard Windows reserved device names
  const upper = s.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(upper)) {
    s = `${s}_file`;
  }
  if (s.length > 80) s = s.slice(0, 80).replace(/[_.-]+$/, '') || fallback;
  return s;
}

/**
 * Ensure unique filenames (case-insensitive on Windows) with stable numeric suffix.
 */
export function allocateUniqueFilename(baseName, ext, usedSet) {
  const cleanExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  let candidate = `${baseName}${cleanExt}`;
  let key = candidate.toLowerCase();
  if (!usedSet.has(key)) {
    usedSet.add(key);
    return candidate;
  }
  let n = 2;
  while (true) {
    candidate = `${baseName}_${n}${cleanExt}`;
    key = candidate.toLowerCase();
    if (!usedSet.has(key)) {
      usedSet.add(key);
      return candidate;
    }
    n++;
  }
}

export function pad3(n) {
  return String(n).padStart(3, '0');
}

export function mimeToExt(mime) {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/jpeg': return 'jpg';
    default: return 'bin';
  }
}

let idCounter = 0;
export function generateId(prefix = 'id') {
  idCounter = (idCounter + 1) % 1000000;
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${idCounter.toString(36)}_${rand}`;
}

export function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatNumber(val, decimals = 2) {
  if (!Number.isFinite(val)) return '0';
  const rounded = Number(val.toFixed(decimals));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
