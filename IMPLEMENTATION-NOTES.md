# Ghi chú triển khai (Implementation Notes) — Sprite Sheet Builder V2.0

Tài liệu này ghi lại các quyết định kỹ thuật, cơ chế bảo vệ dữ liệu, đánh đổi thiết kế và giới hạn môi trường trong quá trình xây dựng bản phát hành hoàn chỉnh V2.0 theo `Docs/SPRITE-SHEET-BUILDER-PRODUCT-SPEC-V2.0.md`.

---

## 1. Kiến trúc phát hành & Đóng gói đơn file (`file://`)

- **Bundler nội bộ zero-dependency (`scripts/build.mjs`):** Các module ES trong `src/` (`src/core/`, `src/engine/`, `src/io/`, `src/ui/`) giữ nguyên chuẩn ES Module để Node.js chạy unit test trực tiếp (`node --test`). Khi build, `scripts/build.mjs` gom toàn bộ module vào một registry IIFE cô lập và nhúng cùng CSS vào `dist/sprite-sheet-builder.html` (không dùng `<script type="module">` để tránh lỗi CORS của `file://` trên Chrome/Edge).
- **Dung lượng bản phát hành:** `dist/sprite-sheet-builder.html` ~542 KiB (< 0,53 MiB, thấp hơn nhiều ngưỡng mục tiêu 1 MiB), 22 module, không nhúng ảnh mẫu, không phụ thuộc CDN, không font từ xa, không telemetry.
- **Không dùng thư viện bên thứ ba ở runtime:** Toàn bộ engine ZIP, kiểm tra chữ ký ảnh, phân tích alpha, tính hình học và giao diện viết thuần JS/HTML/CSS để kiểm soát tuyệt đối kích thước, giấy phép và bảo mật.

---

## 2. Những quyết định kỹ thuật trọng yếu

### 2.1. Chống rò pixel (Bleed Prevention) khi tách atlas/strip (Spec §7, T04)
- Khi dùng `ctx.drawImage(sourceBitmap, rx, ry, rw, rh, dx, dy, dw, dh)` với `imageSmoothingEnabled = true`, bộ lọc bilinear của Skia (Chrome/Edge) có thể lấy mẫu pixel của frame kế bên khi vẽ vùng cắt có màu tương phản sát nhau.
- **Giải pháp:** `AssetManager.getAssetDrawable()` phát hiện mọi asset là vùng cắt (`rx, ry, rw, rh !== toàn nguồn`) và trích một `ImageBitmap` cắt 1:1 riêng biệt (`createImageBitmap(srcBmp, x, y, w, h)`) vào bộ nhớ đệm LRU (có tính vào ngân sách 64 Mi pixel). Renderer chỉ vẽ từ `(0, 0, rw, rh)` của bitmap đã cắt, triệt tiêu hoàn toàn hiện tượng bleed sang frame liền kề mà không resample hay sửa ảnh gốc.

### 2.2. Ngân sách bộ nhớ đệm LRU 64 Mi pixel (Spec §12.1, T22)
- Project cho phép tối đa 256 Mi pixel nguồn nén (ví dụ 73 ảnh 1024×1024 = 73 Mi pixel), nhưng bộ nhớ đệm bitmap giải mã được giới hạn cứng ở **64 Mi pixel (~256 MiB RGBA)** bao gồm bitmap nguồn, bitmap vùng cắt và thumbnail.
- Khi vượt ngân sách, `AssetManager` tự động thu hồi mục ít dùng nhất (LRU) và gọi `ImageBitmap.close()` ngay lập tức để giải phóng GPU/RAM. Các ảnh nén gốc vẫn giữ dưới dạng `Uint8Array` (không giữ base64 trong RAM), giải mã lại theo nhu cầu khi chỉnh sửa hoặc xuất mà không giảm chất lượng ngầm.
- **Lưu ý giới hạn trình duyệt:** Con số 64 Mi pixel đo phần bitmap do ứng dụng quản lý trực tiếp; không bao gồm bộ nhớ nội bộ của trình duyệt (Skia tile cache, compositor layer, JS heap tạm khi mã hóa PNG/WebP).

### 2.3. Kiểm tra định dạng ảnh nhị phân & EXIF Orientation (Spec §5.1, T06, T26)
- `src/core/image-inspect.js` kiểm tra chữ ký file thực tế trước giải mã:
  - **PNG:** kiểm tra magic bytes + `IHDR`, quét chunk tìm `acTL` để từ chối APNG.
  - **WebP:** kiểm tra `RIFF....WEBP`, phân tích `VP8`/`VP8L`/`VP8X` và từ chối cờ animation (`0x02`) hoặc chunk `ANIM`/`ANMF`.
  - **JPEG:** kiểm tra `FF D8`, phân tích `SOF` và thẻ `APP1` EXIF Orientation (`0x0112`, giá trị 1–8) để suy ra kích thước hiển thị đã xoay trục (hoán đổi W/H với orientation 5–8), đồng thời giải mã bằng `createImageBitmap(blob, { imageOrientation: 'from-image' })` và đối chiếu kích thước thực tế sau giải mã.
- Từ chối hoàn toàn SVG, GIF, HTML/text giả đuôi ảnh, file hỏng và ảnh vượt giới hạn `8192 px` hoặc `16 Mi pixel`.

### 2.4. ZIP `.ssb` & Phòng thủ archive không tin cậy (Spec §10.2, §12.3, T16, T17)
- `src/io/zip.js` cài đặt PKZIP 2.0 với CRC-32 IEEE 802.3, hỗ trợ STORE (0) và DEFLATE (8 qua `CompressionStream`/`DecompressionStream('deflate-raw')`).
- **Chống zip-bomb thực sự:** Hàm `inflateRawBounded` đọc luồng giải nén theo từng chunk và đếm số byte giải nén thực tế **trong lúc giải nén**; nếu vượt giới hạn entry hoặc tổng archive (512 MiB; manifest 8 MiB), hủy ngay `reader.cancel()` và `writer.abort()` mà không tin tưởng kích thước khai báo trên header.
- Khi lưu `.ssb` và gói ZIP xuất, ảnh nhị phân (PNG/WebP/JPG đã nén sẵn) được lưu ở chế độ STORE để giữ nguyên byte gốc, tăng tốc lưu/mở và giảm CPU; `manifest.json` và metadata JSON được nén DEFLATE.

### 2.5. Phục hồi sự cố (Crash Recovery) & Đa tab (Spec §10.3, T18)
- Khởi động ứng dụng thực hiện một phép ghi/đọc/xóa kiểm chứng thực tế trên IndexedDB (`sprite-sheet-builder-recovery-v2`). Nếu trình duyệt chặn IndexedDB trên `file://` hoặc đầy quota, giao diện báo rõ *"Phục hồi tự động không khả dụng — hãy lưu project"*.
- Snapshot chỉ có hiệu lực khi bản ghi `latest_committed_snapshot` ghi `status: 'committed'` thành công sau khi mọi nguồn mới đã ghi xong; lỗi giữa chừng không phá hỏng snapshot hợp lệ trước đó.
- Bảo vệ đa tab kết hợp heartbeat `localStorage` (`ssb_v2_active_tab_lock`) và `BroadcastChannel` (`ssb_v2_recovery_channel`) để phát hiện tab khác và tạm dừng ghi đè recovery.

### 2.6. Lưu file trung thực & Trạng thái chưa lưu (Spec §10.2, T27)
- Đường lưu chính là tải xuống qua Blob URL (`<a download>`), hoạt động tin cậy trên `file://` mà không yêu cầu HTTPS hay cấp quyền hệ thống. Sau khi khởi tạo download, thông báo ghi đúng *"Đã tạo file lưu / đã yêu cầu tải xuống, hãy kiểm tra thư mục tải xuống"* và nhãn chuyển sang *"Đã tạo bản lưu ở rev N"* (không khẳng định đã ghi vật lý thành công trên đĩa).
- Xuất ảnh PNG/WebP/Strip/ZIP tuyệt đối không làm mất trạng thái `Chưa lưu` của project.

### 2.7. Xử lý xung đột bất đồng bộ & Lỗi DOM đã phát hiện khi kiểm thử
- **Lỗi phát hiện ở T21 (Race condition khi giải mã ảnh lúc đổi project):** Ở bản build đầu, `handleIncomingFiles` lấy `startProjectId` sau `await ensureDraftResolved()`, khiến một thao tác đổi project đồng bộ xen vào giữa có thể lọt qua bước kiểm tra. Đã sửa bằng cách ghi nhận `startProjectId` và `startRevision` ngay đầu hàm trước mọi `await`, đồng thời kiểm tra lại sau mỗi bước async.
- **Lỗi phát hiện ở Slice modal (`removeChild` khi re-render trên `blur`/`change`):** `clearEl` dùng vòng lặp `removeChild` gặp re-entrancy khi hủy input đang focus. Đã sửa bằng `node.replaceChildren()`, triệt tiêu toàn bộ page error xuống `0`.

### 2.8. Mặt nạ tẩy/khôi phục theo từng ô (Per-Cell Vector Mask — Schema V3)
- **Kiểm chứng chống tràn viền trước khi code:** Trước khi triển khai cọ tẩy, đã kiểm chứng dải 12 frame có màu tương phản đặt sát nhau (`0 gap`) trên bản build nền tại zoom lẻ (`1,37×`) có bật làm mịn: cả preview Editor lẫn PNG xuất đều ghi nhận **0 pixel tràn viền** từ frame liền kề (vì `AssetManager.getAssetDrawable()` tách riêng từng vùng cắt sang `ImageBitmap` độc lập). Cục tẩy chỉ dùng để xóa phần hình dính nằm thực sự trong vùng nguồn đã tách, không phải bản vá lỗi lấy mẫu.
- **Mô hình vector nhỏ gọn (`src/core/mask.js`):** Mỗi ô lưu `cell.mask = { strokes: [{ op: 'erase'|'restore', radius, points: [[x,y], ...] }] }` trong tọa độ pixel của **ảnh nguồn đã xoay đúng EXIF** (làm tròn 2 chữ số thập phân, đơn giản hóa polyline Ramer-Douglas-Peucker sai số dưới pixel cho nét dài >32 điểm). Khi không có nét tẩy, `cell.mask` bị lược bỏ hoàn toàn để giữ nguyên đường render nhanh không mask và xuất `.ssb` chuẩn `schemaVersion: 2`.
- **Dựng mặt nạ trước scale/lọc pixel:** `rasterizeMaskAlpha` phát sinh mặt nạ alpha nhị phân (`0` hoặc `255`) bằng hình học đường tròn/capsule cọ cứng (hỗ trợ điểm đơn 1 click, cọ 1 px `radius=0.5`, kéo nhanh không ngắt quãng), sau đó `AssetManager._composeMaskedRegionCanvas` áp lên canvas vùng cắt độc lập bằng `globalCompositeOperation = 'destination-in'` trước khi scale, làm mịn hay clip ô đích. Cách này bảo toàn nguyên vẹn alpha gốc (`0 / 128 / 255`) khi Khôi phục mà không cộng alpha hay sơn đục nền trong suốt.
- **Cache & Ngân sách LRU:** Cache bitmap mặt nạ (`maskreg:<sourceId>:<rx>,<ry>,<rw>,<rh>:<maskSig>`) dùng chung bộ nhớ đệm LRU `64 Mi pixel` và chỉ lưu canvas cỡ vùng cắt (không lưu canvas nguồn đầy đủ cho mọi ô). Cache phân tích pixel (`pixelAnalysisCache`) cũng khóa theo `source + crop + maskSig + alphaThreshold` và giới hạn tối đa 2048 mục. Khi đang kéo nét trong Editor, hình học quy đổi chuột được khóa cố định trên `pointerdown`, vẽ trực tiếp vào cặp buffer nháp cỡ crop; khi nhả chuột mới cập nhật lại `alphaBounds` (cho Fit Alpha / anchor theo alpha) trước khi bấm **Áp dụng**.
- **Xử lý ô tẩy sạch & Preflight:** Khi ô có mask bị tẩy hết phần nhìn thấy (`allTransparent === true`), `EditorView`, `preflight.js` và `export-engine.js` phát cảnh báo `MASK_ALL_TRANSPARENT` và xuất ô trong suốt (`alpha = 0`), không để `Fit Alpha` chặn xuất cả atlas; trong Editor tự fallback hình học con trỏ sang `contain` để người dùng vẫn Khôi phục lại pixel hoặc bấm **Bỏ toàn bộ vết tẩy** được.
- **Tương thích Schema V2/V3:** `validateProjectManifest` giữ chặt schema V2 (từ chối `mask` dưới V2) và mở rộng schema V3 (`schemas/project-v3.schema.json`) với đầy đủ kiểm tra kiểu, hữu hạn, bán kính, phạm vi nguồn và tổng giới hạn nét/điểm/dung lượng (`≤ 2 MiB`).

---

## 3. Các giới hạn và điểm cần lưu ý

1. **Preset Hatch Pet V2:** Là cấu hình hình học chuẩn hóa từ đặc tả sản phẩm V2.0 (`8×11`, `192×208 px`, 73 ô dự kiến + 15 ô dư), không phải tuyên bố tương thích chính thức với một runtime cụ thể của bên thứ ba.
2. **Định dạng WebP:** Phụ thuộc encoder của Chrome/Edge; ứng dụng luôn kiểm tra chữ ký `RIFF....WEBP` và từ chối nếu trình duyệt fallback về PNG.
3. **Thao tác thủ công của hệ điều hành (Explorer double-click / drag-drop từ Explorer):** Đã kiểm thử tự động trên Windows 11 với trình duyệt Chrome 158 và Edge 158 thật qua `file://`, nhưng thao tác nhấp đúp vật lý trong Windows Explorer và kéo thả file thật từ cửa sổ Explorer cần người dùng xác nhận thủ công thêm (xem mục Manual Test trong `ACCEPTANCE-REPORT.md`).
