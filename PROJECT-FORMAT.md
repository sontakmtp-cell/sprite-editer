# Định dạng Project `.ssb`, Metadata Atlas & Preset — V2.0

Tài liệu này mô tả đầy đủ kiến trúc file lưu trữ và xuất của **Sprite Sheet Builder V2.0**, tương ứng với 3 JSON Schema chính thức nằm trong thư mục `schemas/`:

- [project-v2.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/project-v2.schema.json)
- [atlas-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/atlas-v1.schema.json)
- [preset-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/preset-v1.schema.json)

---

## 1. Archive Project `.ssb` (Schema Version 2)

File `.ssb` là một archive **PKZIP 2.0** độc lập, không chứa đường dẫn tuyệt đối trên máy người dùng, có thể chép sang máy khác và mở trực tiếp bằng `dist/sprite-sheet-builder.html`.

### 1.1. Cấu trúc bên trong ZIP

```text
<project>.ssb
├── manifest.json          # JSON UTF-8, nén DEFLATE hoặc STORE, tối đa 8 MiB
└── sources/
    ├── <sourceId>.png     # Dữ liệu nhị phân gốc nguyên bản (STORE)
    ├── <sourceId>.webp    # Dữ liệu nhị phân gốc nguyên bản (STORE)
    └── <sourceId>.jpg     # Dữ liệu nhị phân gốc nguyên bản (STORE)
```

Quy tắc bảo mật và toàn vẹn khi đọc `.ssb`:

1. Chỉ cho phép đúng `manifest.json` và các entry khớp `^sources/[A-Za-z0-9_-]+\.(png|webp|jpg|jpeg)$`. Mọi entry thừa, path tuyệt đối (`/`, `C:\`), path traversal (`..`, `.`), backslash (`\`), symlink Unix, file mã hóa, tên trùng lặp (không phân biệt hoa/thường), archive lồng nhau hoặc file thực thi đều bị từ chối.
2. Chỉ chấp nhận phương thức nén `0` (STORE) và `8` (DEFLATE). Khi giải nén DEFLATE, hệ thống dùng luồng đọc có chặn kích thước thực tế (`inflateRawBounded`) và kiểm tra CRC-32 từng entry để ngăn zip-bomb kể cả khi header khai báo sai.
3. Giới hạn archive: tối đa 512 MiB cho cả kích thước file nén và tổng kích thước giải nén; tối đa 8 MiB cho `manifest.json`; tối đa 20 MiB cho từng nguồn ảnh; tổng nguồn không quá 256 MiB và 256 Mi pixel.
4. Nếu bất kỳ bước kiểm tra nào (ZIP, schema, tham chiếu, chữ ký nhị phân nguồn, kích thước hoặc giải mã thực tế trên trình duyệt) thất bại, project đang mở hiện tại được **giữ nguyên hoàn toàn**, không mở partial project.

### 1.2. Các trường của `manifest.json`

- `format`: hằng số `"sprite-sheet-builder-project"`.
- `schemaVersion`: hằng số `2`. Phiên bản tương lai chưa được hỗ trợ sẽ bị từ chối có thông báo rõ ràng.
- `projectId`, `name`: định danh duy nhất và tên hiển thị của project.
- `grid`: `{ cols, rows, cellWidth, cellHeight }` (số nguyên dương, `cols/rows ≤ 64`, `cols*rows ≤ 1024`, atlas `≤ 8192 px` mỗi chiều và `≤ 33.554.432` pixel).
- `presetId`: `string | null` (ví dụ `"hatch-pet-v2"` hoặc `null` khi ở chế độ tùy chỉnh).
- `expectedCells` *(tùy chọn)*: `string[] | null` — danh sách tọa độ `"row:col"` (0-based) là ô dự kiến của preset; các ô còn lại là ô dư.
- `sources[]`: danh sách nguồn ảnh nhị phân duy nhất (`id`, `name`, `path`, `mime`, `width`, `height`, `byteLength`, tùy chọn `importedAt`, `exifOrientation`). Không bao giờ serialize trùng cùng một `sourceId`.
- `assets[]`: toàn ảnh hoặc vùng cắt (`id`, `sourceId`, `name`, tùy chọn `isRegion`, `region: { x, y, w, h }` nguyên nằm trong kích thước nguồn).
- `cells`: map `"row:col"` → cấu hình ô (chỉ chứa ô có ảnh):
  - `assetId`: trỏ tới một asset tồn tại.
  - `fitMode`: `"contain"` hoặc `"alpha"`.
  - `alphaThreshold`: số nguyên `0..254` (mặc định `8`).
  - `zoom`: số thực hữu hạn trong `[0.25, 10.0]`.
  - `offsetX`, `offsetY`: số thực hữu hạn (pixel đầu ra, không làm tròn trung gian).
  - `anchor`: `{ mode: "fit-center" | "alpha-bottom-center" | "custom", x?, y? }` (với `custom`, `x, y` là tọa độ pixel tương đối theo vùng `region` của asset, nằm trong `[0..w] × [0..h]`).
- `animations[]`: danh sách nhóm animation (`id`, `name`, `fps` `1..60`, `loopMode`: `"loop" | "once" | "pingpong"`, tùy chọn `guides: { x, y } | null` dạng chuẩn hóa `0..1`, tùy chọn `sizeVarianceThreshold: number | null`, `frames: [{ row, col, durationMs }]` với `durationMs: null` dùng FPS hoặc `10..10000` ms).
- `settings`: `{ smoothing, guides: { x, y }, defaultAlphaThreshold, webpQuality }`.
- `customPresets[]`: tối đa 64 preset tùy chỉnh tuân thủ `preset-v1.schema.json`.

### 1.3. Versioning & Migration

- V2.0 khởi tạo với `schemaVersion: 2`. Phiên bản MVP trước đây không có định dạng lưu project nên không có migration V1.
- Khi nâng `schemaVersion` trong tương lai, phải bổ sung hàm migration có unit test riêng, đọc bản gốc mà không tự ghi đè file gốc trên đĩa.

---

## 2. JSON Metadata Atlas (Schema Version 1)

Xuất kèm Atlas hoặc độc lập theo chuẩn [atlas-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/atlas-v1.schema.json):

- `format`: `"sprite-sheet-builder-atlas"`, `schemaVersion`: `1`.
- `image`: tên file atlas (ví dụ `"spritesheet_8x11_192x208.png"`) hoặc `null` khi xuất JSON độc lập.
- `atlas`: `{ width, height, cols, rows, cellWidth, cellHeight, origin: "top-left", indexBase: 0, guidesNormalized?: { x, y } }`.
  - **Đơn vị rõ ràng:** `guidesNormalized` dùng đơn vị chuẩn hóa `[0..1]` theo kích thước ô; tọa độ frame `x, y, w, h` dùng pixel nguyên trên atlas.
- `frames[]`: chứa đủ `cols × rows` slot kể cả ô trống (`empty: true`), `id: "r{row}c{col}"`, tùy chọn `anchorCellPx: { x, y } | null` tính theo **pixel trong khung ô** (không trộn đơn vị chuẩn hóa).
- `animations[]`: tên nhóm gốc (chưa sanitize), `fps`, `loopMode`, tùy chọn `guidesNormalized`, danh sách `frames: [{ frameId, durationMs }]` trong đó `durationMs` là thời lượng thực tế (`durationMs` riêng hoặc `1000 / fps` không làm tròn gây lệch tích lũy).

---

## 3. JSON Preset Tùy chỉnh (Schema Version 1)

File `.preset.json` độc lập (không kèm ảnh), kiểm tra bằng [preset-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/preset-v1.schema.json):

- `format`: `"sprite-sheet-builder-preset"`, `schemaVersion`: `1`.
- Lưu `id`, `name`, `description`, `grid`, `expectedCells`, `defaultFps`, `guides` (chuẩn hóa `0..1`), và `animations[]`.

---

## 4. Phục hồi sự cố cục bộ (IndexedDB Recovery)

- Lưu trong IndexedDB cục bộ của trình duyệt dưới tên cơ sở dữ liệu `sprite-sheet-builder-recovery-v2` gồm 2 object store:
  - `sources`: lưu từng nguồn ảnh theo `sourceId` dạng `Blob` (chỉ ghi nguồn mới, không lặp lại toàn bộ ảnh mỗi lần lưu).
  - `meta`: lưu bản ghi `latest_committed_snapshot` có đánh dấu `status: "committed"`, `revision`, `savedAt`, `tabId` và `project`.
- Bảo vệ đa tab bằng khóa heartbeat `ssb_v2_active_tab_lock` trong `localStorage` và `BroadcastChannel` (`ssb_v2_recovery_channel`).
- Dữ liệu hoàn toàn ở máy cục bộ, không gửi ra mạng. Người dùng có thể tắt hoặc xóa hoàn toàn trong **Cài đặt → Xóa dữ liệu recovery** (không ảnh hưởng các file `.ssb` đã tải xuống).
