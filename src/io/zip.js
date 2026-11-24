/**
 * Sprite Sheet Builder V2.0 — Zero-Dependency Hardened ZIP Reader & Writer (Spec §10.2, §11.1, §12.3).
 * Supports STORE (method 0) and DEFLATE (method 8 via CompressionStream/DecompressionStream).
 * Enforces strict streaming byte limits during inflate (zip-bomb defense), CRC-32 verification,
 * path-traversal/symlink/encryption/duplicate-entry rejection.
 */

import { LIMITS } from '../core/constants.js';

// Precomputed IEEE 802.3 CRC-32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function readU16(view, off) {
  return view.getUint16(off, true);
}
function readU32(view, off) {
  return view.getUint32(off, true);
}
function writeU16(view, off, val) {
  view.setUint16(off, val & 0xffff, true);
}
function writeU32(view, off, val) {
  view.setUint32(off, val >>> 0, true);
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

/**
 * Validate ZIP internal entry path against traversal, absolute paths, drive letters, backslashes, null bytes.
 */
export function validateZipEntryPath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 512) {
    return 'Tên entry ZIP rỗng hoặc quá dài.';
  }
  if (name.includes('\0') || name.includes('\\')) {
    return `Đường dẫn ZIP không an toàn: "${name}"`;
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return `Không cho phép đường dẫn tuyệt đối trong ZIP: "${name}"`;
  }
  const parts = name.split('/');
  for (const part of parts) {
    if (part === '..' || part === '.') {
      return `Phát hiện path traversal trong ZIP: "${name}"`;
    }
  }
  return null;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close());
    const reader = cs.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Streaming bounded inflate-raw: aborts immediately if inflated bytes exceed maxEntryBytes
 * or remainingTotalBytes (stops zip bombs regardless of forged header sizes!).
 */
async function inflateRawBounded(compressedBytes, maxEntryBytes, remainingTotalBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Trình duyệt không hỗ trợ DecompressionStream(deflate-raw) để giải nén ZIP.');
  }
  const limit = Math.min(maxEntryBytes, remainingTotalBytes);
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Feed in chunks so we can abort early if output explodes
  const CHUNK_SIZE = 65536;
  let feedErr = null;
  let aborted = false;

  const feedPromise = (async () => {
    try {
      for (let off = 0; off < compressedBytes.byteLength; off += CHUNK_SIZE) {
        if (aborted) break;
        const slice = compressedBytes.subarray(off, Math.min(off + CHUNK_SIZE, compressedBytes.byteLength));
        await writer.write(slice);
      }
      if (!aborted) await writer.close();
    } catch (err) {
      feedErr = err;
    }
  })();

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        aborted = true;
        try { await reader.cancel(); } catch {}
        try { await writer.abort(); } catch {}
        throw new Error(`Dữ liệu giải nén thực tế vượt giới hạn cho phép (${limit} bytes).`);
      }
      chunks.push(value);
    }
  } finally {
    aborted = true;
    await feedPromise.catch(() => {});
  }

  if (feedErr && chunks.length === 0) {
    throw new Error('Lỗi giải nén luồng DEFLATE trong archive.');
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Create a PKZIP 2.0 archive as Uint8Array.
 * @param {Array<{name:string, data:Uint8Array, compress?:boolean}>} entries
 * @param {object} [options]
 */
export async function createZip(entries, options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? LIMITS.MAX_ARCHIVE_BYTES;
  if (!Array.isArray(entries)) {
    throw new Error('Danh sách entry ZIP không hợp lệ.');
  }
  if (entries.length > LIMITS.MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Số lượng file trong ZIP (${entries.length}) vượt giới hạn ${LIMITS.MAX_ARCHIVE_ENTRIES}.`);
  }

  const { dosDate, dosTime } = getDosDateTime(new Date());
  const usedNames = new Set();
  const prepared = [];
  let totalDataBytes = 0;

  for (const entry of entries) {
    const pathErr = validateZipEntryPath(entry.name);
    if (pathErr) throw new Error(pathErr);
    const lower = entry.name.toLowerCase();
    if (usedNames.has(lower)) {
      throw new Error(`Trùng tên file trong ZIP: "${entry.name}".`);
    }
    usedNames.add(lower);

    const raw = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    totalDataBytes += raw.byteLength;
    if (totalDataBytes > maxTotalBytes) {
      throw new Error(`Tổng dung lượng dữ liệu ZIP vượt giới hạn ${(maxTotalBytes / (1024 * 1024)).toFixed(0)} MiB.`);
    }

    const nameBytes = textEncoder.encode(entry.name);
    const crc = crc32(raw);
    let method = 0;
    let payload = raw;

    if (entry.compress && raw.byteLength > 64) {
      const deflated = await deflateRaw(raw);
      if (deflated && deflated.byteLength < raw.byteLength) {
        method = 8;
        payload = deflated;
      }
    }

    prepared.push({
      name: entry.name,
      nameBytes,
      rawSize: raw.byteLength,
      compSize: payload.byteLength,
      crc,
      method,
      payload,
      localHeaderOffset: 0
    });
  }

  // Compute total output byte size
  let localSectionSize = 0;
  let cdSize = 0;
  for (const p of prepared) {
    p.localHeaderOffset = localSectionSize;
    localSectionSize += 30 + p.nameBytes.byteLength + p.compSize;
    cdSize += 46 + p.nameBytes.byteLength;
  }
  const totalArchiveSize = localSectionSize + cdSize + 22;
  if (totalArchiveSize > maxTotalBytes) {
    throw new Error(`Kích thước file ZIP xuất (${(totalArchiveSize / (1024 * 1024)).toFixed(1)} MiB) vượt giới hạn ${(maxTotalBytes / (1024 * 1024)).toFixed(0)} MiB.`);
  }

  const out = new Uint8Array(totalArchiveSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  // Local file headers + data
  for (const p of prepared) {
    writeU32(view, pos, 0x04034b50); // Local file header signature
    writeU16(view, pos + 4, 20); // Version needed (2.0)
    writeU16(view, pos + 6, 0x0800); // General purpose flag: UTF-8 filename
    writeU16(view, pos + 8, p.method);
    writeU16(view, pos + 10, dosTime);
    writeU16(view, pos + 12, dosDate);
    writeU32(view, pos + 14, p.crc);
    writeU32(view, pos + 18, p.compSize);
    writeU32(view, pos + 22, p.rawSize);
    writeU16(view, pos + 26, p.nameBytes.byteLength);
    writeU16(view, pos + 28, 0); // Extra field length
    pos += 30;
    out.set(p.nameBytes, pos);
    pos += p.nameBytes.byteLength;
    out.set(p.payload, pos);
    pos += p.compSize;
  }

  const cdOffset = pos;

  // Central directory entries
  for (const p of prepared) {
    writeU32(view, pos, 0x02014b50); // Central directory signature
    writeU16(view, pos + 4, 0x0314); // Version made by: Unix (3), spec 2.0
    writeU16(view, pos + 6, 20); // Version needed
    writeU16(view, pos + 8, 0x0800); // UTF-8
    writeU16(view, pos + 10, p.method);
    writeU16(view, pos + 12, dosTime);
    writeU16(view, pos + 14, dosDate);
    writeU32(view, pos + 16, p.crc);
    writeU32(view, pos + 20, p.compSize);
    writeU32(view, pos + 24, p.rawSize);
    writeU16(view, pos + 28, p.nameBytes.byteLength);
    writeU16(view, pos + 30, 0); // Extra length
    writeU16(view, pos + 32, 0); // Comment length
    writeU16(view, pos + 34, 0); // Disk number start
    writeU16(view, pos + 36, 0); // Internal file attributes
    writeU32(view, pos + 38, 0o100644 << 16); // Regular file permissions
    writeU32(view, pos + 42, p.localHeaderOffset);
    pos += 46;
    out.set(p.nameBytes, pos);
    pos += p.nameBytes.byteLength;
  }

  // End of Central Directory (EOCD)
  writeU32(view, pos, 0x06054b50);
  writeU16(view, pos + 4, 0); // Disk number
  writeU16(view, pos + 6, 0); // Disk with CD
  writeU16(view, pos + 8, prepared.length);
  writeU16(view, pos + 10, prepared.length);
  writeU32(view, pos + 12, cdSize);
  writeU32(view, pos + 16, cdOffset);
  writeU16(view, pos + 20, 0); // Comment length

  return out;
}

/**
 * Read and verify a ZIP archive with strict security and streaming decompression bounds.
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(bytes, options = {}) {
  const maxArchiveBytes = options.maxArchiveBytes ?? LIMITS.MAX_ARCHIVE_BYTES;
  const maxUncompressedTotal = options.maxUncompressedTotal ?? LIMITS.MAX_ARCHIVE_BYTES;
  const maxEntries = options.maxEntries ?? LIMITS.MAX_ARCHIVE_ENTRIES;
  const entryLimitFn = options.getEntryLimit ?? (() => LIMITS.MAX_ARCHIVE_BYTES);
  const entryFilter = options.validateEntryName ?? null;
  const onProgress = options.onProgress ?? null;

  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Dữ liệu archive không hợp lệ.');
  }
  if (bytes.byteLength < 22) {
    throw new Error('File không phải định dạng ZIP hợp lệ (quá ngắn).');
  }
  if (bytes.byteLength > maxArchiveBytes) {
    throw new Error(`Kích thước archive (${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB) vượt giới hạn ${(maxArchiveBytes / (1024 * 1024)).toFixed(0)} MiB.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory (EOCD) within last 65557 bytes
  const minEocdPos = Math.max(0, bytes.byteLength - 65557);
  let eocdPos = -1;
  for (let i = bytes.byteLength - 22; i >= minEocdPos; i--) {
    if (readU32(view, i) === 0x06054b50) {
      const commentLen = readU16(view, i + 20);
      if (i + 22 + commentLen === bytes.byteLength) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos === -1) {
    throw new Error('Archive ZIP bị hỏng (không tìm thấy End of Central Directory).');
  }

  const diskNum = readU16(view, eocdPos + 4);
  const cdDisk = readU16(view, eocdPos + 6);
  const totalEntries = readU16(view, eocdPos + 10);
  const cdSize = readU32(view, eocdPos + 12);
  const cdOffset = readU32(view, eocdPos + 16);

  if (diskNum !== 0 || cdDisk !== 0) {
    throw new Error('Không hỗ trợ archive ZIP nhiều phần (multi-disk).');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('Không hỗ trợ archive ZIP64 hoặc kích thước vượt giới hạn.');
  }
  if (totalEntries > maxEntries) {
    throw new Error(`Số entry trong ZIP (${totalEntries}) vượt giới hạn ${maxEntries}.`);
  }
  if (cdOffset + cdSize > eocdPos) {
    throw new Error('Central Directory của ZIP bị hỏng hoặc vượt biên file.');
  }

  // Parse Central Directory first (before any decompression)
  const cdEntries = [];
  const seenNames = new Set();
  let declaredTotalUncompressed = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdOffset + cdSize) {
      throw new Error('Central Directory bị cắt cụt.');
    }
    if (readU32(view, pos) !== 0x02014b50) {
      throw new Error('Chữ ký Central Directory không khớp.');
    }
    const versionMadeBy = readU16(view, pos + 4);
    const flags = readU16(view, pos + 8);
    const method = readU16(view, pos + 10);
    const crc = readU32(view, pos + 16);
    const compSize = readU32(view, pos + 20);
    const rawSize = readU32(view, pos + 24);
    const nameLen = readU16(view, pos + 28);
    const extraLen = readU16(view, pos + 30);
    const commentLen = readU16(view, pos + 32);
    const extAttr = readU32(view, pos + 38);
    const localOffset = readU32(view, pos + 42);

    if (pos + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) {
      throw new Error('Entry trong Central Directory vượt biên.');
    }

    // Security checks
    if ((flags & 0x01) !== 0) {
      throw new Error('Không hỗ trợ archive ZIP có mật khẩu/mã hóa.');
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`Không hỗ trợ phương thức nén ZIP (${method}). Chỉ hỗ trợ STORE (0) và DEFLATE (8).`);
    }

    // Check Unix symlink bit
    const hostOs = versionMadeBy >> 8;
    const unixMode = (extAttr >>> 16) & 0o170000;
    if ((hostOs === 3 || unixMode !== 0) && unixMode === 0o120000) {
      throw new Error('Archive chứa symbolic link không được phép.');
    }

    let name;
    try {
      name = textDecoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    } catch {
      throw new Error('Tên file trong ZIP chứa chuỗi UTF-8 không hợp lệ.');
    }

    const pathErr = validateZipEntryPath(name);
    if (pathErr) throw new Error(pathErr);

    const lower = name.toLowerCase();
    if (seenNames.has(lower)) {
      throw new Error(`Archive chứa tên entry trùng lặp: "${name}".`);
    }
    seenNames.add(lower);

    if (entryFilter) {
      const filterErr = entryFilter(name);
      if (filterErr) throw new Error(filterErr);
    }

    const perEntryMax = entryLimitFn(name);
    if (rawSize > perEntryMax) {
      throw new Error(`Entry "${name}" khai báo kích thước (${rawSize} bytes) vượt giới hạn (${perEntryMax} bytes).`);
    }
    declaredTotalUncompressed += rawSize;
    if (declaredTotalUncompressed > maxUncompressedTotal) {
      throw new Error(`Tổng dung lượng giải nén khai báo vượt giới hạn ${(maxUncompressedTotal / (1024 * 1024)).toFixed(0)} MiB.`);
    }

    cdEntries.push({ name, flags, method, crc, compSize, rawSize, localOffset, perEntryMax });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Extract and verify each entry with streaming size enforcement + CRC-32 check
  const result = new Map();
  let actualTotalUncompressed = 0;

  for (let i = 0; i < cdEntries.length; i++) {
    const e = cdEntries[i];
    if (e.localOffset + 30 > bytes.byteLength) {
      throw new Error(`Local header của "${e.name}" vượt biên archive.`);
    }
    if (readU32(view, e.localOffset) !== 0x04034b50) {
      throw new Error(`Chữ ký local header của "${e.name}" không hợp lệ.`);
    }
    const localFlags = readU16(view, e.localOffset + 6);
    const localMethod = readU16(view, e.localOffset + 8);
    if ((localFlags & 0x01) !== 0) {
      throw new Error(`Entry "${e.name}" bị mã hóa.`);
    }
    if (localMethod !== e.method) {
      throw new Error(`Phương thức nén không khớp giữa local header và central directory ở "${e.name}".`);
    }

    const localNameLen = readU16(view, e.localOffset + 26);
    const localExtraLen = readU16(view, e.localOffset + 28);
    const dataStart = e.localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + e.compSize;

    if (dataEnd > bytes.byteLength || dataEnd < dataStart) {
      throw new Error(`Dữ liệu của entry "${e.name}" bị cắt cụt.`);
    }

    const compSlice = bytes.subarray(dataStart, dataEnd);
    let extracted;

    if (e.method === 0) {
      if (e.compSize !== e.rawSize) {
        throw new Error(`Entry STORE "${e.name}" có kích thước nén và giải nén không khớp.`);
      }
      if (actualTotalUncompressed + e.rawSize > maxUncompressedTotal) {
        throw new Error('Tổng dung lượng giải nén vượt giới hạn.');
      }
      extracted = new Uint8Array(compSlice); // copy slice cleanly
    } else {
      const remainingTotal = maxUncompressedTotal - actualTotalUncompressed;
      const effectiveMax = Math.min(e.perEntryMax, e.rawSize);
      extracted = await inflateRawBounded(compSlice, effectiveMax, remainingTotal);
      if (extracted.byteLength !== e.rawSize) {
        throw new Error(`Kích thước giải nén thực tế của "${e.name}" (${extracted.byteLength}) không khớp header (${e.rawSize}).`);
      }
    }

    const actualCrc = crc32(extracted);
    if (actualCrc !== e.crc) {
      throw new Error(`Lỗi kiểm tra CRC-32 tại entry "${e.name}" (dữ liệu bị hỏng).`);
    }

    actualTotalUncompressed += extracted.byteLength;
    result.set(e.name, extracted);

    if (onProgress) {
      onProgress(i + 1, cdEntries.length);
    }
  }

  return result;
}
