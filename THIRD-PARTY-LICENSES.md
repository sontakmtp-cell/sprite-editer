# Giấy phép bên thứ ba (Third-Party Licenses)

## Ứng dụng phát hành (`dist/sprite-sheet-builder.html`)

**Không sử dụng bất kỳ thư viện runtime bên thứ ba nào.**

Toàn bộ mã nguồn chạy trong trình duyệt (bao gồm trình xử lý hình học, trình kiểm tra định dạng nhị phân PNG/WebP/JPEG-EXIF, bộ đọc/ghi PKZIP 2.0 tích hợp CRC-32 & luồng giải nén có giới hạn, trình lưu `.ssb`, IndexedDB recovery, Canvas renderer và giao diện người dùng) được viết 100% bằng HTML/CSS/JavaScript thuần, không có dependency bên thứ ba, không CDN, không font từ xa.

## Môi trường build & kiểm thử (chỉ dùng khi phát triển/nghiệm thu, người dùng cuối không cần cài)

- **Node.js** (MIT License) — chạy script bundle `scripts/build.mjs` và unit test `node:test`.
- **Python 3** (PSF License), **Pillow** (MIT-CMU License), **Playwright for Python** (Apache-2.0 License) — dùng trong `tests/fixtures/` và `tests/e2e/` để tạo fixture tổng hợp và kiểm thử tự động trên Chrome & Edge.
