/**
 * Sprite Sheet Builder V2.0 — Project `.ssb` Archive Serializer & Deserializer (Spec §10.2, §12.3).
 * Format: ZIP archive with `manifest.json` at root and `sources/<id>.<ext>` raw image binaries.
 */

import {
  LIMITS,
  PROJECT_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION_V3,
  mimeToExt,
  deepClone
} from '../core/constants.js';
import { inspectImageBytes } from '../core/image-inspect.js';
import { normalizeCellMask, projectHasMasks } from '../core/mask.js';
import { validateProjectManifest } from '../core/validator.js';
import { createZip, readZip } from './zip.js';

const SOURCE_ENTRY_RE = /^sources\/([A-Za-z0-9_-]+)\.(png|webp|jpg|jpeg)$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Serialize a committed project snapshot + source binary blobs into a `.ssb` ZIP Uint8Array.
 * @param {object} project
 * @param {function} getSourceBytes  (sourceId) => Uint8Array | null
 * @param {function} [onProgress]
 */
export async function serializeProjectToSsb(project, getSourceBytes, onProgress = null) {
  const manifest = deepClone(project);
  // Ensure every source path matches normalized format
  for (const src of manifest.sources) {
    src.path = `sources/${src.id}.${mimeToExt(src.mime)}`;
  }
  // Normalize empty masks and select exact schema version (V3 if any cell has mask, V2 otherwise)
  if (manifest.cells && typeof manifest.cells === 'object') {
    for (const key of Object.keys(manifest.cells)) {
      const cell = manifest.cells[key];
      const norm = normalizeCellMask(cell?.mask);
      if (norm) cell.mask = norm;
      else if (cell) delete cell.mask;
    }
  }
  manifest.schemaVersion = projectHasMasks(manifest)
    ? PROJECT_SCHEMA_VERSION_V3
    : PROJECT_SCHEMA_VERSION;

  const val = validateProjectManifest(manifest);
  if (!val.ok) {
    throw new Error(`Manifest không hợp lệ khi lưu: ${val.errors[0]}`);
  }

  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestBytes = textEncoder.encode(manifestJson);
  if (manifestBytes.byteLength > LIMITS.MAX_MANIFEST_BYTES) {
    throw new Error(`Manifest vượt giới hạn ${(LIMITS.MAX_MANIFEST_BYTES / (1024 * 1024)).toFixed(0)} MiB.`);
  }

  const entries = [
    { name: 'manifest.json', data: manifestBytes, compress: true }
  ];

  const totalSteps = manifest.sources.length + 1;
  if (onProgress) onProgress(1, totalSteps, 'Đang đóng gói manifest...');

  for (let i = 0; i < manifest.sources.length; i++) {
    const src = manifest.sources[i];
    const bytes = await getSourceBytes(src.id);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error(`Thiếu dữ liệu nhị phân của nguồn "${src.name}" (${src.id}).`);
    }
    if (bytes.byteLength !== src.byteLength) {
      src.byteLength = bytes.byteLength;
    }
    // Store raw original image binaries without re-encoding or re-compressing
    entries.push({ name: src.path, data: bytes, compress: false });
    if (onProgress) onProgress(i + 2, totalSteps, `Đang đóng gói nguồn ${i + 1}/${manifest.sources.length}...`);
  }

  return createZip(entries, { maxTotalBytes: LIMITS.MAX_ARCHIVE_BYTES });
}

/**
 * Deserialize and strictly validate a `.ssb` archive before replacing any active project.
 * Never returns a partial project on error (Spec §10.2, §12.3).
 *
 * @param {Uint8Array} archiveBytes
 * @param {function} [onProgress]
 * @returns {Promise<{ok:boolean, project?:object, sourceBinaries?:Map<string, {bytes:Uint8Array, mime:string}>, errors?:string[]}>}
 */
export async function deserializeProjectFromSsb(archiveBytes, onProgress = null) {
  let entries;
  try {
    entries = await readZip(archiveBytes, {
      maxArchiveBytes: LIMITS.MAX_ARCHIVE_BYTES,
      maxUncompressedTotal: LIMITS.MAX_ARCHIVE_BYTES,
      maxEntries: LIMITS.MAX_SOURCES + 4,
      getEntryLimit: (name) => {
        if (name === 'manifest.json') return LIMITS.MAX_MANIFEST_BYTES;
        return LIMITS.MAX_SOURCE_BYTES;
      },
      validateEntryName: (name) => {
        if (name === 'manifest.json') return null;
        if (SOURCE_ENTRY_RE.test(name)) return null;
        return `Archive .ssb chứa entry không được phép: "${name}".`;
      },
      onProgress: (done, total) => {
        if (onProgress) onProgress(done, total, `Đang giải nén archive (${done}/${total})...`);
      }
    });
  } catch (err) {
    return { ok: false, errors: [err.message || 'Không đọc được archive .ssb.'] };
  }

  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) {
    return { ok: false, errors: ['Archive .ssb thiếu file manifest.json ở thư mục gốc.'] };
  }

  let parsed;
  try {
    const jsonText = textDecoder.decode(manifestBytes);
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, errors: ['File manifest.json không phải JSON UTF-8 hợp lệ.'] };
  }

  const val = validateProjectManifest(parsed);
  if (!val.ok) {
    return { ok: false, errors: val.errors };
  }

  // Verify exact 1-to-1 correspondence between manifest.sources and archive entries
  const expectedPaths = new Set(parsed.sources.map((s) => s.path));
  for (const name of entries.keys()) {
    if (name === 'manifest.json') continue;
    if (!expectedPaths.has(name)) {
      return {
        ok: false,
        errors: [`Archive chứa file nguồn thừa không có trong manifest: "${name}".`]
      };
    }
  }

  const sourceBinaries = new Map();
  for (const src of parsed.sources) {
    const bytes = entries.get(src.path);
    if (!bytes) {
      return {
        ok: false,
        errors: [`Thiếu file nguồn trong archive: "${src.path}" (${src.name}).`]
      };
    }
    if (bytes.byteLength !== src.byteLength) {
      return {
        ok: false,
        errors: [`Kích thước file "${src.path}" (${bytes.byteLength} B) không khớp manifest (${src.byteLength} B).`]
      };
    }
    const inspected = inspectImageBytes(bytes);
    if (!inspected.ok) {
      return {
        ok: false,
        errors: [`Nguồn "${src.name}" (${src.path}) không hợp lệ: ${inspected.error}`]
      };
    }
    if (inspected.mime !== src.mime) {
      return {
        ok: false,
        errors: [`MIME của "${src.name}" (${inspected.mime}) không khớp manifest (${src.mime}).`]
      };
    }
    if (inspected.width !== src.width || inspected.height !== src.height) {
      return {
        ok: false,
        errors: [`Kích thước thực của "${src.name}" (${inspected.width}×${inspected.height}) không khớp manifest (${src.width}×${src.height}).`]
      };
    }
    sourceBinaries.set(src.id, { bytes, mime: inspected.mime });
  }

  return {
    ok: true,
    project: parsed,
    sourceBinaries
  };
}
