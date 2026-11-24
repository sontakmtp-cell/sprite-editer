# Báo cáo nghiệm thu (Acceptance Report) — Sprite Sheet Builder V2.0

**Ngày kiểm thử:** 2026-11-24  
**Bản build kiểm thử:** `dist/sprite-sheet-builder.html` (`571.757 bytes` / `558,4 KiB`, 22 module, 0 runtime dependency, mục tiêu `< 1 MiB`)

---

## 1. Môi trường kiểm thử thực tế

| Thành phần | Cấu hình thực tế |
|---|---|
| Hệ điều hành | Microsoft Windows 11 Pro `10.0.26100` (Build 26100) |
| CPU | 12th Gen Intel(R) Core(TM) i3-12100F |
| RAM | 15,85 GB |
| GPU | NVIDIA GeForce GTX 1660 SUPER |
| Trình duyệt mục tiêu 1 | Google Chrome `158.0.8127.88` (chạy trực tiếp file `file://`, headless Playwright) |
| Trình duyệt mục tiêu 2 | Microsoft Edge `158.0.4370.33` (chạy trực tiếp file `file://`, headless Playwright) |
| Độ phân giải kiểm thử | `1280 × 720` (mức tối thiểu theo đặc tả §3.1) |
| Runtime Unit Test | Node.js `v22.23.1` (`node:test`) |
| Fixture | Sinh hoàn toàn tự động bằng `tests/fixtures/generate_fixtures.py` (không dùng ảnh người dùng hay ảnh AI) |

---

## 2. Lệnh chạy kiểm thử đã thực thi

```bash
npm run build           # Build dist/sprite-sheet-builder.html (558.4 KiB, 22 modules)
npm run test:unit       # 22/22 PASS (477 ms, gồm R1, R4, 5 bộ mask E01–E07 và 3 bộ PR2-P1/P2)
npm run test:fixtures   # Sinh bộ fixture tổng hợp gồm e01_strip_12frames_768x64.png
npm run test:e2e        # Chrome 158: 35/35 PASS (T01–T27 + R1–R9, 0 network req, 0 page errors)
                        # Edge   158: 35/35 PASS (T01–T27 + R1–R9, 0 network req, 0 page errors)
npm run test:eraser     # Chrome 158: 10/10 PASS (E01–E10 gồm DPR=2 & PR2-P1/P2, 0 network req, 0 page errors)
                        # Edge   158: 10/10 PASS (E01–E10 gồm DPR=2 & PR2-P1/P2, 0 network req, 0 page errors)
npm run test:perf       # Đo T28 + R6 (chuột thật Playwright + xác minh đổi offset & pixel canvas) trên Chrome 158 & Edge 158
```

Kết quả JSON chi tiết được lưu tại:
- [tests/e2e/e2e_results.json](file:///h:/AI/pet/sprite-sheet-builder/tests/e2e/e2e_results.json)
- [tests/e2e/eraser_e2e_results.json](file:///h:/AI/pet/sprite-sheet-builder/tests/e2e/eraser_e2e_results.json)
- [tests/e2e/perf_results.json](file:///h:/AI/pet/sprite-sheet-builder/tests/e2e/perf_results.json)

---

## 3. Ma trận kiểm thử bắt buộc T01–T28

| ID | Trạng thái | Loại test | Bằng chứng thực đo (Chrome 158 & Edge 158) |
|---|---|---|---|
| **T01** | **PASS (Automated)** · *Manual Explorer: NOT RUN* | E2E (`file://`) | Mở trực tiếp `file:///.../dist/sprite-sheet-builder.html` không server/CDN: Chrome 158 (median `157,5 ms`), Edge 158 (median `177,2 ms`), **0 network requests**, **0 page errors**. *Lưu ý: thao tác nhấp đúp vật lý trong Explorer khi ngắt card mạng cần xác nhận thủ công ở mục 5.* |
| **T02** | **PASS** | Unit + E2E Pixel | Lưới `3×2`, ô `100×80`, ảnh `400×200` → xuất `spritesheet_3x2_100x80.png` kích thước `300×160`; đọc pixel bằng Pillow xác nhận nội dung `y=15..64` nguyên vẹn, lề trên `y=14` và dưới `y=65` có `alpha=0`, ô trống `(0,1)` có `alpha=0`. |
| **T03** | **PASS** | E2E Pixel | Kéo `20 CSS px` ở `previewScale=2,80` dịch đúng `offsetX = 20 / 2,80`; bản nháp không làm thay đổi state committed trước khi bấm **Áp dụng**; **Hủy** hoàn nguyên `0`; xuất PNG ở zoom UI `25%` và `250%` cho kết quả giống nhau từng byte. |
| **T04** | **PASS** | E2E Pixel | Ảnh cắt vùng bên trái màu đỏ `(255,0,0,255)` kề sát vùng phải màu xanh lá `(0,255,0,255)` phóng 150% và dịch `+30 px` tràn biên, bật lưới & đường gióng UI → pixel mép phải ô 0 `(99,50)` giữ đúng `(255,0,0,255)` (0 bleed), ô trống kế bên `(100,50)` và `(150,50)` có `alpha=0` (0 overflow, 0 overlay leak). |
| **T05** | **PASS** | Unit + E2E Pixel | Fixture alpha `0/128/255` tỷ lệ 1:1 → PNG đúng chữ ký `\x89PNG` và alpha chính xác `(0, 128, 255)`; WebP đúng chữ ký `RIFF....WEBP` và alpha `(0, 128, 255)` (sai số `0`, trong ngưỡng `±2`). |
| **T06** | **PASS** | Unit + E2E | Từ chối đủ 5 file lỗi: PNG hỏng, SVG giả đuôi `.png`, APNG có chunk `acTL`, WebP động có cờ animation, PNG header `9000×100` vượt `8192 px`; ô đã có ảnh trước đó giữ nguyên. |
| **T07** | **PASS** | Unit + E2E Pixel | Preset **Hatch Pet V2** (`8×11`, `192×208`), nhập hàng loạt 73 ảnh phân biệt bỏ qua ô dư → xuất `spritesheet_8x11_192x208.png` đúng `1536×2288`; xác minh từng pixel trung tâm của **cả 73 ô dự kiến** khớp mã màu gốc và **cả 15 ô dư** có `alpha=0`; JSON metadata đúng 88 slot & 11 nhóm (`look directions A/B` mặc định `once`). |
| **T08** | **PASS** | Unit + E2E | Giả lập encoder trả `null`, fallback MIME `image/png` khi yêu cầu WebP, và throw lỗi OOM → cả 3 đều bị chặn an toàn, không tạo file tải sai, giữ nguyên 73 ô trong phiên và xuất lại thành công ngay sau đó. |
| **T09** | **PASS** | Unit + E2E | Thu lưới `8×11` → `4×4` báo trước xóa 57 ô và animation slots; đổi kích thước ô `(192,208)` → `(384,104)` nhân offset `(10,20)` → `(20,10)`; **Undo** 1 lần khôi phục nguyên 73 ô, 11 nhóm và offset `(10,20)`. |
| **T10** | **PASS** | Unit + E2E | Batch gồm `frame10.png`, `frame2.png`, `frame1.png`, `fake_svg.png` với ô `(0,1)` đã có ảnh → nút **Áp dụng** bị khóa cho đến khi bấm **Chỉ nhập ảnh hợp lệ**; kết quả điền đúng thứ tự tự nhiên `frame1 → (bỏ qua 0:1) → frame2 → frame10`; 1 lần Undo gỡ toàn bộ batch. |
| **T11** | **PASS** | Unit + E2E | Atlas `117×95` có margin `4`, gap `4×2`, frame `50×40`, dư `5×5` và ô `(1,0)` toàn `alpha=0` → khóa commit khi chưa xác nhận bỏ phần dư; bật lọc `alpha=0` tạo đúng 3 asset vùng cắt dùng chung **1 nguồn ảnh nhị phân** (không resample). |
| **T12** | **PASS** | Unit + E2E | Ảnh có padding khác nhau kèm 1 pixel alpha mờ `a=4` tại `(5,5)` → `alphaBounds(threshold=8)` ra `(60,40,80,120)` trong khi `visibleBounds(alpha>0)` vẫn giữ `x=5`; ảnh toàn trong suốt trả `alphaBounds=null` và chặn áp dụng Fit Alpha. |
| **T13** | **PASS** | Unit + E2E | Đồng bộ `sync-scale-and-anchor` giữa `char_a` (cao 120), `char_b` (cao 60) và `char_tiny` (cao 10) → `char_tiny` bị báo vượt giới hạn zoom `400%` (không tự clamp); xác nhận bỏ qua lỗi áp dụng `char_b` thành `zoom=2,000` và khớp anchor trong sai số `< 0,01 px`, giữ nguyên `char_tiny` ở `zoom=1`. |
| **T14** | **PASS** | E2E | Ghim ô `0:1` làm tham chiếu, bật Onion Skin → khi xóa nội dung ô `0:1`, ứng dụng tự tắt `onionEnabled` và đặt `referenceCellKey=null` an toàn kèm thông báo. |
| **T15** | **PASS** | Unit + E2E | Hoán đổi ô, thực hiện >50 giao dịch liên tiếp (60 mục Undo), kiểm tra Undo về đúng bước 51, thực hiện thay đổi mới xóa sạch nhánh Redo cũ. |
| **T16** | **PASS** | Unit + E2E Pixel | Lưu `.ssb` chứa 1 ảnh chưa dùng trong thư viện, 1 asset vùng cắt, nhóm animation `pingpong` có `durationMs` riêng, custom anchor `(60,140)`, custom preset → reset rỗng → mở lại `.ssb` → so sánh toàn bộ pixel RGBA của PNG xuất trước và sau: **khớp 100% tuyệt đối** trên cả Chrome và Edge. |
| **T17** | **PASS** | Unit + E2E | Từ chối an toàn 5 archive `.ssb` bất thường (không phải ZIP, thiếu file source, `schemaVersion=99`, path traversal `../evil.txt`, `region` vượt biên nguồn) + unit test từ chối CRC sai, prototype pollution `__proto__`, và zip-bomb DEFLATE 200 KiB vượt giới hạn 10 KiB; project đang mở không bị ảnh hưởng. |
| **T18** | **PASS (IDB CRUD)** · *Multi-tab/Quota Manual: NOT RUN* | E2E (`file://`) | IndexedDB hoạt động trên cả Chrome 158 và Edge 158 qua `file://`: kiểm tra probe thành công, lưu snapshot nguyên tử, đọc lại hợp lệ và xóa sạch bằng `clearRecovery()`. *Kịch bản giả lập quota đầy vật lý và xung đột 2 tab thật ghi hướng dẫn manual ở mục 5.* |
| **T19** | **PASS** | Unit + E2E | Unit test kiểm chứng `loop`, `once`, `pingpong` (chuỗi `[0,1,2,3,2,1]`, không lặp hai đầu; nhóm 1 frame an toàn), `durationMs` riêng, tạm dừng khi ẩn tab không chạy bù; E2E xác nhận ô trống trong nhóm giữ đúng slot trên timeline và hiển thị cảnh báo. |
| **T20** | **PASS** | Unit + E2E | Xuất gói `Test_bundle.zip` chứa Atlas PNG, JSON metadata V1, 2 strip nhóm trùng tên `walk` được khử trùng an toàn (`walk_strip_horizontal.png`, `walk_strip_horizontal_2.png`) và frame theo nhóm (`walk_f001.png`); kiểm tra mở ZIP hợp lệ bằng `zipfile`. |
| **T21** | **PASS** | E2E | Bắt đầu nhập giải mã ảnh rồi chuyển sang project mới ngay lập tức → kết quả giải mã cũ bị hủy an toàn, `0` ô bị ghi nhầm vào project mới (đã phát hiện và sửa triệt để race condition ở bản kiểm thử trước). |
| **T22** | **PASS** | E2E Pixel | Nhập 73 ảnh `1024×1024` RGBA (`73 Mi pixel` > giới hạn cache `64 Mi pixel`), xuất atlas `1536×2288` thành công; cache LRU tự thu hồi 56 lần, giữ ở `63,2 / 64,0 Mi pixel`. |
| **T23** | **PASS** | Unit + E2E | Chặn `cols=65`, `>1024` ô, `>8192 px`, `>32 Mi px` với lỗi inline cạnh ô nhập và khóa nút **Áp dụng**; gắn cờ xác nhận *Chế độ xuất lớn* cho atlas vượt `4096 px` / `16 Mi px`. |
| **T24** | **PASS** | Unit + E2E | Preflight phát hiện chính xác `PRESET_MISSING_EXPECTED`, `PRESET_UNUSED_OCCUPIED`, `ANIMATION_EMPTY_SLOT`, `OUTSIDE_CELL`; nút **Đi tới ô** đóng dialog, chọn đúng ô và cuộn lưới tới vị trí đó. |
| **T25** | **PASS** | E2E (`1280×720`) | Tại cửa sổ `1280×720`, nút **Lưu** và **Xuất...** hiển thị trọn vẹn trong khung (`export right = 1270 px ≤ 1280 px`); gõ `Backspace` trong ô tên project không kích hoạt xóa ô. |
| **T26** | **PASS** | Unit + E2E Pixel | Ảnh JPEG `100×200` gốc có EXIF Orientation `6` (xoay 90° CW) được đọc & xuất đúng kích thước `200×100` (nửa trái xanh dương, nửa phải đỏ); chuyển đổi giao diện Tối ↔ Sáng cho file PNG xuất **giống nhau từng byte**. |
| **T27** | **PASS** | E2E | Xuất Atlas PNG khi project chưa lưu giữ nguyên trạng thái `isDirty = true` và nhãn `• Chưa lưu`; xuất ảnh không bao giờ đánh dấu project đã lưu. |
| **T28** | **PASS** | Perf Benchmark | Đo ≥ 3 lượt mỗi kịch bản trên cả Chrome 158 và Edge 158 (kèm R6 dùng chuột thật Playwright + kiểm chứng đổi tọa độ & pixel canvas) — đạt toàn bộ mục tiêu §12.4 (chi tiết mục 4). |
| **R1** | **PASS** | Unit + E2E | Chặn dán clipboard tham chiếu asset đã xóa ngay tại `store.pasteCells` & `app.pasteClipboard` (project vẫn lưu `.ssb` hợp lệ); Undo xóa asset thì dán lại thành công; tự xóa clipboard ô khi New/Open project. |
| **R2** | **PASS** | E2E | Gom luồng chọn ô về `selectCellWithGuard` / `selectRectRangeWithGuard`: nhấp lại cùng ô giữ nguyên bản nháp không hiện dialog; Ctrl+click / Shift+click / kéo chọn sang ô khác đều bật hộp thoại Áp dụng / Hủy bản nháp / Tiếp tục sửa. |
| **R3** | **PASS** | E2E | Khóa độc quyền 1 job thay đổi project/IO tại một thời điểm với token riêng (`activeJob`); khóa nút New/Open khi đang chạy job; kiểm tra Hủy & revision sau từng ảnh giải mã (kể cả ảnh cuối) và ngay trước commit; job cũ không xóa trạng thái job mới. |
| **R4** | **PASS** | Unit + E2E (IDB) | Hủy timer autosave theo `projectId` ngay khi New/Open/Restore; đóng gói tuần tự qua hàng đợi `_opQueue`; kiểm tra đủ 100% nguồn nhị phân trước khi chạm IDB và ghi nguồn + marker + dọn rác trong **1 giao dịch IDB `readwrite` duy nhất**. |
| **R5** | **PASS** | E2E | Kiểm tra `File.size` (0 byte hoặc `> 512 MiB`) ở đầu `openProjectFile` **trước** hộp thoại bỏ thay đổi và **trước** `file.arrayBuffer()` (đã kiểm chứng với file giả 600 MiB: `arrayBuffer()` không hề bị gọi). |
| **R6** | **PASS** | Perf (Real Pointer) | Thay `dispatchEvent` tổng hợp bằng `page.mouse` thật trên `#editor-canvas`, xác nhận `draft.offsetX/offsetY` thay đổi thực sự (`147–148` tọa độ khác nhau), `EditorView.render()` thực thi (`146–147` khung), và dữ liệu pixel canvas thực sự dịch chuyển. |
| **R7–R9** | **PASS** | E2E | Đổi tên project giữ nguyên bản nháp X=12 chưa áp dụng; mở `.ssb` hợp lệ khóa sửa editor trong lúc decode và giữ nguyên bản nháp mới phát sinh; thả ảnh sau khi Áp dụng nhập đúng ô kế tiếp. |

---

## 3.1. Ma trận kiểm thử tính năng Tẩy phần thừa theo từng ô (E01–E10)

| ID | Trạng thái | Loại test | Bằng chứng thực đo (Windows 11 Chrome 158 & Edge 158 qua `file://`) |
|---|---|---|---|
| **E01** | **PASS** | Unit + E2E Pixel | Fixture 12 frame (`e01_strip_12frames_768x64.png`, có mẩu màu của frame 2 đặt sẵn trong vùng crop frame 1): ô trống không hiện cọ; phóng xem 200%, chọn Tẩy (cỡ 14 px, kiểm tra bán kính vòng tròn con trỏ khớp `radius × geom.scale × previewScale`), kéo tẩy mẩu thừa (offset X/Y giữ đúng `0`), Áp dụng → PNG xuất có `alpha = 0` tại mẩu thừa, thân frame 1 & cả 11 frame còn lại `0 pixel diff`; WebP đúng chữ ký `RIFF....WEBP` và giữ nền trong suốt. |
| **E02** | **PASS** | Unit + E2E Pixel | Dùng chung asset `f_0` cho ô `0:0` và ô đối chứng `0:7`; tẩy tâm ô `0:0` → PNG xuất có ô `0:0` bị tẩy (`alpha = 0`), ô `0:7` khớp **0 pixel diff** với ảnh gốc, byte nguồn gốc trong `AssetManager` giữ nguyên từng byte. |
| **E03** | **PASS** | Unit + E2E Pixel (`DPR=2`) | Chạy trên trình duyệt có `window.devicePixelRatio === 2`, crop gốc khác 0 `(128, 0, 64, 64)`, zoom ảnh `150%`, offset `(12, -8)`, zoom xem `200%`: 1 click đơn tại `(158, 32)` + kéo nhanh 2 sự kiện (`steps=1`, nhảy 26 px nguồn) → đổi transform sau tẩy thành zoom `200%`, offset `(-10, 6)` → vết tẩy vẫn đè đúng pixel nguồn đích, trung điểm nét kéo nhanh `alpha = 0` (0 ngắt quãng), vùng thân không tẩy giữ `alpha = 255`. |
| **E04** | **PASS** | Unit + E2E Pixel | Fixture `t05_alpha_levels_90x60.png` (dải `alpha = 0 / 128 / 255`): Tẩy rồi Khôi phục qua cả 3 dải → PNG xuất trả đúng `alpha = (0, 128, 255)` không bồi đục hay sơn trắng; kiểm chứng **Hoàn nháp**, **Hủy** giữ nguyên phiên, **Áp dụng** rồi **Undo/Redo** cấp project khôi phục đúng pixel. |
| **E05** | **PASS** | Unit + E2E Pixel + Metadata | Mẩu thừa ở frame 1 kéo rộng alpha bounds thành `w = 48`: bật Fit Alpha + anchor đáy giữa alpha, tẩy mẩu thừa → bounds cập nhật `w = 32` ngay trước khi bấm Áp dụng; Atlas PNG, Strip PNG, Frame đơn PNG khớp **0 pixel diff**; JSON V1 mặc định tuân thủ schema gốc (`anchorCellPx` sau tẩy, không thêm trường lạ) và JSON V2 (`includeContentBounds`) khớp chính xác `contentBoundsCellPx`. Tẩy sạch toàn bộ ô → Preflight báo `0` lỗi chặn + cảnh báo `MASK_ALL_TRANSPARENT`, xuất atlas thành công với ô 1 trong suốt (`alpha = 0`), vẫn **Khôi phục** và **Bỏ toàn bộ vết tẩy** được bình thường. |
| **E06** | **PASS** | Unit + E2E Pixel + IDB | Lưu project không mask ra `.ssb` V2; vẽ 3 nét `erase`/`restore`/`erase` giao nhau → lưu `.ssb` V3 (`schemaVersion: 3`), lưu & đọc lại Recovery IndexedDB (3 nét khớp), đóng và mở lại `.ssb` V3 → PNG xuất trước/sau khớp **100% từng pixel**. Mở `.ssb` V2 cũ vẫn đọc bình thường; `.ssb` V3 sai (tọa độ ngoài biên `[-radius, dim+radius]` / op lạ / vượt giới hạn) và V2 chứa `mask` bị từ chối trước khi thay phiên đang mở. |
| **E07** | **PASS** | Unit + E2E Pixel | Copy/Paste và Hoán đổi ô mang vết tẩy theo; Dán căn chỉnh giữ nguyên không dán vết tẩy; Thay ảnh mới bắt đầu không có mask; Sửa vùng cắt (`10,10,44,44`) giữ nét trong hệ tọa độ nguồn và chỉ hiện phần giao không kéo giãn; kiểm chứng Draft guard khi chuyển ô có nét tẩy chưa áp dụng và `pointercancel` giải phóng `brushState` sạch; chạy lại toàn bộ 35/35 E2E cũ (`file://`) với `0` network requests và `0` page errors. |
| **E08** | **PASS** | Unit + E2E + IDB | **PR2-P1 (Ngân sách sau thao tác & Manifest compact):** Dán ô 500 nét sang 16 ô đích (tổng `8.500 > 8.192` nét) bị từ chối gọn trước khi commit, state/revision/Undo stack không đổi; dán sang 15 ô (`8.000 ≤ 8.192`) thành công và qua Save/Open `.ssb` + IndexedDB Recovery; project `117.760` điểm xuất `manifest.json` compact chỉ **`0,87 MiB`** (`< 8 MiB`), mở lại & Recovery thành công. |
| **E09** | **PASS** | Unit + E2E Pixel | **PR2-P2 (Cọ sát mép & Cọ 1 px ổn định):** Ảnh `64×64` trong ô `64×96` (`y=16..80`), click chuột thật tại `(32, 8)` với cọ `20 px` (`radius=10`) chỉ tẩy đúng 2 hàng `[16, 17]` (không kéo tâm cọ vào trong thành 10 hàng); cọ `1 px` trên pixel mép phải `x=63` của vùng crop `64×64` giữ nguyên tại nguồn `x=63` (không nhảy sang `x=64`) khi mở rộng crop `64 → 80`. |
| **E10** | **PASS** | Unit + E2E Pixel + Schema | **PR2-P2 (Bounds sau clip & Tương thích Atlas V1/V2):** Ảnh `64×64` dịch `+24 px` trong ô `64×64` → PNG bbox `(24, 0, 40, 64)` khớp tuyệt đối với JSON V2 `contentBoundsCellPx`; dịch hẳn ngoài ô (`+100 px`) trả `null`; JSON V1 mặc định khớp nghiêm ngặt toàn bộ khóa/kiểu của `schemas/atlas-v1.schema.json` nguyên bản (không chứa `contentBoundsCellPx`). |

---

## 4. Kết quả đo hiệu năng thực tế (T28 — Spec §12.4)

Fixture: 73 ảnh PNG `1024×1024` RGBA tổng hợp (`2,96 MiB` nén trên đĩa, `73 Mi pixel` khi giải mã, vượt ngân sách cache `64 Mi pixel` để kích hoạt LRU thực tế). Mỗi phép đo thời gian chạy **3 lượt**, báo cáo **median** và **worst**; kéo liên tục 5 giây báo **p95** riêng.

| Kịch bản (§12.4) | Mục tiêu | Chrome 158 (Median / Worst) | Edge 158 (Median / Worst) | Kết luận |
|---|---|---:|---:|---|
| Mở HTML offline (`file://`), chưa có project | `≤ 2.000 ms` | **158,8 ms** / 161,9 ms | **192,5 ms** / 211,0 ms | **ĐẠT** |
| Nhập 73 PNG `1024×1024` RGBA (`≤ 100 MiB`) | `≤ 30.000 ms` | **577,5 ms** / 596,9 ms | **589,8 ms** / 589,9 ms | **ĐẠT** |
| Kéo liên tục 5 giây chuột thật trên ô đã cache (R6) | `p95 ≤ 50 ms` | **p95 = 0,9 ms** (med 0,5 / max 3,5 ms; 147 mẫu, 146 render, pixel đổi) | **p95 = 0,8 ms** (med 0,4 / max 2,1 ms; 148 mẫu, 147 render, pixel đổi) | **ĐẠT** |
| Preview 12 FPS, nhóm 8 frame đã warm cache | Đúng thứ tự, không rò RAM | 18 chuyển frame / 1,5 s, chuỗi `[0..7, 0..3]`, cache phẳng `63,49 Mi px` | 18 chuyển frame / 1,5 s, chuỗi `[0..7, 0..3]`, cache phẳng `63,49 Mi px` | **ĐẠT** |
| Xuất PNG atlas `1536×2288` từ project 73 frame | `≤ 10.000 ms` | **537,6 ms** / 568,1 ms | **509,7 ms** / 622,9 ms | **ĐẠT** |
| Lưu `.ssb` project 73 frame | `≤ 30.000 ms` | **134,6 ms** / 193,6 ms | **139,1 ms** / 169,0 ms | **ĐẠT** |
| Mở `.ssb` project 73 frame | `≤ 30.000 ms` | **620,1 ms** / 645,5 ms | **582,9 ms** / 601,9 ms | **ĐẠT** |

**Kiểm tra thu hồi cache sau benchmark:** Cache LRU giới hạn cứng `67.108.864 px` (`64 Mi px`), ghi nhận `356` lần thu hồi trên Chrome và `360` lần trên Edge, mức còn lại cuối phiên chỉ `1,0–2,0 Mi px` (không rò rỉ bitmap).

> **Ghi chú minh bạch về fixture hiệu năng:** Fixture 73 ảnh `1024×1024` tổng hợp có dung lượng nén nhỏ (`2,96 MiB`) hơn 73 ảnh AI giàu chi tiết (~60–100 MiB). Với ảnh AI nặng ~100 MiB, thời gian giải mã PNG và đóng gói `.ssb` sẽ tăng tương ứng với dung lượng I/O đĩa (vẫn còn biên dự phòng > 30× so với mục tiêu 30 giây).

---

## 5. Các mục Manual Test chưa chạy tự động (`NOT RUN`) & Hướng dẫn kiểm chứng thủ công

Vì môi trường agent chạy Playwright headless, các thao tác mức hệ điều hành Windows Explorer và cảm quan UX thủ công dưới đây được đánh dấu **`NOT RUN (Manual)`** để người dùng kiểm chứng trực tiếp trước khi đưa vào sử dụng rộng rãi:

1. **T01 (Manual Explorer + Ngắt mạng vật lý):** Tắt Wi-Fi/Ethernet trên Windows 11, vào `h:\AI\pet\sprite-sheet-builder\dist\`, nhấp đúp `sprite-sheet-builder.html` để mở trực tiếp trên Chrome và Edge, thực hiện nhập → chỉnh → lưu `.ssb` → mở lại → xuất PNG.
2. **Kéo thả file thật từ cửa sổ Windows Explorer:** Mở Explorer song song cửa sổ trình duyệt, kéo 1 file vào ô trống, kéo nhiều file vào lưới (xác nhận hộp thoại Batch Preview), và thả file ra ngoài vùng lưới (xác nhận trình duyệt không điều hướng mở tab ảnh).
3. **T18 (Manual Multi-tab Conflict & Reload Recovery):** Mở cùng lúc 2 tab `dist/sprite-sheet-builder.html`, kiểm tra thông báo phát hiện xung đột đa tab trên thanh trạng thái; đóng 1 tab, bấm *Cài đặt → Lưu snapshot recovery ngay*, tải lại trang (F5) và xác nhận hộp thoại *Khôi phục / Bỏ qua / Xóa*.
4. **Trải nghiệm UX thực tế trên 73 frame thật:** Dùng bộ ảnh nhân vật thật ở cửa sổ `1280 × 720` để đánh giá độ thoải mái khi thu gọn/kéo rộng panel, dùng Onion Skin và phím tắt `Ctrl+S`, `Ctrl+Z`, mũi tên.

---

## 6. Trạng thái Definition of Done

- [x] Có file HTML phát hành độc lập [dist/sprite-sheet-builder.html](file:///h:/AI/pet/sprite-sheet-builder/dist/sprite-sheet-builder.html) (`558,4 KiB`), chạy offline thật qua `file://`, không nút giả, không chức năng bắt buộc để TODO.
- [x] Nhập được 73 frame preset Hatch Pet V2, tách atlas/strip, căn chỉnh hàng loạt, tẩy/khôi phục phần thừa theo từng ô, preview animation và xuất đúng `1536 × 2288` với 15 ô dư `alpha = 0` (đã xác minh pixel trên cả Chrome 158 & Edge 158).
- [x] Lưu project `.ssb` (V2 khi không mask, V3 khi có mask), đóng/reset và mở lại, chỉnh tiếp được với ảnh nguồn và thông số còn nguyên; pixel RGBA xuất trước/sau khớp 100%.
- [x] Toàn bộ 22/22 unit test + 35/35 E2E regression test + 10/10 Eraser E2E test trên Chrome 158 và Edge 158 + benchmark T28 đạt; 0 lỗi blocker/critical; các mục manual mức OS Explorer chưa chạy được liệt kê minh bạch ở mục 5.
- [x] Đầy đủ mã nguồn (`src/`), JSON Schema (`schemas/` gồm `project-v3.schema.json` và `atlas-v2.schema.json`, giữ nguyên `atlas-v1.schema.json`), fixture 12 frame & test (`tests/`), tài liệu (`README.md`, `PROJECT-FORMAT.md`, `IMPLEMENTATION-NOTES.md`, `THIRD-PARTY-LICENSES.md`, `ACCEPTANCE-REPORT.md`).
