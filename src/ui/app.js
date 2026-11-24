/**
 * Sprite Sheet Builder V2.0 — Main Application Controller.
 * Orchestrates Store, AssetManager, Recovery, Views, Modals, Hotkeys, Clipboard, and Jobs.
 */

import {
  LIMITS,
  cellKey,
  parseCellKey,
  isCellInGrid,
  generateId,
  sanitizeFilename,
  deepClone,
  stableSort,
  naturalCompare
} from '../core/constants.js';
import { validateGrid } from '../core/validator.js';
import { ProjectStore, createEmptyProject, createDefaultCell } from '../core/store.js';
import { AssetManager } from '../engine/asset-manager.js';
import { executeExportJob, triggerBlobDownload } from '../engine/export-engine.js';
import { serializeProjectToSsb, deserializeProjectFromSsb } from '../io/project-io.js';
import { RecoveryManager } from '../io/recovery.js';
import { AtlasView } from './atlas-view.js';
import { EditorView } from './editor-view.js';
import { AnimationView } from './animation-view.js';
import { ModalsController } from './modals.js';
import {
  $,
  clearEl,
  el,
  showToast,
  showChoiceDialog,
  showUnsavedDraftDialog,
  isTypingInField
} from './dom-helpers.js';

export class SpriteSheetBuilderApp {
  constructor() {
    this.store = new ProjectStore();
    this.assetManager = new AssetManager();
    this.recovery = new RecoveryManager();

    this.store.sourceBytesLookup = (id) => this.assetManager.getSourceByteLength(id);
    this.store.historyPrunedCallback = (count) => {
      showToast(`Đã thu gọn ${count} bước lịch sử cũ nhất do giới hạn tài nguyên bộ nhớ.`, 'warn', 5000);
    };

    // UI selection & transient state
    this.activeCellKey = '0:0';
    this.anchorSelectKey = '0:0';
    this.selectedCells = new Set(['0:0']);
    this.selectedLibAssets = new Set();
    this.referenceCellKey = null;

    // Internal clipboard (Spec §8)
    this.clipboard = null; // { type: 'cells', origin:{row,col}, items:[{dr,dc,cell}] } | { type: 'transform', transform }

    // Active long-running job state
    this.isJobRunning = false;
    this.activeAbortController = null;
    this.customExportEncoder = null; // Used for testing encoder failure (T08)

    // Initialize views
    this.atlasView = new AtlasView(this);
    this.editorView = new EditorView(this);
    this.animationView = new AnimationView(this);
    this.modals = new ModalsController(this);

    this._contextCell = null;
    this._bindGlobalEvents();
    this._bindToolbarAndPanels();
    this._bindStoreSubscriptions();
    this._initTheme();
    this._initRecovery();

    this._syncAllUI();
    this.atlasView.fitToViewport();
  }

  // =========================================================================
  // INITIALIZATION & RECOVERY
  // =========================================================================
  _initTheme() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const updateBtn = () => {
      const mode = meta?.content === 'light' ? 'light' : 'dark';
      const btn = $('btn-theme-toggle');
      if (btn) btn.textContent = mode === 'light' ? 'Giao diện: Sáng' : 'Giao diện: Tối';
    };
    updateBtn();

    $('btn-theme-toggle').addEventListener('click', () => {
      const cur = meta?.content === 'light' ? 'light' : 'dark';
      const next = cur === 'light' ? 'dark' : 'light';
      if (meta) meta.content = next;
      try { localStorage.setItem('ssb-color-scheme', next); } catch {}
      updateBtn();
      this.atlasView.requestRender();
      this.editorView.requestRender();
      this.animationView.renderCurrentFrame();
    });
  }

  async _initRecovery() {
    this.recovery.onStatusChange = (st) => {
      const elStatus = $('status-recovery');
      if (elStatus) {
        elStatus.textContent = st.message;
        elStatus.style.color = st.status === 'unavailable' || st.status === 'quota-exceeded' || st.multiTabConflict
          ? 'var(--warn)'
          : 'var(--text-muted)';
      }
    };

    const available = await this.recovery.init();
    if (!available) return;

    const snap = await this.recovery.loadValidSnapshot();
    if (!snap) return;
    // Never overwrite if user already modified or opened a project while probing
    if (this.store.revision > 1) return;

    const timeStr = new Date(snap.savedAt).toLocaleString('vi-VN');
    const choice = await showChoiceDialog({
      title: 'Phát hiện bản phục hồi tự động',
      message: `Tìm thấy snapshot recovery của project "${snap.project.name}" lưu lúc ${timeStr} (${Object.keys(snap.project.cells).length} ô có ảnh). Bạn muốn làm gì?`,
      buttons: [
        { label: 'Bỏ qua', value: 'skip', autofocus: true },
        { label: 'Xóa bản phục hồi', value: 'clear', className: 'btn-danger' },
        { label: 'Khôi phục', value: 'restore', className: 'btn-primary' }
      ]
    });

    if (choice === 'restore') {
      this._loadDeserializedProject(snap.project, snap.sourceBinaries, { markClean: false });
      showToast(`Đã khôi phục project "${snap.project.name}" từ recovery.`, 'ok');
    } else if (choice === 'clear') {
      await this.recovery.clearRecovery();
      showToast('Đã xóa dữ liệu recovery cũ.', 'info');
    }
  }

  // =========================================================================
  // STORE SUBSCRIPTION & UI SYNCHRONIZATION
  // =========================================================================
  _bindStoreSubscriptions() {
    this.store.subscribe((project, event) => {
      // Garbage collect unreferenced source binaries & bitmaps (Spec §8, §12.2)
      const keepIds = this.store.getAllReferencedSourceIds();
      this.assetManager.garbageCollect(keepIds);

      // Verify selection & reference cell still valid after resize/delete
      for (const k of [...this.selectedCells]) {
        const pos = parseCellKey(k);
        if (!pos || !isCellInGrid(pos.row, pos.col, project.grid)) {
          this.selectedCells.delete(k);
        }
      }
      if (!this.activeCellKey || !this.selectedCells.has(this.activeCellKey)) {
        this.activeCellKey = this.selectedCells.size > 0 ? [...this.selectedCells][0] : '0:0';
        this.selectedCells.add(this.activeCellKey);
      }

      // If reference cell deleted/cleared/out of grid -> safely turn off overlay & notify (T14)
      if (this.referenceCellKey) {
        const rpos = parseCellKey(this.referenceCellKey);
        const validRef = rpos && isCellInGrid(rpos.row, rpos.col, project.grid) && Boolean(project.cells[this.referenceCellKey]);
        if (!validRef) {
          this.referenceCellKey = null;
          if (this.editorView.onionEnabled) {
            this.editorView.onionEnabled = false;
            const chk = $('ed-onion-enable');
            if (chk) chk.checked = false;
          }
          showToast('Frame tham chiếu đã bị xóa hoặc rời khỏi lưới — đã tắt Onion Skin an toàn.', 'warn', 3500);
        }
      }

      this._syncAllUI();

      // Schedule debounced recovery save on committed changes
      if (event.type === 'commit' || event.type === 'undo' || event.type === 'redo') {
        this.recovery.scheduleSave(() => ({
          project: this.store.project,
          revision: this.store.revision,
          assetManager: this.assetManager
        }));
      }
    });
  }

  _syncAllUI() {
    const p = this.store.project;
    $('project-name-input').value = p.name;
    $('btn-undo').disabled = !this.store.canUndo() || this.isJobRunning;
    $('btn-redo').disabled = !this.store.canRedo() || this.isJobRunning;

    // Dirty / Save badge
    const badge = $('dirty-badge');
    const stSave = $('status-save-state');
    if (this.store.saveState === 'save-failed') {
      badge.textContent = 'Lưu thất bại';
      badge.className = 'dirty-badge is-dirty';
      stSave.textContent = 'Lưu thất bại';
    } else if (this.store.isDirty) {
      badge.textContent = '• Chưa lưu';
      badge.className = 'dirty-badge is-dirty';
      stSave.textContent = 'Chưa lưu';
    } else if (this.store.saveState === 'download-requested') {
      badge.textContent = this.store.lastSavedLabel;
      badge.className = 'dirty-badge is-saved';
      stSave.textContent = this.store.lastSavedLabel;
    } else if (this.store.saveState === 'saved-direct') {
      badge.textContent = this.store.lastSavedLabel;
      badge.className = 'dirty-badge is-saved';
      stSave.textContent = this.store.lastSavedLabel;
    } else {
      badge.textContent = 'Đã đồng bộ';
      badge.className = 'dirty-badge';
      stSave.textContent = 'Chưa chỉnh sửa';
    }

    // Grid inputs sync
    $('grid-cols').value = String(p.grid.cols);
    $('grid-rows').value = String(p.grid.rows);
    $('grid-cell-w').value = String(p.grid.cellWidth);
    $('grid-cell-h').value = String(p.grid.cellHeight);
    this._updateGridPreviewInfo();

    // Status bar counts
    const usage = this.store.getProjectResourceUsage();
    const atlasW = p.grid.cols * p.grid.cellWidth;
    const atlasH = p.grid.rows * p.grid.cellHeight;
    $('status-project-name').textContent = p.name;
    if (p.expectedCells) {
      const filledExpected = p.expectedCells.filter((k) => Boolean(p.cells[k])).length;
      const unusedOccupied = usage.filledCellCount - filledExpected;
      $('status-cells').textContent = `${usage.filledCellCount}/${usage.totalCellCount} ô (${filledExpected}/${p.expectedCells.length} dự kiến${unusedOccupied > 0 ? `, +${unusedOccupied} dư` : ''})`;
    } else {
      $('status-cells').textContent = `${usage.filledCellCount}/${usage.totalCellCount} ô`;
    }
    $('status-atlas-dim').textContent = `${atlasW}×${atlasH} px`;

    // Render subviews
    this.renderLibrary();
    this.atlasView.requestRender();
    this.editorView.loadCell(this.activeCellKey);
    this.animationView.onProjectChanged();
  }

  _updateGridPreviewInfo() {
    const cols = parseInt($('grid-cols').value, 10);
    const rows = parseInt($('grid-rows').value, 10);
    const cellWidth = parseInt($('grid-cell-w').value, 10);
    const cellHeight = parseInt($('grid-cell-h').value, 10);
    const res = validateGrid({ cols, rows, cellWidth, cellHeight });
    const dimEl = $('atlas-dim-preview');
    const errEl = $('grid-error-inline');
    const applyBtn = $('btn-grid-apply');

    if (res.ok) {
      dimEl.textContent = `${res.atlasWidth}×${res.atlasHeight} px` + (res.needsLargeExportConfirm ? ' (xuất lớn)' : '');
      errEl.textContent = '';
      errEl.classList.add('hidden');
      applyBtn.disabled = false;
    } else {
      dimEl.textContent = Number.isFinite(cols * cellWidth) && Number.isFinite(rows * cellHeight)
        ? `${cols * cellWidth}×${rows * cellHeight} px`
        : '—';
      errEl.textContent = res.errors[0];
      errEl.classList.remove('hidden');
      applyBtn.disabled = true;
    }
  }

  // =========================================================================
  // DRAFT & DIRTY GUARDS (Spec §3.4, §10.2)
  // =========================================================================
  async ensureDraftResolved() {
    if (!this.editorView.hasUnsavedDraft()) return true;
    const pos = parseCellKey(this.editorView.cellKey);
    const lbl = pos ? `${pos.row + 1}, ${pos.col + 1}` : this.editorView.cellKey;
    const choice = await showUnsavedDraftDialog(lbl);
    if (choice === 'apply') {
      return this.editorView.applyDraft();
    }
    if (choice === 'discard') {
      this.editorView.discardDraft();
      return true;
    }
    return false;
  }

  async ensureUnsavedProjectConfirmed(actionLabel = 'tiếp tục') {
    if (!this.store.isDirty) return true;
    const choice = await showChoiceDialog({
      title: 'Project có thay đổi chưa được lưu',
      message: `Project "${this.store.project.name}" có thay đổi chưa lưu vào file .ssb. Bạn có chắc muốn ${actionLabel} và bỏ các thay đổi hiện tại?`,
      buttons: [
        { label: 'Quay lại', value: 'cancel', autofocus: true },
        { label: 'Bỏ thay đổi và tiếp tục', value: 'proceed', className: 'btn-danger' }
      ]
    });
    return choice === 'proceed';
  }

  // =========================================================================
  // SELECTION & REFERENCE FRAME
  // =========================================================================
  selectCell(row, col, { ctrl = false, shift = false } = {}) {
    if (!isCellInGrid(row, col, this.store.project.grid)) return;
    const key = cellKey(row, col);

    if (shift && this.anchorSelectKey) {
      const a = parseCellKey(this.anchorSelectKey);
      if (a) {
        this.selectRectRange(a.row, a.col, row, col);
        this.activeCellKey = key;
        this.editorView.loadCell(this.activeCellKey);
        return;
      }
    }

    if (ctrl) {
      if (this.selectedCells.has(key) && this.selectedCells.size > 1) {
        this.selectedCells.delete(key);
        if (this.activeCellKey === key) this.activeCellKey = [...this.selectedCells][0];
      } else {
        this.selectedCells.add(key);
        this.activeCellKey = key;
      }
    } else {
      this.selectedCells.clear();
      this.selectedCells.add(key);
      this.activeCellKey = key;
      this.anchorSelectKey = key;
    }

    this.atlasView.requestRender();
    this.editorView.loadCell(this.activeCellKey);
  }

  selectRectRange(r0, c0, r1, c1) {
    const minR = Math.min(r0, r1);
    const maxR = Math.max(r0, r1);
    const minC = Math.min(c0, c1);
    const maxC = Math.max(c0, c1);
    this.selectedCells.clear();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        this.selectedCells.add(cellKey(r, c));
      }
    }
    this.activeCellKey = cellKey(r0, c0);
    this.atlasView.requestRender();
    this.editorView.loadCell(this.activeCellKey);
  }

  focusEditorPanel() {
    const panel = $('panel-right');
    if (panel.classList.contains('is-collapsed')) {
      panel.classList.remove('is-collapsed');
      $('btn-collapse-right').setAttribute('aria-expanded', 'true');
      $('btn-collapse-right').textContent = '▶';
    }
    $('ed-offset-x')?.focus();
  }

  setReferenceCell(key) {
    this.referenceCellKey = key;
    if (key) {
      const pos = parseCellKey(key);
      showToast(`Đã chọn ô (${pos.row + 1}, ${pos.col + 1}) làm frame tham chiếu.`, 'info', 2200);
    }
    this.atlasView.requestRender();
    this.editorView._ensureAnalysisAndRender();
  }

  setAdjacentReference(delta) {
    const anim = this.animationView.getActiveAnimation();
    if (!anim || anim.frames.length === 0 || !this.activeCellKey) {
      showToast('Cần chọn ô thuộc một nhóm animation để lấy frame trước/sau.', 'warn');
      return;
    }
    const pos = parseCellKey(this.activeCellKey);
    const idx = anim.frames.findIndex((f) => f.row === pos.row && f.col === pos.col);
    if (idx === -1) {
      showToast('Ô đang chọn không nằm trong nhóm animation đang mở.', 'warn');
      return;
    }
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= anim.frames.length) {
      showToast(delta < 0 ? 'Đây đã là frame đầu nhóm.' : 'Đây đã là frame cuối nhóm.', 'info');
      return;
    }
    const tf = anim.frames[targetIdx];
    const tKey = cellKey(tf.row, tf.col);
    if (!this.store.project.cells[tKey]) {
      showToast('Frame liền kề đang trống.', 'warn');
      return;
    }
    this.setReferenceCell(tKey);
  }

  // =========================================================================
  // LIBRARY PANEL (Spec §3.3)
  // =========================================================================
  renderLibrary() {
    const listEl = $('lib-list');
    clearEl(listEl);
    const project = this.store.project;
    const query = ($('lib-search')?.value || '').trim().toLowerCase();
    const filter = $('lib-filter')?.value || 'all';
    const sortMode = $('lib-sort')?.value || 'natural';
    const usageMap = this.store.getAssetUsageMap();

    let assets = project.assets.map((asset, idx) => ({
      asset,
      source: this.store.getSource(asset.sourceId),
      usage: usageMap.get(asset.id) || 0,
      idx
    }));

    if (query) {
      assets = assets.filter((x) =>
        x.asset.name.toLowerCase().includes(query) ||
        (x.source?.name || '').toLowerCase().includes(query)
      );
    }
    if (filter === 'unused') assets = assets.filter((x) => x.usage === 0);
    if (filter === 'used') assets = assets.filter((x) => x.usage > 0);

    if (sortMode === 'natural') {
      assets = stableSort(assets, (a, b) => naturalCompare(a.asset.name, b.asset.name));
    } else if (sortMode === 'reverse-natural') {
      assets = stableSort(assets, (a, b) => -naturalCompare(a.asset.name, b.asset.name));
    }

    if (assets.length === 0) {
      listEl.appendChild(el('div', {
        className: 'lib-empty',
        text: project.assets.length === 0
          ? 'Thư viện trống. Bấm "+ Nhập ảnh" hoặc kéo thả ảnh PNG/WebP/JPG vào đây.'
          : 'Không có ảnh nào khớp bộ lọc hiện tại.'
      }));
      return;
    }

    const projId = project.projectId;
    for (const item of assets) {
      const { asset, source, usage } = item;
      const isSelected = this.selectedLibAssets.has(asset.id);
      const missingBin = !source || !this.assetManager.hasSourceBinary(source.id);

      const img = el('img', { className: 'lib-thumb', alt: asset.name });
      if (source && !missingBin) {
        this.assetManager.getAssetThumbnailDataUrl(asset, source, 84).then((url) => {
          if (url && this.store.project.projectId === projId) img.src = url;
        }).catch(() => {});
      }

      const row = el('div', {
        className: `lib-item ${isSelected ? 'is-selected' : ''}`,
        role: 'option',
        'aria-selected': String(isSelected),
        draggable: 'true',
        onClick: (e) => {
          if (e.ctrlKey || e.metaKey) {
            if (this.selectedLibAssets.has(asset.id)) this.selectedLibAssets.delete(asset.id);
            else this.selectedLibAssets.add(asset.id);
          } else {
            this.selectedLibAssets.clear();
            this.selectedLibAssets.add(asset.id);
          }
          this.renderLibrary();
        }
      }, [
        img,
        el('div', { className: 'lib-meta' }, [
          el('div', { className: 'lib-name', text: asset.name, title: asset.name }),
          el('div', { className: 'lib-sub' }, [
            el('span', { text: `${asset.region.w}×${asset.region.h}` }),
            el('span', { className: usage > 0 ? 'badge badge-accent' : 'badge', text: `Dùng: ${usage}` }),
            asset.isRegion ? el('span', { className: 'badge', text: 'Vùng cắt' }) : null,
            missingBin ? el('span', { className: 'badge badge-danger', text: 'Thiếu dữ liệu' }) : null
          ])
        ]),
        el('div', { className: 'lib-item-btns' }, [
          el('button', {
            type: 'button',
            className: 'btn-xs',
            text: 'Vùng',
            title: 'Chỉnh vùng cắt thủ công của asset này',
            onClick: (e) => {
              e.stopPropagation();
              this.modals.openManualRegionModal(asset.id);
            }
          }),
          el('button', {
            type: 'button',
            className: 'btn-xs btn-danger',
            text: 'Xóa',
            title: 'Xóa asset/nguồn ảnh khỏi thư viện',
            onClick: async (e) => {
              e.stopPropagation();
              await this.handleDeleteLibraryAsset(asset);
            }
          })
        ])
      ]);

      row.addEventListener('dragstart', (e) => {
        const ids = this.selectedLibAssets.has(asset.id)
          ? [...this.selectedLibAssets]
          : [asset.id];
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-ssb-assets', JSON.stringify(ids));
      });

      listEl.appendChild(row);
    }
  }

  async handleDeleteLibraryAsset(asset) {
    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;

    const usageMap = this.store.getAssetUsageMap();
    const count = usageMap.get(asset.id) || 0;
    if (count > 0) {
      const choice = await showChoiceDialog({
        title: `Xóa "${asset.name}" đang được sử dụng?`,
        message: `Asset này đang được sử dụng ở ${count} ô trên atlas. Xóa sẽ xóa toàn bộ liên kết ở ${count} ô đó (có thể Undo bằng Ctrl+Z).`,
        buttons: [
          { label: 'Hủy', value: 'cancel', autofocus: true },
          { label: `Xóa và gỡ khỏi ${count} ô`, value: 'del', className: 'btn-danger' }
        ]
      });
      if (choice !== 'del') return;
    }
    this.store.deleteAsset(asset.id);
    this.selectedLibAssets.delete(asset.id);
    showToast(`Đã xóa "${asset.name}" (có thể Undo).`, 'info');
  }

  // =========================================================================
  // FILE INGESTION & BATCH / SINGLE IMPORT (Spec §5.1, §5.2)
  // =========================================================================
  async handleIncomingFiles(files, { targetCell = null, libraryOnly = false, directSingle = false } = {}) {
    // Capture project & revision synchronously BEFORE any await (Spec §12.2, T21)
    const startProjectId = this.store.project.projectId;
    const startRevision = this.store.revision;

    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;
    if (!files || files.length === 0) return;
    if (this.store.project.projectId !== startProjectId) {
      showToast('Project đã thay đổi — hủy tác vụ nhập cũ.', 'warn');
      return;
    }

    const abort = this.beginJob(`Đang kiểm tra ${files.length} file ảnh...`);
    const items = [];
    const usage = this.store.getProjectResourceUsage();
    let accPixels = usage.totalSourcePixels;
    let accBytes = usage.totalSourceBytes;
    let accSources = usage.sourceCount;

    try {
      for (let i = 0; i < files.length; i++) {
        if (abort.signal.aborted) {
          showToast('Đã hủy quá trình nhập ảnh.', 'info');
          return;
        }
        this.updateJobProgress(i + 1, files.length, `Đang đọc & xác thực ${i + 1}/${files.length}: ${files[i].name}`);
        const res = await this.assetManager.inspectAndVerifyFile(files[i]);
        if (!res.ok) {
          items.push({ id: generateId('bad'), name: res.name, importIndex: i, valid: false, error: res.error });
          continue;
        }
        const px = res.source.width * res.source.height;
        if (accSources + 1 > LIMITS.MAX_SOURCES) {
          items.push({ id: generateId('bad'), name: res.name, importIndex: i, valid: false, error: `Vượt giới hạn ${LIMITS.MAX_SOURCES} nguồn ảnh.` });
          continue;
        }
        if (accPixels + px > LIMITS.MAX_PROJECT_SOURCE_PIXELS) {
          items.push({ id: generateId('bad'), name: res.name, importIndex: i, valid: false, error: 'Vượt giới hạn 256 Mi pixel nguồn của project.' });
          continue;
        }
        if (accBytes + res.source.byteLength > LIMITS.MAX_PROJECT_SOURCE_BYTES) {
          items.push({ id: generateId('bad'), name: res.name, importIndex: i, valid: false, error: 'Vượt giới hạn 256 MiB tổng dung lượng nguồn.' });
          continue;
        }
        accSources++;
        accPixels += px;
        accBytes += res.source.byteLength;
        items.push({
          id: res.source.id,
          name: res.name,
          importIndex: i,
          valid: true,
          source: res.source,
          bytes: res.bytes
        });
      }
    } finally {
      this.endJob();
    }

    // Revision / project guard for slow async decode (Spec §12.2, T21!)
    if (this.store.project.projectId !== startProjectId) {
      showToast('Project đã thay đổi trong lúc giải mã ảnh — kết quả cũ đã bị hủy an toàn.', 'warn');
      return;
    }

    const validItems = items.filter((x) => x.valid);
    const invalidItems = items.filter((x) => !x.valid);

    // Library-only import (does NOT auto-fill atlas per Spec §5.1)
    if (libraryOnly) {
      if (invalidItems.length > 0) {
        const details = invalidItems.map((it) => `${it.name}: ${it.error}`);
        if (validItems.length === 0) {
          await showChoiceDialog({
            title: 'Không thể nhập file',
            message: 'Tất cả file đã chọn đều không hợp lệ:',
            details,
            buttons: [{ label: 'Đóng', value: 'ok', autofocus: true }]
          });
          return;
        }
        const choice = await showChoiceDialog({
          title: `Có ${invalidItems.length} file lỗi khi nhập vào thư viện`,
          message: `Có ${validItems.length} ảnh hợp lệ và ${invalidItems.length} file không hợp lệ.`,
          details,
          buttons: [
            { label: 'Hủy toàn bộ', value: 'cancel', autofocus: true },
            { label: `Chỉ nhập ${validItems.length} ảnh hợp lệ`, value: 'ok', className: 'btn-primary' }
          ]
        });
        if (choice !== 'ok') return;
      }

      const newSources = [];
      const newAssets = [];
      for (const it of validItems) {
        this.assetManager.registerSourceBinary(it.source.id, it.bytes, it.source.mime);
        newSources.push(it.source);
        newAssets.push({
          id: generateId('asset'),
          sourceId: it.source.id,
          name: it.source.name.replace(/\.[^.]+$/, '') || it.source.name,
          isRegion: false,
          region: { x: 0, y: 0, w: it.source.width, h: it.source.height }
        });
      }
      this.store.addSourcesAndAssets(`Nhập ${newSources.length} ảnh vào thư viện`, newSources, newAssets, []);
      showToast(`Đã nhập ${newSources.length} ảnh vào Thư viện (chưa đặt lên atlas).`, 'ok');
      return;
    }

    // Single valid image dropped directly onto a specific cell (Spec §5.2)
    if (directSingle && targetCell && items.length === 1) {
      if (!items[0].valid) {
        showToast(`File "${items[0].name}" không hợp lệ: ${items[0].error}`, 'error');
        return;
      }
      if (this.store.revision !== startRevision) {
        showToast('Lưới hoặc project đã thay đổi trong lúc giải mã — vui lòng thử lại.', 'warn');
        return;
      }
      const key = cellKey(targetCell.row, targetCell.col);
      if (!isCellInGrid(targetCell.row, targetCell.col, this.store.project.grid)) return;
      if (this.store.project.cells[key]) {
        const c = await showChoiceDialog({
          title: 'Xác nhận ghi đè ô đã có ảnh',
          message: `Ô (${targetCell.row + 1}, ${targetCell.col + 1}) đang có ảnh. Bạn muốn thay bằng "${items[0].name}" (dùng transform mặc định)?`,
          buttons: [
            { label: 'Hủy', value: 'cancel', autofocus: true },
            { label: 'Ghi đè', value: 'ok', className: 'btn-primary' }
          ]
        });
        if (c !== 'ok') return;
      }
      const it = items[0];
      this.assetManager.registerSourceBinary(it.source.id, it.bytes, it.source.mime);
      const aid = generateId('asset');
      this.store.addSourcesAndAssets(
        `Đặt ảnh vào ô (${targetCell.row + 1},${targetCell.col + 1})`,
        [it.source],
        [{ id: aid, sourceId: it.source.id, name: it.source.name.replace(/\.[^.]+$/, ''), isRegion: false, region: { x: 0, y: 0, w: it.source.width, h: it.source.height } }],
        [{ row: targetCell.row, col: targetCell.col, assetId: aid }]
      );
      this.selectCell(targetCell.row, targetCell.col);
      showToast(`Đã đặt "${it.name}" vào ô (${targetCell.row + 1}, ${targetCell.col + 1}).`, 'ok');
      return;
    }

    // Multiple images or batch fill -> Open Batch Import Preview Modal
    this.modals.openBatchImportModal(items, {
      startCell: targetCell || (this.activeCellKey ? parseCellKey(this.activeCellKey) : { row: 0, col: 0 }),
      mode: targetCell ? 'from-cursor-row' : (this.store.project.presetId ? 'preset-expected' : 'from-cursor-row')
    });
  }

  async handleDropLibraryAssetsOnCell(assetIds, targetCell) {
    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;
    const assets = assetIds.map((id) => this.store.getAsset(id)).filter(Boolean);
    if (assets.length === 0) return;

    if (assets.length === 1) {
      const key = cellKey(targetCell.row, targetCell.col);
      if (this.store.project.cells[key]) {
        const c = await showChoiceDialog({
          title: 'Xác nhận ghi đè ô đã có ảnh',
          message: `Ô (${targetCell.row + 1}, ${targetCell.col + 1}) đang có ảnh. Ghi đè bằng "${assets[0].name}"?`,
          buttons: [
            { label: 'Hủy', value: 'cancel', autofocus: true },
            { label: 'Ghi đè', value: 'ok', className: 'btn-primary' }
          ]
        });
        if (c !== 'ok') return;
      }
      this.store.addSourcesAndAssets(
        `Đặt "${assets[0].name}" vào ô (${targetCell.row + 1},${targetCell.col + 1})`,
        [],
        [],
        [{ row: targetCell.row, col: targetCell.col, assetId: assets[0].id }]
      );
      this.selectCell(targetCell.row, targetCell.col);
      return;
    }

    const batchItems = assets.map((a, i) => ({
      id: a.id,
      assetId: a.id,
      name: a.name,
      importIndex: i,
      valid: true
    }));
    this.modals.openBatchImportModal(batchItems, {
      startCell: targetCell,
      mode: 'from-cursor-row',
      isLibraryAssets: true
    });
  }

  promptImportSingleImageForCell(row, col) {
    const inp = $('file-import-single');
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      await this.handleIncomingFiles([f], { targetCell: { row, col }, directSingle: true });
    };
    inp.click();
  }

  // =========================================================================
  // CELL MOVE / SWAP / COPY / PASTE / CONTEXT MENU (Spec §8)
  // =========================================================================
  async handleCellDropMoveOrCopy(fromKey, toKey, isCopy) {
    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;
    if (isCopy && this.store.project.cells[toKey]) {
      const toPos = parseCellKey(toKey);
      const c = await showChoiceDialog({
        title: 'Xác nhận ghi đè khi sao chép ô',
        message: `Ô đích (${toPos.row + 1}, ${toPos.col + 1}) đã có ảnh. Bạn có muốn ghi đè bằng bản sao?`,
        buttons: [
          { label: 'Hủy', value: 'cancel', autofocus: true },
          { label: 'Ghi đè', value: 'ok', className: 'btn-primary' }
        ]
      });
      if (c !== 'ok') return;
    }
    this.store.moveOrSwapCell(fromKey, toKey, { copy: isCopy });
    const toPos = parseCellKey(toKey);
    this.selectCell(toPos.row, toPos.col);
  }

  copySelectedCells() {
    const coords = [...this.selectedCells]
      .map(parseCellKey)
      .filter(Boolean)
      .filter((p) => Boolean(this.store.project.cells[cellKey(p.row, p.col)]));
    if (coords.length === 0) {
      showToast('Không có ô chứa ảnh nào được chọn để sao chép.', 'warn');
      return;
    }
    const minR = Math.min(...coords.map((p) => p.row));
    const minC = Math.min(...coords.map((p) => p.col));
    this.clipboard = {
      type: 'cells',
      items: coords.map((p) => ({
        dr: p.row - minR,
        dc: p.col - minC,
        cell: deepClone(this.store.project.cells[cellKey(p.row, p.col)])
      }))
    };
    showToast(`Đã sao chép ${coords.length} ô vào clipboard nội bộ.`, 'info', 2000);
  }

  copyActiveTransform() {
    const cell = this.activeCellKey ? this.store.project.cells[this.activeCellKey] : null;
    if (!cell) { showToast('Ô hiện tại trống.', 'warn'); return; }
    this.clipboard = {
      type: 'transform',
      transform: {
        fitMode: cell.fitMode,
        alphaThreshold: cell.alphaThreshold,
        zoom: cell.zoom,
        offsetX: cell.offsetX,
        offsetY: cell.offsetY
      }
    };
    showToast('Đã sao chép thông số căn chỉnh (fitMode, zoom, offset).', 'info', 2000);
  }

  async pasteClipboard() {
    if (!this.clipboard) {
      showToast('Clipboard nội bộ đang trống.', 'info');
      return;
    }
    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;

    if (this.clipboard.type === 'transform') {
      const updates = {};
      for (const k of this.selectedCells) {
        const existing = this.store.project.cells[k];
        if (!existing) continue;
        updates[k] = { ...deepClone(existing), ...deepClone(this.clipboard.transform) };
      }
      if (Object.keys(updates).length === 0) {
        showToast('Chọn ít nhất 1 ô có ảnh để dán căn chỉnh.', 'warn');
        return;
      }
      this.store.applyMultipleCellTransforms(updates, 'Dán căn chỉnh');
      showToast(`Đã dán căn chỉnh cho ${Object.keys(updates).length} ô.`, 'ok');
      return;
    }

    const grid = this.store.project.grid;
    let plan = [];
    let outOfBounds = 0;

    if (this.clipboard.items.length === 1 && this.selectedCells.size > 1) {
      // Single cell pasted into multiple selected cells (Spec §8)
      for (const k of this.selectedCells) {
        const p = parseCellKey(k);
        if (p) plan.push({ row: p.row, col: p.col, cell: this.clipboard.items[0].cell });
      }
    } else {
      const anchor = this.activeCellKey ? parseCellKey(this.activeCellKey) : { row: 0, col: 0 };
      for (const it of this.clipboard.items) {
        const r = anchor.row + it.dr;
        const c = anchor.col + it.dc;
        if (!isCellInGrid(r, c, grid)) {
          outOfBounds++;
        } else {
          plan.push({ row: r, col: c, cell: it.cell });
        }
      }
    }

    const overwriteCount = plan.filter((p) => Boolean(this.store.project.cells[cellKey(p.row, p.col)])).length;
    if (overwriteCount > 0 || outOfBounds > 0 || plan.length > 1) {
      const details = [];
      if (overwriteCount > 0) details.push(`Sẽ ghi đè ${overwriteCount} ô đã có ảnh.`);
      if (outOfBounds > 0) details.push(`${outOfBounds} ô nằm ngoài biên lưới sẽ bị bỏ qua.`);
      const choice = await showChoiceDialog({
        title: `Xác nhận dán ${plan.length} ô`,
        message: 'Kiểm tra vùng dán trước khi thực hiện:',
        details,
        buttons: [
          { label: 'Hủy', value: 'cancel', autofocus: true },
          { label: `Dán (${plan.length} ô)`, value: 'ok', className: 'btn-primary' }
        ]
      });
      if (choice !== 'ok') return;
    }

    this.store.pasteCells(plan);
    showToast(`Đã dán ${plan.length} ô.`, 'ok');
  }

  openContextMenu(x, y, row, col) {
    this._contextCell = { row, col, key: cellKey(row, col) };
    const menu = $('cell-context-menu');
    const hasImg = Boolean(this.store.project.cells[this._contextCell.key]);
    menu.querySelector('[data-ctx="clear"]').disabled = !hasImg;
    menu.querySelector('[data-ctx="copy"]').disabled = !hasImg;
    menu.querySelector('[data-ctx="copy-transform"]').disabled = !hasImg;
    menu.querySelector('[data-ctx="duplicate"]').disabled = !hasImg;
    menu.querySelector('[data-ctx="swap"]').disabled = !hasImg;
    menu.querySelector('[data-ctx="set-ref"]').disabled = !hasImg;
    menu.querySelector('[data-ctx="paste"]').disabled = !this.clipboard || this.clipboard.type !== 'cells';
    menu.querySelector('[data-ctx="paste-transform"]').disabled = !this.clipboard || this.clipboard.type !== 'transform' || !hasImg;

    menu.classList.add('is-open');
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 280;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
  }

  hideContextMenu() {
    $('cell-context-menu')?.classList.remove('is-open');
  }

  // =========================================================================
  // SAVE / OPEN `.ssb` & EXPORT JOBS (Spec §10.2, §11.2)
  // =========================================================================
  async saveProject({ asCopy = false } = {}) {
    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;
    if (this.isJobRunning) return;

    const snapshot = deepClone(this.store.project);
    const revAtSave = this.store.revision;
    const abort = this.beginJob('Đang đóng gói file project .ssb...');

    try {
      const ssbBytes = await serializeProjectToSsb(
        snapshot,
        (id) => this.assetManager.getSourceBytes(id),
        (done, total, msg) => this.updateJobProgress(done, total, msg)
      );
      if (abort.signal.aborted) {
        showToast('Đã hủy lưu project.', 'info');
        return;
      }

      const safeBase = sanitizeFilename(snapshot.name, 'project');
      const filename = asCopy ? `${safeBase}_copy.ssb` : `${safeBase}.ssb`;
      triggerBlobDownload(ssbBytes, filename, 'application/zip');

      if (!asCopy) {
        this.store.markDownloadRequested(revAtSave);
      }
      // Exact honest status per Spec §10.2!
      showToast('Đã tạo file lưu / đã yêu cầu tải xuống, hãy kiểm tra thư mục tải xuống.', 'ok', 5000);
    } catch (err) {
      if (!asCopy) this.store.markSaveFailed();
      showToast(`Lưu project thất bại: ${err.message || err}`, 'error', 6000);
    } finally {
      this.endJob();
    }
  }

  async openProjectFile(file) {
    const okDraft = await this.ensureDraftResolved();
    if (!okDraft) return;
    const okDirty = await this.ensureUnsavedProjectConfirmed('mở project khác');
    if (!okDirty) return;

    const abort = this.beginJob(`Đang đọc và kiểm tra "${file.name}"...`);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (abort.signal.aborted) return;

      const res = await deserializeProjectFromSsb(bytes, (done, total, msg) => {
        this.updateJobProgress(done, total, msg);
      });
      if (!res.ok) {
        await showChoiceDialog({
          title: 'Không thể mở file project .ssb',
          message: 'File project không hợp lệ hoặc bị hỏng. Phiên làm việc hiện tại vẫn được giữ nguyên:',
          details: res.errors,
          buttons: [{ label: 'Đóng', value: 'ok', autofocus: true }]
        });
        return;
      }

      // Verify real browser decode of every source before committing replacement!
      for (let i = 0; i < res.project.sources.length; i++) {
        if (abort.signal.aborted) return;
        const src = res.project.sources[i];
        this.updateJobProgress(i + 1, res.project.sources.length, `Đang xác thực ảnh nguồn ${i + 1}/${res.project.sources.length}...`);
        const bin = res.sourceBinaries.get(src.id);
        try {
          const bmp = await this.assetManager._decodeBytesToBitmap(bin.bytes, bin.mime);
          if (bmp.width !== src.width || bmp.height !== src.height) {
            if (typeof bmp.close === 'function') bmp.close();
            throw new Error(`Kích thước giải mã (${bmp.width}×${bmp.height}) không khớp manifest (${src.width}×${src.height}).`);
          }
          if (typeof bmp.close === 'function') bmp.close();
        } catch (decErr) {
          await showChoiceDialog({
            title: 'Lỗi giải mã nguồn ảnh trong .ssb',
            message: `Nguồn "${src.name}" bị lỗi giải mã. Project hiện tại được giữ nguyên.`,
            details: [decErr.message || String(decErr)],
            buttons: [{ label: 'Đóng', value: 'ok', autofocus: true }]
          });
          return;
        }
      }

      this._loadDeserializedProject(res.project, res.sourceBinaries, { markClean: true });
      showToast(`Đã mở project "${res.project.name}" thành công.`, 'ok');
    } catch (err) {
      showToast(`Lỗi mở project: ${err.message || err}`, 'error', 6000);
    } finally {
      this.endJob();
    }
  }

  _loadDeserializedProject(project, sourceBinaries, { markClean = true } = {}) {
    this.assetManager.clearAllBitmaps();
    this.assetManager.pixelAnalysisCache.clear();
    for (const [id, rec] of sourceBinaries.entries()) {
      this.assetManager.registerSourceBinary(id, rec.bytes, rec.mime);
    }
    this.referenceCellKey = null;
    this.selectedCells = new Set(['0:0']);
    this.activeCellKey = '0:0';
    this.selectedLibAssets.clear();
    this.store.loadProject(project, { markClean });
    this.atlasView.fitToViewport();
  }

  async runExportJob(config) {
    if (this.isJobRunning) return;
    const snapshot = deepClone(this.store.project);
    const abort = this.beginJob('Đang chuẩn bị xuất tài nguyên...');

    try {
      const result = await executeExportJob(snapshot, this.assetManager, config, {
        signal: abort.signal,
        customEncoder: this.customExportEncoder,
        onProgress: (done, total, msg) => this.updateJobProgress(done, total, msg)
      });

      if (abort.signal.aborted) {
        showToast('Đã hủy xuất tài nguyên — không tạo file tải xuống.', 'info');
        return null;
      }

      triggerBlobDownload(result.bytes, result.filename, result.mime);
      // Note: Exporting images NEVER marks the project as saved (Spec §10.2, T27)!
      showToast(`Đã xuất "${result.filename}" (${(result.bytes.byteLength / 1024).toFixed(1)} KiB).`, 'ok', 4500);
      return result;
    } catch (err) {
      if (err?.message === 'CANCELLED') {
        showToast('Đã hủy xuất tài nguyên — không tạo file tải xuống.', 'info');
        return null;
      }
      showToast(`Xuất thất bại: ${err.message || err}`, 'error', 6500);
      return null;
    } finally {
      this.endJob();
    }
  }

  // =========================================================================
  // JOB PROGRESS BAR & CANCEL CONTROL (Spec §3.5, §11.2)
  // =========================================================================
  beginJob(message) {
    this.isJobRunning = true;
    this.activeAbortController = new AbortController();
    $('status-progress-wrap').classList.remove('hidden');
    $('status-progress-text').textContent = message;
    $('status-progress-bar').removeAttribute('value');
    $('btn-export').disabled = true;
    $('btn-save-project').disabled = true;
    $('btn-undo').disabled = true;
    $('btn-redo').disabled = true;
    return this.activeAbortController;
  }

  updateJobProgress(done, total, message) {
    $('status-progress-text').textContent = message;
    const bar = $('status-progress-bar');
    if (total > 0) {
      bar.max = total;
      bar.value = Math.min(done, total);
    }
  }

  endJob() {
    this.isJobRunning = false;
    this.activeAbortController = null;
    $('status-progress-wrap').classList.add('hidden');
    $('btn-export').disabled = false;
    $('btn-save-project').disabled = false;
    $('btn-undo').disabled = !this.store.canUndo();
    $('btn-redo').disabled = !this.store.canRedo();
  }

  // =========================================================================
  // TOOLBAR, PANEL RESIZERS, COLLAPSERS & GLOBAL SHORTCUTS
  // =========================================================================
  _bindToolbarAndPanels() {
    // Cancel active job
    $('btn-cancel-job').addEventListener('click', () => {
      if (this.activeAbortController) {
        this.activeAbortController.abort();
      }
    });

    // Project name edit
    $('project-name-input').addEventListener('change', (e) => {
      const val = e.target.value.trim();
      if (!val) { e.target.value = this.store.project.name; return; }
      if (val !== this.store.project.name) {
        this.store.commit('Đổi tên project', (p) => { p.name = val; });
      }
    });

    // New / Open / Save / Save Copy
    $('btn-new-project').addEventListener('click', async () => {
      const okDraft = await this.ensureDraftResolved();
      if (!okDraft) return;
      const okDirty = await this.ensureUnsavedProjectConfirmed('tạo project mới');
      if (!okDirty) return;
      this.assetManager.clearAllBitmaps();
      this.assetManager.pixelAnalysisCache.clear();
      this.referenceCellKey = null;
      this.selectedCells = new Set(['0:0']);
      this.activeCellKey = '0:0';
      this.selectedLibAssets.clear();
      this.store.loadProject(createEmptyProject('Project mới'), { markClean: true });
      this.atlasView.fitToViewport();
      showToast('Đã tạo project mới (4×4, ô 192×208 px).', 'info');
    });

    $('btn-open-project').addEventListener('click', () => {
      const inp = $('file-open-project');
      inp.value = '';
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (f) await this.openProjectFile(f);
      };
      inp.click();
    });

    $('btn-save-project').addEventListener('click', () => this.saveProject({ asCopy: false }));
    $('btn-save-copy').addEventListener('click', () => this.saveProject({ asCopy: true }));

    // Undo / Redo
    $('btn-undo').addEventListener('click', async () => {
      const okDraft = await this.ensureDraftResolved();
      if (!okDraft) return;
      const e = this.store.undo();
      if (e) showToast(`Hoàn tác: ${e.label}`, 'info', 1800);
    });
    $('btn-redo').addEventListener('click', async () => {
      const okDraft = await this.ensureDraftResolved();
      if (!okDraft) return;
      const e = this.store.redo();
      if (e) showToast(`Làm lại: ${e.label}`, 'info', 1800);
    });

    // Modals buttons
    $('btn-presets').addEventListener('click', () => this.modals.openPresetsModal());
    $('btn-preflight').addEventListener('click', () => this.modals.openPreflightModal());
    $('status-preflight-btn').addEventListener('click', () => this.modals.openPreflightModal());
    $('btn-settings').addEventListener('click', () => this.modals.openSettingsModal());
    $('btn-export').addEventListener('click', () => this.modals.openExportModal());
    $('btn-open-sync').addEventListener('click', () => this.modals.openTransformSyncModal());

    // Library controls
    $('btn-lib-import').addEventListener('click', () => {
      const inp = $('file-import-images');
      inp.value = '';
      inp.onchange = async () => {
        const files = Array.from(inp.files || []);
        if (files.length > 0) await this.handleIncomingFiles(files, { libraryOnly: true });
      };
      inp.click();
    });

    $('btn-lib-slice').addEventListener('click', () => {
      const selAssetId = [...this.selectedLibAssets][0];
      const selAsset = selAssetId ? this.store.getAsset(selAssetId) : null;
      this.modals.openSliceModal(selAsset?.sourceId || null);
    });

    $('btn-lib-fill').addEventListener('click', async () => {
      const okDraft = await this.ensureDraftResolved();
      if (!okDraft) return;
      const ids = this.selectedLibAssets.size > 0
        ? [...this.selectedLibAssets]
        : this.store.project.assets.map((a) => a.id);
      const assets = ids.map((id) => this.store.getAsset(id)).filter(Boolean);
      if (assets.length === 0) {
        showToast('Thư viện chưa có ảnh để điền vào lưới.', 'warn');
        return;
      }
      const batchItems = assets.map((a, i) => ({
        id: a.id,
        assetId: a.id,
        name: a.name,
        importIndex: i,
        valid: true
      }));
      this.modals.openBatchImportModal(batchItems, {
        isLibraryAssets: true,
        mode: this.store.project.presetId ? 'preset-expected' : 'from-cursor-row'
      });
    });

    $('lib-search').addEventListener('input', () => this.renderLibrary());
    $('lib-filter').addEventListener('change', () => this.renderLibrary());
    $('lib-sort').addEventListener('change', () => this.renderLibrary());

    // Library dropzone (imports to library without auto-filling atlas)
    const libPanel = $('panel-left');
    libPanel.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    libPanel.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) await this.handleIncomingFiles(files, { libraryOnly: true });
    });

    // Grid inputs & Apply
    for (const id of ['grid-cols', 'grid-rows', 'grid-cell-w', 'grid-cell-h']) {
      $(id).addEventListener('input', () => this._updateGridPreviewInfo());
    }
    $('btn-grid-apply').addEventListener('click', async () => {
      const okDraft = await this.ensureDraftResolved();
      if (!okDraft) return;
      const newGrid = {
        cols: parseInt($('grid-cols').value, 10),
        rows: parseInt($('grid-rows').value, 10),
        cellWidth: parseInt($('grid-cell-w').value, 10),
        cellHeight: parseInt($('grid-cell-h').value, 10)
      };
      const impact = this.store.previewGridChange(newGrid);
      if (!impact.validation.ok) {
        showToast(impact.validation.errors[0], 'error');
        return;
      }
      if (impact.needsConfirm) {
        const details = [];
        if (impact.removedCells.length > 0) details.push(`Sẽ xóa ${impact.removedCells.length} ô có ảnh nằm ngoài lưới mới.`);
        if (impact.removedAnimationSlots > 0) details.push(`Sẽ gỡ ${impact.removedAnimationSlots} slot animation ngoài biên (nhóm: ${impact.affectedAnimations.join(', ')}).`);
        const c = await showChoiceDialog({
          title: 'Xác nhận thu nhỏ lưới',
          message: 'Thu nhỏ lưới sẽ xóa dữ liệu nằm ngoài phạm vi mới (có thể Undo hoàn toàn bằng Ctrl+Z):',
          details,
          buttons: [
            { label: 'Hủy', value: 'cancel', autofocus: true },
            { label: 'Áp dụng thay đổi lưới', value: 'ok', className: 'btn-danger' }
          ]
        });
        if (c !== 'ok') {
          this._syncAllUI();
          return;
        }
      }
      this.store.applyGridChange(newGrid);
      showToast(`Đã áp dụng lưới ${newGrid.cols}×${newGrid.rows} (ô ${newGrid.cellWidth}×${newGrid.cellHeight} px).`, 'ok');
    });

    // Atlas view toggles
    $('atlas-zoom').addEventListener('input', (e) => this.atlasView.setZoom(Number(e.target.value) / 100));
    $('btn-atlas-fit').addEventListener('click', () => this.atlasView.fitToViewport());
    $('btn-atlas-100').addEventListener('click', () => this.atlasView.setZoom(1));
    $('btn-toggle-grid').addEventListener('click', (e) => {
      this.atlasView.showGrid = !this.atlasView.showGrid;
      e.currentTarget.setAttribute('aria-pressed', String(this.atlasView.showGrid));
      this.atlasView.requestRender();
    });
    $('btn-toggle-labels').addEventListener('click', (e) => {
      this.atlasView.showLabels = !this.atlasView.showLabels;
      e.currentTarget.setAttribute('aria-pressed', String(this.atlasView.showLabels));
      this.atlasView.requestRender();
    });
    $('btn-toggle-guides').addEventListener('click', (e) => {
      this.atlasView.showGuides = !this.atlasView.showGuides;
      e.currentTarget.setAttribute('aria-pressed', String(this.atlasView.showGuides));
      this.atlasView.requestRender();
    });
    $('btn-toggle-checker').addEventListener('click', (e) => {
      this.atlasView.showChecker = !this.atlasView.showChecker;
      e.currentTarget.setAttribute('aria-pressed', String(this.atlasView.showChecker));
      this.atlasView.requestRender();
    });
    $('atlas-bg-color').addEventListener('input', (e) => {
      this.atlasView.previewBgColor = e.target.value;
      if (this.atlasView.showChecker) {
        this.atlasView.showChecker = false;
        $('btn-toggle-checker').setAttribute('aria-pressed', 'false');
      }
      this.atlasView.requestRender();
    });
    $('btn-toggle-marquee').addEventListener('click', (e) => {
      this.atlasView.marqueeMode = !this.atlasView.marqueeMode;
      e.currentTarget.setAttribute('aria-pressed', String(this.atlasView.marqueeMode));
    });

    // Context menu actions
    $('cell-context-menu').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-ctx]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.ctx;
      const target = this._contextCell;
      this.hideContextMenu();
      if (!target) return;

      if (action === 'replace') {
        const ok = await this.ensureDraftResolved();
        if (ok) this.promptImportSingleImageForCell(target.row, target.col);
      } else if (action === 'clear') {
        const ok = await this.ensureDraftResolved();
        if (ok) this.store.clearCells([...this.selectedCells]);
      } else if (action === 'copy') {
        this.copySelectedCells();
      } else if (action === 'paste') {
        await this.pasteClipboard();
      } else if (action === 'copy-transform') {
        this.copyActiveTransform();
      } else if (action === 'paste-transform') {
        await this.pasteClipboard();
      } else if (action === 'duplicate') {
        const ok = await this.ensureDraftResolved();
        if (!ok) return;
        const grid = this.store.project.grid;
        let dest = null;
        for (let r = target.row; r < grid.rows && !dest; r++) {
          const cStart = r === target.row ? target.col + 1 : 0;
          for (let c = cStart; c < grid.cols; c++) {
            if (!this.store.project.cells[cellKey(r, c)]) { dest = { row: r, col: c }; break; }
          }
        }
        if (!dest) { showToast('Không còn ô trống phía sau để nhân bản.', 'warn'); return; }
        this.store.moveOrSwapCell(target.key, cellKey(dest.row, dest.col), { copy: true });
        this.selectCell(dest.row, dest.col);
      } else if (action === 'swap') {
        const ok = await this.ensureDraftResolved();
        if (!ok) return;
        const rIn = el('input', { type: 'number', min: 1, max: this.store.project.grid.rows, value: target.row + 1, style: { width: '64px' } });
        const cIn = el('input', { type: 'number', min: 1, max: this.store.project.grid.cols, value: target.col + 1, style: { width: '64px' } });
        const ch = await showChoiceDialog({
          title: `Hoán đổi ô (${target.row + 1}, ${target.col + 1}) với...`,
          message: el('div', { className: 'form-row' }, [el('label', { text: 'Hàng:' }), rIn, el('label', { text: 'Cột:' }), cIn]),
          buttons: [{ label: 'Hủy', value: 'cancel' }, { label: 'Hoán đổi', value: 'ok', className: 'btn-primary', autofocus: true }]
        });
        if (ch === 'ok') {
          const dr = parseInt(rIn.value, 10) - 1;
          const dc = parseInt(cIn.value, 10) - 1;
          if (isCellInGrid(dr, dc, this.store.project.grid)) {
            this.store.moveOrSwapCell(target.key, cellKey(dr, dc), { copy: false });
          } else {
            showToast('Tọa độ ô đích nằm ngoài lưới.', 'warn');
          }
        }
      } else if (action === 'set-ref') {
        this.setReferenceCell(target.key);
      } else if (action === 'add-to-anim') {
        const anim = this.animationView.getActiveAnimation();
        if (!anim) { showToast('Hãy tạo nhóm animation trước.', 'warn'); return; }
        const nextFrames = [...anim.frames, { row: target.row, col: target.col, durationMs: null }];
        this.store.updateAnimation(anim.id, { frames: nextFrames }, 'Thêm ô vào nhóm animation');
      }
    });

    // Panel collapse toggles
    const wireCollapse = (btnId, panelId, openSym, closedSym) => {
      $(btnId).addEventListener('click', () => {
        const p = $(panelId);
        const collapsed = p.classList.toggle('is-collapsed');
        $(btnId).setAttribute('aria-expanded', String(!collapsed));
        $(btnId).textContent = collapsed ? closedSym : openSym;
        this.atlasView.requestRender();
      });
    };
    wireCollapse('btn-collapse-left', 'panel-left', '◀', '▶');
    wireCollapse('btn-collapse-right', 'panel-right', '▶', '◀');
    wireCollapse('btn-collapse-bottom', 'panel-bottom', '▼', '▲');

    // Panel resize splitters
    this._wireVerticalSplitter('splitter-left', '--left-width', 180, 440, 1);
    this._wireVerticalSplitter('splitter-right', '--right-width', 240, 520, -1);
    this._wireHorizontalSplitter('splitter-bottom', '--bottom-height', 120, 400);
  }

  _wireVerticalSplitter(splitterId, cssVar, minW, maxW, dir) {
    const splitter = $(splitterId);
    let dragging = false;
    let startX = 0;
    let startW = 0;
    splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || minW;
      splitter.classList.add('is-dragging');
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const next = Math.max(minW, Math.min(maxW, startW + (e.clientX - startX) * dir));
      document.documentElement.style.setProperty(cssVar, `${next}px`);
      this.atlasView.requestRender();
    });
    splitter.addEventListener('pointerup', () => {
      dragging = false;
      splitter.classList.remove('is-dragging');
    });
  }

  _wireHorizontalSplitter(splitterId, cssVar, minH, maxH) {
    const splitter = $(splitterId);
    let dragging = false;
    let startY = 0;
    let startH = 0;
    splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || minH;
      splitter.classList.add('is-dragging');
      splitter.setPointerCapture(e.pointerId);
    });
    splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const next = Math.max(minH, Math.min(maxH, startH - (e.clientY - startY)));
      document.documentElement.style.setProperty(cssVar, `${next}px`);
      this.atlasView.requestRender();
    });
    splitter.addEventListener('pointerup', () => {
      dragging = false;
      splitter.classList.remove('is-dragging');
    });
  }

  _bindGlobalEvents() {
    // Prevent browser from opening dropped files outside valid zones (Spec §5.1)
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => { e.preventDefault(); });

    // Close context menu on outside click
    window.addEventListener('click', (e) => {
      const menu = $('cell-context-menu');
      if (menu && menu.classList.contains('is-open') && !menu.contains(e.target)) {
        this.hideContextMenu();
      }
    });

    // Best-effort unsaved warning on close/reload (Spec §10.2, §10.3, T27)
    window.addEventListener('beforeunload', (e) => {
      if (this.store.isDirty || this.editorView.hasUnsavedDraft()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Keyboard shortcuts (Spec §8, T25) — NEVER hijack text editing in input/textarea/select!
    window.addEventListener('keydown', async (e) => {
      const mod = e.ctrlKey || e.metaKey;

      // Always intercept Ctrl+S and Ctrl+O in-app (never browser Save Webpage HTML)
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        await this.saveProject({ asCopy: e.shiftKey });
        return;
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        $('btn-open-project').click();
        return;
      }

      // If any modal dialog is open, let native dialog keyboard handling work
      if (document.querySelector('dialog[open]')) return;

      // Never intercept typing inside inputs/textareas/selects
      if (isTypingInField(e.target)) return;

      if (e.key === 'Escape') {
        this.hideContextMenu();
        if (this.editorView.pickingAnchor) {
          this.editorView.pickingAnchor = false;
          $('btn-ed-pick-anchor')?.setAttribute('aria-pressed', 'false');
          $('editor-canvas')?.classList.remove('is-picking-anchor');
        }
        return;
      }

      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        const ok = await this.ensureDraftResolved();
        if (ok) this.store.undo();
        return;
      }
      if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        const ok = await this.ensureDraftResolved();
        if (ok) this.store.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this.copySelectedCells();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        await this.pasteClipboard();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const ok = await this.ensureDraftResolved();
        if (ok) this.store.clearCells([...this.selectedCells]);
        return;
      }

      // Arrow keys: if an image cell is active and editor panel or stage focused -> nudge 1px / Shift 10px (or navigate grid if empty)
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;

        if (this.editorView.draft && (e.altKey || $('panel-right').contains(document.activeElement) || this.editorView.hasUnsavedDraft())) {
          e.preventDefault();
          this.editorView.nudge(dx, dy);
          return;
        }
        // If atlas focused and active cell has image & user nudges? Let arrow navigate grid unless Shift/editor active, OR nudge if editor has focus.
        // Wait: Spec §6.1 says "mũi tên dịch 1 px, Shift + mũi tên dịch 10 px" in editor; §3.5 says keyboard navigation on grid.
        if (this.editorView.draft && document.activeElement !== $('atlas-stage-wrap')) {
          e.preventDefault();
          this.editorView.nudge(dx, dy);
          return;
        }
        // Grid navigation when atlas stage is focused
        if (document.activeElement === $('atlas-stage-wrap')) {
          e.preventDefault();
          const cur = parseCellKey(this.activeCellKey) || { row: 0, col: 0 };
          const nr = Math.max(0, Math.min(this.store.project.grid.rows - 1, cur.row + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)));
          const nc = Math.max(0, Math.min(this.store.project.grid.cols - 1, cur.col + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)));
          const ok = await this.ensureDraftResolved();
          if (ok) {
            this.selectCell(nr, nc, { shift: e.shiftKey });
            this.atlasView.scrollToCell(nr, nc);
          }
        }
      }
    });
  }
}

// Bootstrap on DOMContentLoaded
if (typeof document !== 'undefined') {
  const boot = () => {
    window.__SSB_APP__ = new SpriteSheetBuilderApp();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
