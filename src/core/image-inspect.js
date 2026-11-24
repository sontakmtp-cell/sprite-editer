/**
 * Sprite Sheet Builder V2.0 — Binary Image Header Inspector & Format Validator (Spec §5.1 & §12.1).
 * Validates real file signatures (not just extension/MIME), rejects APNG and animated WebP,
 * reads pre-decode dimensions, and parses JPEG EXIF orientation (1-8).
 */

import { LIMITS } from './constants.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readAscii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function readUint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    ((bytes[offset + 1] << 16) >>> 0) +
    ((bytes[offset + 2] << 8) >>> 0) +
    (bytes[offset + 3] >>> 0)
  );
}

function readUint32LE(bytes, offset) {
  return (
    (bytes[offset] >>> 0) +
    ((bytes[offset + 1] << 8) >>> 0) +
    ((bytes[offset + 2] << 16) >>> 0) +
    ((bytes[offset + 3] << 24) >>> 0)
  );
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function isPng(bytes) {
  if (bytes.length < 24) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) return false;
  }
  return true;
}

function inspectPng(bytes) {
  const ihdrLen = readUint32BE(bytes, 8);
  const ihdrType = readAscii(bytes, 12, 4);
  if (ihdrType !== 'IHDR' || ihdrLen !== 13 || bytes.length < 33) {
    return { ok: false, error: 'File PNG bị hỏng (thiếu hoặc sai chunk IHDR).' };
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width <= 0 || height <= 0) {
    return { ok: false, error: 'Kích thước PNG không hợp lệ.' };
  }

  // Scan chunks until IDAT or IEND to detect APNG (acTL chunk)
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const chunkLen = readUint32BE(bytes, pos);
    const chunkType = readAscii(bytes, pos + 4, 4);
    if (chunkType === 'acTL') {
      return { ok: false, code: 'ANIMATED_PNG', error: 'Không hỗ trợ ảnh động APNG.' };
    }
    if (chunkType === 'IDAT' || chunkType === 'IEND') {
      break;
    }
    const nextPos = pos + 12 + chunkLen;
    if (nextPos <= pos || nextPos > bytes.length) break;
    pos = nextPos;
  }

  return {
    ok: true,
    mime: 'image/png',
    ext: 'png',
    width,
    height,
    rawWidth: width,
    rawHeight: height,
    exifOrientation: 1
  };
}

function isWebp(bytes) {
  return (
    bytes.length >= 16 &&
    readAscii(bytes, 0, 4) === 'RIFF' &&
    readAscii(bytes, 8, 4) === 'WEBP'
  );
}

function inspectWebp(bytes) {
  let pos = 12;
  let width = 0;
  let height = 0;
  let animated = false;

  while (pos + 8 <= bytes.length) {
    const fourCC = readAscii(bytes, pos, 4);
    const chunkSize = readUint32LE(bytes, pos + 4);
    const dataPos = pos + 8;

    if (fourCC === 'ANIM' || fourCC === 'ANMF') {
      animated = true;
      break;
    }

    if (fourCC === 'VP8X' && dataPos + 10 <= bytes.length) {
      const flags = bytes[dataPos];
      if ((flags & 0x02) !== 0) {
        animated = true;
        break;
      }
      width = readUint24LE(bytes, dataPos + 4) + 1;
      height = readUint24LE(bytes, dataPos + 7) + 1;
    } else if (fourCC === 'VP8 ' && dataPos + 10 <= bytes.length) {
      // Lossy VP8 bitstream: frame tag 3 bytes, start code 0x9d 0x01 0x2a at +3..+5
      if (bytes[dataPos + 3] === 0x9d && bytes[dataPos + 4] === 0x01 && bytes[dataPos + 5] === 0x2a) {
        width = readUint16LE(bytes, dataPos + 6) & 0x3fff;
        height = readUint16LE(bytes, dataPos + 8) & 0x3fff;
      }
    } else if (fourCC === 'VP8L' && dataPos + 5 <= bytes.length) {
      // Lossless VP8L: signature byte 0x2f, then 14-bit width-1, 14-bit height-1
      if (bytes[dataPos] === 0x2f) {
        const b0 = bytes[dataPos + 1];
        const b1 = bytes[dataPos + 2];
        const b2 = bytes[dataPos + 3];
        const b3 = bytes[dataPos + 4];
        width = 1 + (((b1 & 0x3f) << 8) | b0);
        height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      }
    }

    const paddedSize = chunkSize + (chunkSize & 1);
    const nextPos = dataPos + paddedSize;
    if (nextPos <= pos) break;
    pos = nextPos;
  }

  if (animated) {
    return { ok: false, code: 'ANIMATED_WEBP', error: 'Không hỗ trợ ảnh động WebP.' };
  }
  if (width <= 0 || height <= 0) {
    return { ok: false, error: 'File WebP bị hỏng hoặc không đọc được kích thước.' };
  }

  return {
    ok: true,
    mime: 'image/webp',
    ext: 'webp',
    width,
    height,
    rawWidth: width,
    rawHeight: height,
    exifOrientation: 1
  };
}

function isJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function parseExifOrientation(bytes, start, length) {
  // Expect "Exif\0\0"
  if (length < 14 || start + length > bytes.length) return 1;
  if (
    bytes[start] !== 0x45 ||
    bytes[start + 1] !== 0x78 ||
    bytes[start + 2] !== 0x69 ||
    bytes[start + 3] !== 0x66 ||
    bytes[start + 4] !== 0x00 ||
    bytes[start + 5] !== 0x00
  ) {
    return 1;
  }
  const tiffStart = start + 6;
  const end = start + length;
  if (tiffStart + 8 > end) return 1;

  const littleEndian =
    bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
  const bigEndian =
    bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return 1;

  const r16 = littleEndian ? readUint16LE : readUint16BE;
  const r32 = littleEndian ? readUint32LE : readUint32BE;

  if (r16(bytes, tiffStart + 2) !== 0x002a) return 1;
  const ifdOffset = r32(bytes, tiffStart + 4);
  const ifdPos = tiffStart + ifdOffset;
  if (ifdPos + 2 > end) return 1;

  const entries = r16(bytes, ifdPos);
  for (let i = 0; i < entries; i++) {
    const entryPos = ifdPos + 2 + i * 12;
    if (entryPos + 12 > end) break;
    const tag = r16(bytes, entryPos);
    if (tag === 0x0112) {
      const orientation = r16(bytes, entryPos + 8);
      if (orientation >= 1 && orientation <= 8) return orientation;
    }
  }
  return 1;
}

function inspectJpeg(bytes) {
  let pos = 2;
  let rawWidth = 0;
  let rawHeight = 0;
  let exifOrientation = 1;

  while (pos + 4 <= bytes.length) {
    // Skip padding 0xFF bytes
    while (pos < bytes.length && bytes[pos] === 0xff) pos++;
    if (pos >= bytes.length) break;
    const marker = bytes[pos++];

    // Standalone markers without length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (marker === 0xd9) break;
      continue;
    }
    // Start of scan: stop scanning headers
    if (marker === 0xda) break;

    if (pos + 2 > bytes.length) break;
    const segLen = readUint16BE(bytes, pos);
    if (segLen < 2 || pos + segLen > bytes.length) break;

    // APP1 EXIF
    if (marker === 0xe1 && exifOrientation === 1) {
      exifOrientation = parseExifOrientation(bytes, pos + 2, segLen - 2);
    }

    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && segLen >= 7) {
      rawHeight = readUint16BE(bytes, pos + 3);
      rawWidth = readUint16BE(bytes, pos + 5);
    }

    pos += segLen;
  }

  if (rawWidth <= 0 || rawHeight <= 0) {
    return { ok: false, error: 'File JPEG bị hỏng hoặc không đọc được kích thước.' };
  }

  // Orientations 5,6,7,8 swap width and height
  const swapsAxes = exifOrientation >= 5 && exifOrientation <= 8;
  const width = swapsAxes ? rawHeight : rawWidth;
  const height = swapsAxes ? rawWidth : rawHeight;

  return {
    ok: true,
    mime: 'image/jpeg',
    ext: 'jpg',
    width,
    height,
    rawWidth,
    rawHeight,
    exifOrientation
  };
}

function isGif(bytes) {
  if (bytes.length < 6) return false;
  const hdr = readAscii(bytes, 0, 6);
  return hdr === 'GIF87a' || hdr === 'GIF89a';
}

function looksLikeSvgOrText(bytes) {
  const sampleLen = Math.min(bytes.length, 256);
  const sample = readAscii(bytes, 0, sampleLen).trim().toLowerCase();
  return sample.startsWith('<svg') || sample.startsWith('<?xml') || sample.startsWith('<!doctype') || sample.startsWith('<html');
}

/**
 * Inspect raw image bytes, validate format (PNG/WebP/JPEG static only) and size limits.
 * @param {Uint8Array} bytes
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=LIMITS.MAX_SOURCE_BYTES]
 * @returns {{ok:boolean, mime?:string, ext?:string, width?:number, height?:number, rawWidth?:number, rawHeight?:number, exifOrientation?:number, byteLength?:number, code?:string, error?:string}}
 */
export function inspectImageBytes(bytes, opts = {}) {
  const maxBytes = opts.maxBytes ?? LIMITS.MAX_SOURCE_BYTES;
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'Dữ liệu ảnh không hợp lệ.' };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'EMPTY_FILE', error: 'File rỗng (0 byte).' };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: `Dung lượng file (${(bytes.byteLength / (1024 * 1024)).toFixed(2)} MiB) vượt giới hạn ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB.`
    };
  }

  let info;
  if (isPng(bytes)) {
    info = inspectPng(bytes);
  } else if (isWebp(bytes)) {
    info = inspectWebp(bytes);
  } else if (isJpeg(bytes)) {
    info = inspectJpeg(bytes);
  } else if (isGif(bytes)) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', error: 'Không hỗ trợ định dạng GIF. Chỉ hỗ trợ PNG, WebP và JPG tĩnh.' };
  } else if (looksLikeSvgOrText(bytes)) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', error: 'Không hỗ trợ SVG hoặc file văn bản/HTML. Chỉ hỗ trợ ảnh raster PNG, WebP, JPG tĩnh.' };
  } else {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', error: 'Định dạng file không được hỗ trợ hoặc file bị hỏng (chữ ký nhị phân không phải PNG/WebP/JPEG).' };
  }

  if (!info.ok) return info;

  if (info.width > LIMITS.MAX_SOURCE_DIM || info.height > LIMITS.MAX_SOURCE_DIM) {
    return {
      ok: false,
      code: 'DIM_TOO_LARGE',
      error: `Kích thước ảnh ${info.width}×${info.height} px vượt giới hạn ${LIMITS.MAX_SOURCE_DIM} px mỗi chiều.`
    };
  }
  const pixels = info.width * info.height;
  if (pixels > LIMITS.MAX_SOURCE_PIXELS) {
    return {
      ok: false,
      code: 'PIXELS_TOO_LARGE',
      error: `Tổng số pixel (${pixels.toLocaleString('vi-VN')}) vượt giới hạn ${LIMITS.MAX_SOURCE_PIXELS.toLocaleString('vi-VN')} pixel (16 Mi pixel).`
    };
  }

  return {
    ...info,
    byteLength: bytes.byteLength
  };
}

/**
 * Verify encoded output Blob matches requested format signature (Spec §11.2 T05/T08).
 */
export function verifyEncodedSignature(bytes, expectedMime) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    return { ok: false, error: 'Dữ liệu ảnh xuất rỗng hoặc quá ngắn.' };
  }
  if (expectedMime === 'image/png') {
    if (!isPng(bytes)) {
      return { ok: false, error: 'Chữ ký file xuất không phải PNG.' };
    }
    return { ok: true };
  }
  if (expectedMime === 'image/webp') {
    if (isPng(bytes)) {
      return {
        ok: false,
        code: 'WEBP_FALLBACK_PNG',
        error: 'Trình duyệt đã fallback sang PNG thay vì mã hóa WebP. Hãy chọn định dạng PNG.'
      };
    }
    if (!isWebp(bytes)) {
      return { ok: false, error: 'Chữ ký file xuất không phải WebP.' };
    }
    return { ok: true };
  }
  return { ok: false, error: `Định dạng xuất không hỗ trợ: ${expectedMime}` };
}
