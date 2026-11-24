# Định dạng Project `.ssb`, Metadata Atlas & Preset — V2.0

Tài liệu này mô tả đầy đủ kiến trúc file lưu trữ và xuất của **Sprite Sheet Builder**, tương ứng với 5 JSON Schema chính thức nằm trong thư mục `schemas/`:

- [project-v2.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/project-v2.schema.json)
- [project-v3.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/project-v3.schema.json)
- [atlas-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/atlas-v1.schema.json)
- [atlas-v2.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/atlas-v2.schema.json)
- [preset-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/preset-v1.schema.json)

---

## 1. Archive Project `.ssb` (Schema Version 2 & Version 3)

File `.ssb` là một archive **PKZIP 2.0** độc lập, không chứa đường dẫn tuyệt đối trên máy người dùng, có thể chép sang máy khác và mở trực tiếp bằng `dist/sprite-sheet-builder.html`.

### 1.1. Cấu trúc bên trong ZIP

```text
<project>.ssb
├── manifest.json          # JSON UTF-8 dạng compact (không thụt dòng), nén DEFLATE/STORE, tối đa 8 MiB
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
- `schemaVersion`: `2` (project không có vết tẩy/mask) hoặc `3` (project có ít nhất một ô chứa `mask`). Phiên bản khác (ví dụ `1`, `4`, `99`) bị từ chối có thông báo rõ ràng.
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
  - `mask` *(chỉ cho phép ở `schemaVersion: 3`, tùy chọn)*: `{ strokes: [{ op: "erase" | "restore", radius, points: [[x, y], ...] }] }`.
    - Tọa độ `[x, y]` lưu trong **hệ tọa độ pixel của ảnh nguồn đã xoay đúng EXIF**, cho phép tâm cọ nằm ngoài biên ảnh nguồn trong phạm vi `[-radius, source.width + radius] × [-radius, source.height + radius]` (tối thiểu `-64` px) để thao tác sát mép không kéo tâm cọ vào trong; phần hình tròn cọ nằm ngoài vùng crop chỉ bị clip khi rasterize. Với cọ `1 px` (`radius = 0.5`), tọa độ chốt đúng tâm pixel nguồn `[Math.floor(x) + 0.5, Math.floor(y) + 0.5]` để không nhảy pixel khi mở rộng crop.
    - `radius`: bán kính cọ tròn cứng (`0.5 .. 64` px nguồn, tương ứng cỡ cọ `1 .. 128` px).
    - Giới hạn: tối đa `1024` điểm/nét, `512` nét/ô, `16.384` điểm/ô, tổng `8.192` nét và `131.072` điểm trên toàn project, tổng JSON mặt nạ `≤ 2 MiB`, và tổng `manifest.json` compact `≤ 8 MiB`. Mọi giới hạn được kiểm tra trên **toàn bộ trạng thái sau thao tác** trước khi commit (kể cả Dán nhiều ô, Nhân bản, Ctrl-kéo sao chép). Không nhúng bitmap base64 vào manifest.
- `animations[]`: danh sách nhóm animation (`id`, `name`, `fps` `1..60`, `loopMode`: `"loop" | "once" | "pingpong"`, tùy chọn `guides: { x, y } | null` dạng chuẩn hóa `0..1`, tùy chọn `sizeVarianceThreshold: number | null`, `frames: [{ row, col, durationMs }]` với `durationMs: null` dùng FPS hoặc `10..10000` ms).
- `settings`: `{ smoothing, guides: { x, y }, defaultAlphaThreshold, webpQuality }`.
- `customPresets[]`: tối đa 64 preset tùy chỉnh tuân thủ `preset-v1.schema.json`.

### 1.3. Versioning & Tương thích V2 / V3

- **Đọc V2 cũ:** Bản mới đọc trực tiếp mọi file `.ssb` `schemaVersion: 2` (các ô được hiểu là chưa có vết tẩy). Schema V2 vẫn giữ nguyên quy tắc nghiêm ngặt (`additionalProperties: false`) và **từ chối** file gắn nhãn V2 nhưng chứa trường lạ `mask`.
- **Xuất thông minh V2/V3:**
  - Project **không có ô nào chứa vết tẩy** tiếp tục được lưu dưới `schemaVersion: 2` (mở được bình thường trên bản V2.0 cũ).
  - Project **có ít nhất một ô chứa vết tẩy** được lưu dưới `schemaVersion: 3` kèm `cells[key].mask`. Ứng dụng không bao giờ ghi `mask` dưới nhãn V2 và không bao giờ hạ cấp về V2 bằng cách âm thầm bỏ nét tẩy.
- **Giới hạn tương thích ngược:** File `.ssb` `schemaVersion: 3` (có chứa vết tẩy) **không mở được** trên bản phát hành V2.0 cũ hơn; nếu cần mở trên bản V2.0 cũ, hãy dùng **Bỏ toàn bộ vết tẩy** trên các ô có mask rồi lưu lại (sẽ tự xuất `schemaVersion: 2`).
- **Recovery IndexedDB:** Lưu theo cùng chuẩn `schemaVersion: 2` / `3` đã áp dụng; không lưu nét vẽ dở trong bản nháp.

---

## 2. JSON Metadata Atlas (Schema Version 1 & Version 2)

### 2.1. Schema Version 1 (Mặc định — Tương thích tuyệt đối)

Xuất mặc định kèm Atlas hoặc độc lập theo chuẩn gốc [atlas-v1.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/atlas-v1.schema.json) (`additionalProperties: false` nghiêm ngặt):

- `format`: `"sprite-sheet-builder-atlas"`, `schemaVersion`: `1`.
- `image`: tên file atlas (ví dụ `"spritesheet_8x11_192x208.png"`) hoặc `null` khi xuất JSON độc lập.
- `atlas`: `{ width, height, cols, rows, cellWidth, cellHeight, origin: "top-left", indexBase: 0, guidesNormalized?: { x, y } }`.
  - **Đơn vị rõ ràng:** `guidesNormalized` dùng đơn vị chuẩn hóa `[0..1]` theo kích thước ô; tọa độ frame `x, y, w, h` dùng pixel nguyên trên atlas.
- `frames[]`: chứa đủ `cols × rows` slot kể cả ô trống (`empty: true`), `id: "r{row}c{col}"`, tùy chọn `anchorCellPx: { x, y } | null` tính theo **pixel trong khung ô** trên dữ liệu **sau khi áp dụng mặt nạ tẩy** (không thêm trường lạ ngoài V1).
- `animations[]`: tên nhóm gốc (chưa sanitize), `fps`, `loopMode`, tùy chọn `guidesNormalized`, danh sách `frames: [{ frameId, durationMs }]` trong đó `durationMs` là thời lượng thực tế (`durationMs` riêng hoặc `1000 / fps` không làm tròn gây lệch tích lũy).

### 2.2. Schema Version 2 (Tùy chọn xuất kèm `contentBoundsCellPx`)

Khi người dùng bật tùy chọn **Xuất kèm `contentBoundsCellPx` thực tế sau clip/tẩy (Atlas Metadata V2)** trong hộp thoại Xuất, ứng dụng xuất theo chuẩn [atlas-v2.schema.json](file:///h:/AI/pet/sprite-sheet-builder/schemas/atlas-v2.schema.json):

- `schemaVersion`: `2` (mọi trường khác giữ nguyên cấu trúc như V1).
- `frames[].contentBoundsCellPx`: `{ x, y, w, h } | null` (số nguyên trong `[0..cellWidth] × [0..cellHeight]`) được tính trực tiếp từ **buffer pixel xuất thực tế sau khi render, áp mặt nạ tẩy và clip đúng vào khung ô `cellWidth × cellHeight`**. Nếu ảnh bị đẩy ra ngoài khung ô hoặc bị tẩy hết phần nhìn thấy, giá trị là `null`.

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
