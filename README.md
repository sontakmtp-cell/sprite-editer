# Sprite Sheet Builder V2.0

Ứng dụng web chạy **hoàn toàn offline** (một file HTML duy nhất), dành cho nhà làm game trên Windows 11 (Chrome / Edge desktop) để biến ảnh nhân vật rời, animation strip hoặc sprite atlas có sẵn thành **sprite sheet dạng lưới đều**, căn chỉnh hình học chính xác, xem thử animation, lưu project `.ssb` để chỉnh tiếp và xuất tài nguyên.

---

## 1. Cách mở và sử dụng ngay (Không cần cài đặt hay Node.js)

1. Mở thư mục `dist/` bằng Windows Explorer.
2. Nhấp đúp vào file **`sprite-sheet-builder.html`** (mở trực tiếp bằng Chrome hoặc Microsoft Edge qua `file://`).
3. Không cần server, không cần kết nối mạng, không cần quyền quản trị, không tải font hay thư viện từ CDN. Mọi ảnh và dữ liệu đều xử lý 100% cục bộ trên máy.

---

## 2. Quy trình chuẩn 73 frame với Preset Hatch Pet V2

1. Trên thanh công cụ trên cùng, bấm **Preset** → chọn **Hatch Pet V2** → bấm **Áp dụng**.
   - Lưới tự thiết lập: **8 cột × 11 hàng**, mỗi ô **192 × 208 px**, atlas đầu ra **1536 × 2288 px** (88 ô gồm 73 ô dự kiến và 15 ô dư được đánh dấu mờ `dư`, không khóa).
   - 11 nhóm animation được khởi tạo sẵn: `idle (6)`, `running-right (8)`, `running-left (8)`, `waving (4)`, `jumping (5)`, `failed (8)`, `waiting (6)`, `running (6)`, `review (6)`, `look directions A (8, mặc định once)`, `look directions B (8, mặc định once)`.
2. Bấm **+ Nhập ảnh** ở Thư viện ảnh (hoặc kéo thả trực tiếp 73 ảnh từ Explorer vào lưới Sprite Atlas).
3. Trong hộp thoại **Xem trước Nhập hàng loạt (Batch Import)**:
   - Chọn chế độ **Các ô dự kiến còn trống của Preset** (tự bỏ qua 15 ô dư).
   - Chọn thứ tự sắp xếp (mặc định **Tên tự nhiên**: `frame2.png` trước `frame10.png`) hoặc đảo ngược / sắp tay bằng nút `↑` `↓`.
   - Kiểm tra bảng ánh xạ ảnh → ô rồi bấm **Áp dụng** (1 bước Undo).
4. Căn chỉnh từng frame hoặc dùng **Đồng bộ... (Transform Sync)** để đồng bộ kích thước/anchor cho cả hàng/nhóm.
5. Kiểm tra lỗi bằng nút **Kiểm tra (Preflight)**, lưu project bằng **Lưu (`Ctrl+S`)** ra file `.ssb`, rồi bấm **Xuất...** để xuất `spritesheet_8x11_192x208.png` (hoặc WebP, Strip, Frame riêng, gói ZIP, JSON metadata).

---

## 3. Hướng dẫn từng nhóm tính năng

### 3.1. Nhập hàng loạt (Batch Import & Fill)
- Hỗ trợ ảnh tĩnh **PNG, WebP, JPG/JPEG** (từ chối APNG, WebP động, GIF, SVG, file hỏng bằng kiểm tra header nhị phân).
- **Nhập vào Thư viện (`+ Nhập ảnh` hoặc thả vào panel trái):** đưa ảnh vào thư viện mà không tự điền lên atlas. Có thể tìm kiếm, lọc `Chưa dùng`/`Đã dùng`, sắp xếp, chọn nhiều ảnh rồi bấm **Điền lưới** hoặc kéo thả vào ô đích.
- **Chính sách an toàn:** Mặc định bỏ qua ô đã có ảnh (chọn ghi đè phải tick xác nhận); không tràn ngoài phạm vi chọn; nếu có file lỗi trong batch, nút Áp dụng bị khóa cho tới khi người dùng chủ động bấm **Chỉ nhập ảnh hợp lệ**.

### 3.2. Tách Atlas / Animation Strip (Slice Engine)
- Bấm **Tách atlas** ở Thư viện ảnh → chọn ảnh có sẵn hoặc tải file mới.
- Chọn **Theo số cột & hàng** (diện tích hữu dụng sau margin/gap phải chia hết thành kích thước nguyên) hoặc **Theo kích thước frame (W × H)** (hiển thị phần dư và yêu cầu xác nhận trước khi bỏ qua).
- Thiết lập Margin trái/phải/trên/dưới, Gap ngang/dọc, click trực tiếp trên preview để bật/tắt từng ô, bật **Bỏ qua vùng hoàn toàn trong suốt (`alpha = 0`)**, chọn **Giữ khoảng trống slot** hoặc dồn frame.
- Kết quả tạo asset vùng cắt dùng chung 1 file ảnh nhị phân duy nhất (không resample) và chống rò pixel (bleed) sang frame liền kề khi render.
- Bấm nút **Vùng** trên từng asset trong thư viện để chỉnh tọa độ vùng cắt nguyên thủ công hoặc tạo asset mới.

### 3.3. Căn chỉnh Frame, Fit Alpha, Đường gióng, Anchor & Onion Skin
- Chọn ô trên lưới → chỉnh trên panel **Chỉnh sửa frame** bên phải. Mọi thay đổi nằm ở **bản nháp (draft)** cho tới khi bấm **Áp dụng** (hoặc **Hoàn nháp** / **Hủy**). Chuyển ô, Undo, lưu hoặc xuất khi có bản nháp chưa áp dụng sẽ luôn hiện hộp thoại chọn *Áp dụng / Hủy bản nháp / Tiếp tục sửa*.
- **Fit Mode:** `Contain` (mặc định, giữ tỷ lệ, không kéo giãn) hoặc `Vừa vùng nội dung (Fit Alpha)` theo ngưỡng alpha `0–254` (mặc định `8`, không xóa pixel alpha thấp).
- **Anchor & Đường gióng:** Baseline mặc định ở 90% chiều cao ô và trục dọc 50% (chỉnh được ở **Cài đặt** và override theo từng nhóm animation). Chọn anchor `Tâm vùng fit`, `Đáy giữa vùng alpha` hoặc bấm **Đặt điểm anchor** để click chọn điểm tùy chỉnh trên nhân vật, sau đó bấm **Căn gióng X+Y / Chỉ căn X / Chỉ căn Y / Căn đích**.
- **Tham chiếu & Onion Skin:** Ghim một ô bất kỳ (hoặc bấm `← Trước` / `Sau →` trong nhóm) làm frame tham chiếu, bật **Onion Skin** (độ mờ 10–90%) hoặc bấm **Cạnh nhau** để so sánh trực tiếp. Overlay không bao giờ bị xuất vào ảnh.
- **Đồng bộ căn chỉnh (`Đồng bộ...`):** 4 chế độ tách biệt — *(1) Sao chép transform*, *(2) Đồng bộ tỷ lệ hiển thị theo chiều cao/rộng alpha*, *(3) Đồng bộ vị trí anchor*, và *(2+3) Kết hợp*. Không tự clamp nếu zoom vượt `25–1000%`; báo rõ ô lỗi và yêu cầu xác nhận nếu muốn bỏ qua.

### 3.4. Xem thử Animation & Timeline
- Tạo nhóm mới, tạo nhanh **Từ hàng** hoặc **Từ vùng chọn**, nhân bản, đổi tên, override đường gióng và ngưỡng cảnh báo chênh lệch kích thước (mặc định 20% so với trung vị nhóm).
- Kéo thả các thumbnail trên timeline để đổi thứ tự phát (không làm di chuyển nội dung trên lưới atlas). Nhập `durationMs` riêng (`10–10000 ms`) cho từng slot hoặc để trống để dùng FPS (`1–60`, mặc định `8`).
- Chế độ phát `Loop`, `Once`, `Ping-pong` (không lặp hai đầu liên tiếp). Ô trống giữ đúng slot và hiện cảnh báo. Tự động tạm dừng khi ẩn tab trình duyệt, không chạy bù khi quay lại.

### 3.5. Lưu / Mở Project `.ssb` & Phục hồi sự cố
- **Lưu (`Ctrl+S`) / Lưu bản sao:** Xuất file `.ssb` (archive ZIP chứa `manifest.json` và toàn bộ ảnh gốc nguyên bản kể cả ảnh chưa đặt lên atlas). Lưu bản sao không làm đổi tên project.
- **Mở (`Ctrl+O`):** Kiểm tra toàn vẹn ZIP, schema, đường dẫn và giải mã ảnh trước khi thay project hiện tại; file lỗi sẽ bị từ chối và giữ nguyên phiên làm việc.
- **Phục hồi tự động (IndexedDB):** Tự kiểm tra khả dụng ngay khi mở `file://`, tự lưu snapshot khi rảnh (~30 giây), bảo vệ xung đột đa tab. Có thể bật/tắt, lưu ngay hoặc **Xóa dữ liệu recovery** trong **Cài đặt** (không ảnh hưởng các file `.ssb` đã tải). *Lưu ý: Recovery chỉ là lớp bảo vệ phụ, luôn lưu file `.ssb` cho công việc quan trọng.*

### 3.6. Xuất tài nguyên & Preflight
- Bấm **Xuất...** để chọn: **Sprite Atlas** (PNG/WebP), **Animation Strip** (ngang/dọc), **Frame riêng** (theo lưới `r001_c001` hoặc theo nhóm `<nhóm>_f001`), **Gói tài nguyên ZIP** (Atlas + JSON Metadata + Strip + Frame), hoặc **JSON Metadata độc lập**.
- Hệ thống luôn chạy **Preflight** trước khi xuất: lỗi nghiêm trọng sẽ chặn xuất; cảnh báo (thiếu ô dự kiến preset, ảnh ở ô dư, cắt alpha, chênh lệch kích thước...) cho phép nhảy thẳng tới ô (**Đi tới ô**) hoặc xác nhận xuất nguyên trạng.

---

## 4. Phím tắt (Hotkeys)

| Phím tắt | Chức năng |
|---|---|
| `Ctrl + S` | Lưu project `.ssb` (không mở hộp lưu trang HTML của trình duyệt) |
| `Ctrl + Shift + S` | Lưu bản sao `.ssb` |
| `Ctrl + O` | Mở project `.ssb` |
| `Ctrl + Z` | Hoàn tác (Undo) |
| `Ctrl + Y` / `Ctrl + Shift + Z` | Làm lại (Redo) |
| `Ctrl + C` / `Ctrl + V` | Sao chép / Dán ô (clipboard nội bộ, giữ hình dạng vùng chọn nhiều ô) |
| `Delete` / `Backspace` | Xóa nội dung các ô đang chọn |
| `Phím mũi tên` | Dịch chuyển nhân vật `1 px` trong Frame Editor (hoặc điều hướng ô khi lưới đang focus) |
| `Shift + Phím mũi tên` | Dịch chuyển nhân vật `10 px` trong Frame Editor |
| `Space + Kéo chuột` | Pan vùng hiển thị lưới Sprite Atlas |
| `Ctrl + Cuộn chuột` | Zoom vùng hiển thị lưới Sprite Atlas (`25–400%`) |
| `Ctrl + Click` / `Shift + Click` | Chọn thêm/bỏ chọn ô / Chọn vùng chữ nhật |
| `Escape` | Đóng menu ngữ cảnh / thoát chế độ chọn điểm anchor |

*(Phím tắt tự động không can thiệp khi con trỏ đang nhập liệu trong ô text/số/textarea.)*

---

## 5. Giới hạn vận hành V2.0

- **Lưới:** tối đa `64` cột, `64` hàng, tổng `≤ 1024` ô.
- **Atlas / Strip:** tối đa `8192 px` mỗi chiều và `≤ 32 Mi pixel` (`33.554.432` px). Ngưỡng xuất an toàn mặc định `≤ 4096 px` và `≤ 16 Mi pixel` (vượt ngưỡng cần xác nhận *Chế độ xuất lớn*).
- **Ảnh nguồn:** tối đa `20 MiB/file`, `≤ 8192 px` mỗi chiều, `≤ 16 Mi pixel`; tổng toàn project `≤ 256 MiB`, `≤ 256 Mi pixel`, `≤ 2048` nguồn, `≤ 4096` asset.
- **Animation:** tối đa `256` nhóm, tổng `≤ 16.384` slot.
- **Cache bitmap giải mã:** tối đa `64 Mi pixel` (~256 MiB RGBA) thu hồi tự động theo LRU (`ImageBitmap.close()`).
- **Archive `.ssb` / ZIP xuất:** tối đa `512 MiB` nén & giải nén; `manifest.json` tối đa `8 MiB`.

---

## 6. Build & Chạy kiểm thử (Dành cho lập trình viên)

Yêu cầu môi trường phát triển: **Node.js ≥ 20** (build & unit test), **Python 3 + Pillow + Playwright** (sinh fixture & E2E/benchmark trên Chrome và Edge).

```bash
# 1. Build file HTML offline duy nhất -> dist/sprite-sheet-builder.html
npm run build

# 2. Chạy toàn bộ Unit Tests (Node native test runner)
npm run test:unit

# 3. Tạo bộ fixture tổng hợp độc lập trong tests/fixtures/generated/
npm run test:fixtures

# 4. Chạy bộ kiểm thử E2E + đọc pixel trên Chrome & Edge thực tế (T01–T27)
npm run test:e2e

# 5. Chạy đo hiệu năng thực tế (T28, >= 3 lần mỗi kịch bản trên Chrome & Edge)
npm run test:perf
```

---

## 7. Xử lý sự cố thường gặp

- **"Trình duyệt không hỗ trợ mã hóa WebP / fallback sang PNG":** Chọn định dạng **PNG** khi xuất; ứng dụng từ chối đổi đuôi giả khi trình duyệt không mã hóa được WebP thực.
- **"Phục hồi tự động không khả dụng — hãy lưu project":** Trình duyệt đang ở chế độ riêng tư, chặn IndexedDB trên `file://`, hoặc đầy bộ nhớ lưu trữ cục bộ. Hãy bấm **Lưu (`Ctrl+S`)** thường xuyên ra file `.ssb`.
- **"Không thể áp dụng Fit Alpha":** Ảnh nguồn hoàn toàn trong suốt hoặc không có pixel nào có `alpha > alphaThreshold`. Giảm ngưỡng alpha hoặc giữ chế độ `Contain`.
- **"Strip vượt giới hạn canvas":** Nhóm animation quá dài khiến chiều rộng/cao strip vượt `8192 px` hoặc `32 Mi pixel`. Chuyển sang xuất **Frame riêng** theo nhóm (`<nhóm>_f001.png`).
- **Mở `.ssb` báo lỗi:** File bị hỏng CRC, thiếu nguồn, bị chỉnh sửa sai schema hoặc chứa đường dẫn không an toàn. Project đang mở hiện tại không bị ảnh hưởng.
