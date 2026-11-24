/**
 * Sprite Sheet Builder V2.0 — Frame Editor Panel with Draft Isolation, Onion Skin,
 * Side-by-Side Reference, Fit Alpha, Custom Anchor Picker, and Keyboard Nudging (Spec §3.4, §6).
 */

import { LIMITS, deepClone, formatNumber, parseCellKey, cellKey } from '../core/constants.js';
import { computeCellGeometry, computeAlignAnchorOffset, analyzeRectInCell } from '../core/geometry.js';
import { drawCellOnContext, drawCheckerboard, drawCellGuides, drawAnchorMarker } from '../engine/renderer.js';
import { $, showToast } from './dom-helpers.js';

export class EditorView {
  constructor(app) {
    this.app = app;
    this.canvas = $('editor-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.refCanvas = $('editor-ref-canvas');
    this.refCtx = this.refCanvas.getContext('2d');

    this.cellKey = null;
    this.committedCell = null;
    this.draft = null;
    this.draftDirty = false;
    this.draftUndoStack = [];

    this.onionEnabled = false;
    this.onionOpacity = 0.4;
    this.sideBySide = false;
    this.pickingAnchor = false;

    this.previewScale = 1; // display CSS px per output pixel
    this.dragState = null;
    this._rafScheduled = false;

    this._bindControls();
  }

  hasUnsavedDraft() {
    return Boolean(this.draftDirty && this.cellKey && this.draft);
  }

  getActiveGuides() {
    const p = this.app.store.project;
    // If editing within an active animation group that has guide override, apply it (Spec §10.1)
    const activeAnim = this.app.animationView?.getActiveAnimation?.();
    if (activeAnim && activeAnim.guides && this.cellKey) {
      const pos = parseCellKey(this.cellKey);
      if (pos && activeAnim.frames.some((f) => f.row === pos.row && f.col === pos.col)) {
        return activeAnim.guides;
      }
    }
    return p.settings.guides;
  }

  loadCell(key) {
    this.cellKey = key;
    this.pickingAnchor = false;
    $('btn-ed-pick-anchor')?.setAttribute('aria-pressed', 'false');
    this.canvas.classList.remove('is-picking-anchor');

    const cell = key ? this.app.store.project.cells[key] : null;
    if (!cell) {
      this.committedCell = null;
      this.draft = null;
      this.draftDirty = false;
      this.draftUndoStack = [];
      $('editor-empty').classList.remove('hidden');
      $('editor-body').classList.add('hidden');
      $('editor-draft-bar').classList.add('hidden');
      return;
    }

    this.committedCell = deepClone(cell);
    this.draft = deepClone(cell);
    this.draftDirty = false;
    this.draftUndoStack = [];

    $('editor-empty').classList.add('hidden');
    $('editor-body').classList.remove('hidden');
    $('editor-draft-bar').classList.remove('hidden');

    this._syncInputsFromDraft();
    this._updateDraftBar();
    this._ensureAnalysisAndRender();
  }

  _pushDraftHistory() {
    if (!this.draft) return;
    this.draftUndoStack.push(deepClone(this.draft));
    if (this.draftUndoStack.length > 40) this.draftUndoStack.shift();
  }

  _markDraftDirty() {
    this.draftDirty = true;
    this._updateDraftBar();
    this.requestRender();
  }

  _updateDraftBar() {
    const bar = $('editor-draft-bar');
    const txt = $('draft-status-text');
    const btnUndo = $('btn-draft-undo');
    const btnCancel = $('btn-draft-cancel');
    const btnApply = $('btn-draft-apply');
    if (!bar) return;

    if (this.draftDirty) {
      bar.classList.add('is-draft-dirty');
      txt.textContent = 'Bản nháp chưa áp dụng';
      btnApply.disabled = false;
      btnCancel.disabled = false;
      btnUndo.disabled = this.draftUndoStack.length === 0;
    } else {
      bar.classList.remove('is-draft-dirty');
      txt.textContent = 'Đã đồng bộ';
      btnApply.disabled = true;
      btnCancel.disabled = true;
      btnUndo.disabled = true;
    }
  }

  applyDraft() {
    if (!this.cellKey || !this.draft || !this.draftDirty) return true;
    const pos = parseCellKey(this.cellKey);
    if (!pos) return false;
    // Validate Fit Alpha before commit
    if (this.draft.fitMode === 'alpha') {
      const asset = this.app.store.getAsset(this.draft.assetId);
      const analysis = asset ? this.app.assetManager.getCachedPixelAnalysis(asset, this.draft.alphaThreshold) : null;
      if (!analysis || !analysis.alphaBounds) {
        showToast('Không thể áp dụng Fit Alpha vì ảnh không có pixel vượt ngưỡng alpha.', 'error');
        return false;
      }
    }
    this.app.store.setCellTransform(pos.row, pos.col, this.draft, `Chỉnh frame (${pos.row + 1},${pos.col + 1})`);
    this.committedCell = deepClone(this.draft);
    this.draftDirty = false;
    this.draftUndoStack = [];
    this._updateDraftBar();
    showToast(`Đã áp dụng chỉnh sửa ô (${pos.row + 1}, ${pos.col + 1}).`, 'ok', 2000);
    return true;
  }

  discardDraft() {
    if (!this.committedCell) return;
    this.draft = deepClone(this.committedCell);
    this.draftDirty = false;
    this.draftUndoStack = [];
    this._syncInputsFromDraft();
    this._updateDraftBar();
    this.requestRender();
  }

  undoDraftStep() {
    if (this.draftUndoStack.length === 0) return;
    this.draft = this.draftUndoStack.pop();
    this.draftDirty = JSON.stringify(this.draft) !== JSON.stringify(this.committedCell);
    this._syncInputsFromDraft();
    this._updateDraftBar();
    this.requestRender();
  }

  nudge(dx, dy) {
    if (!this.draft) return;
    this._pushDraftHistory();
    this.draft.offsetX += dx;
    this.draft.offsetY += dy;
    this._syncInputsFromDraft();
    this._markDraftDirty();
  }

  _syncInputsFromDraft() {
    if (!this.draft) return;
    const pos = parseCellKey(this.cellKey);
    $('editor-cell-caption').textContent = pos
      ? `Ô (${pos.row + 1}, ${pos.col + 1}) • ${this.app.store.project.grid.cellWidth}×${this.app.store.project.grid.cellHeight} px`
      : '';

    $('ed-fit-mode').value = this.draft.fitMode;
    $('ed-alpha-threshold').value = String(this.draft.alphaThreshold);
    $('ed-offset-x').value = formatNumber(this.draft.offsetX, 2);
    $('ed-offset-y').value = formatNumber(this.draft.offsetY, 2);
    const zoomPct = Math.round(this.draft.zoom * 1000) / 10;
    $('ed-zoom-range').value = String(Math.round(this.draft.zoom * 100));
    $('ed-zoom-num').value = formatNumber(zoomPct, 1);

    const anchorMode = this.draft.anchor?.mode || 'fit-center';
    $('ed-anchor-mode').value = anchorMode;
    const customRow = $('ed-custom-anchor-row');
    if (anchorMode === 'custom') {
      customRow.classList.remove('hidden');
      $('ed-anchor-x').value = formatNumber(this.draft.anchor.x ?? 0, 2);
      $('ed-anchor-y').value = formatNumber(this.draft.anchor.y ?? 0, 2);
    } else {
      customRow.classList.add('hidden');
    }

    const g = this.getActiveGuides();
    const grid = this.app.store.project.grid;
    if (!$('ed-align-tx').dataset.userEdited) {
      $('ed-align-tx').value = formatNumber(g.x * grid.cellWidth, 1);
      $('ed-align-ty').value = formatNumber(g.y * grid.cellHeight, 1);
    }
  }

  _ensureAnalysisAndRender() {
    if (!this.draft) return;
    const asset = this.app.store.getAsset(this.draft.assetId);
    const source = asset ? this.app.store.getSource(asset.sourceId) : null;
    if (!asset || !source) return;

    const projId = this.app.store.project.projectId;
    Promise.all([
      this.app.assetManager.getAssetDrawable(asset, source),
      this.app.assetManager.analyzeAssetPixels(asset, source, this.draft.alphaThreshold)
    ]).then(() => {
      if (this.app.store.project.projectId === projId) {
        this.requestRender();
      }
    }).catch(() => {});

    // Also decode reference cell if set
    if (this.app.referenceCellKey) {
      const refCell = this.app.store.project.cells[this.app.referenceCellKey];
      if (refCell) {
        const ra = this.app.store.getAsset(refCell.assetId);
        const rs = ra ? this.app.store.getSource(ra.sourceId) : null;
        if (ra && rs) {
          Promise.all([
            this.app.assetManager.getAssetDrawable(ra, rs),
            this.app.assetManager.analyzeAssetPixels(ra, rs, refCell.alphaThreshold)
          ]).then(() => {
            if (this.app.store.project.projectId === projId) this.requestRender();
          }).catch(() => {});
        }
      }
    }
    this.requestRender();
  }

  requestRender() {
    if (this._rafScheduled) return;
    this._rafScheduled = true;
    requestAnimationFrame(() => {
      this._rafScheduled = false;
      this.render();
    });
  }

  render() {
    if (!this.draft || !this.cellKey) return;
    const project = this.app.store.project;
    const { cellWidth, cellHeight } = project.grid;
    const asset = this.app.store.getAsset(this.draft.assetId);
    const source = asset ? this.app.store.getSource(asset.sourceId) : null;
    if (!asset || !source) return;

    const dpr = window.devicePixelRatio || 1;
    const maxBoxW = this.sideBySide ? 180 : 280;
    const maxBoxH = 260;
    const scale = Math.min(maxBoxW / cellWidth, maxBoxH / cellHeight);
    this.previewScale = scale;

    const cssW = Math.max(40, Math.round(cellWidth * scale));
    const cssH = Math.max(40, Math.round(cellHeight * scale));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, cellWidth, cellHeight);

    drawCheckerboard(ctx, 0, 0, cellWidth, cellHeight, Math.max(6, Math.round(10 / scale)));

    const analysis = this.app.assetManager.getCachedPixelAnalysis(asset, this.draft.alphaThreshold);
    const alphaBounds = analysis?.alphaBounds || null;
    const drawable = this.app.assetManager.getAssetDrawableSync(asset, source);

    // Draw Onion Skin (reference frame behind or blended over, exact same cell coordinates, Spec §6.4)
    const refCell = this.app.referenceCellKey ? project.cells[this.app.referenceCellKey] : null;
    if (this.onionEnabled && refCell) {
      const ra = this.app.store.getAsset(refCell.assetId);
      const rs = ra ? this.app.store.getSource(ra.sourceId) : null;
      const rDraw = ra && rs ? this.app.assetManager.getAssetDrawableSync(ra, rs) : null;
      const rAnal = ra ? this.app.assetManager.getCachedPixelAnalysis(ra, refCell.alphaThreshold) : null;
      if (rDraw) {
        drawCellOnContext(ctx, {
          cellWidth,
          cellHeight,
          region: ra.region,
          transform: refCell,
          alphaBounds: rAnal?.alphaBounds || null,
          drawable: rDraw,
          smoothing: project.settings.smoothing,
          globalAlpha: this.onionOpacity
        });
      }
    }

    let geom = null;
    if (drawable) {
      geom = drawCellOnContext(ctx, {
        cellWidth,
        cellHeight,
        region: asset.region,
        transform: this.draft,
        alphaBounds,
        drawable,
        smoothing: project.settings.smoothing
      });
    }

    // Guides & Anchor overlay
    const guides = this.getActiveGuides();
    drawCellGuides(ctx, 0, 0, cellWidth, cellHeight, guides, scale);

    if (geom && Number.isFinite(geom.anchorOutX) && Number.isFinite(geom.anchorOutY)) {
      drawAnchorMarker(ctx, 0, 0, geom.anchorOutX, geom.anchorOutY, scale, '#22c55e');
    }

    // Clip boundary indicator
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0.5 / scale, 0.5 / scale, cellWidth - 1 / scale, cellHeight - 1 / scale);

    // Update Source Info text
    const r = asset.region;
    const alphaText = geom?.renderedAlphaRect
      ? `Nội dung hiển thị: ${formatNumber(geom.renderedAlphaRect.w, 1)}×${formatNumber(geom.renderedAlphaRect.h, 1)} px`
      : (analysis?.allTransparent ? 'Nguồn toàn trong suốt (alpha=0)' : 'Chưa có alpha bounds');
    $('editor-source-info').textContent =
      `${source.name} (${source.width}×${source.height} px) • Vùng: (${r.x},${r.y},${r.w}×${r.h}) • ${alphaText}`;

    // Editor Warnings
    const warnBox = $('editor-warnings');
    const warns = [];
    if (analysis?.allTransparent) {
      warns.push('Ảnh nguồn hoàn toàn trong suốt (alpha = 0).');
    } else if (geom && analysis?.visibleBounds) {
      const vb = analysis.visibleBounds;
      const visRect = {
        x: geom.localX + vb.x * geom.scale,
        y: geom.localY + vb.y * geom.scale,
        w: vb.w * geom.scale,
        h: vb.h * geom.scale
      };
      const chk = analyzeRectInCell(visRect, cellWidth, cellHeight);
      if (chk.completelyOutside) warns.push('Nhân vật đang nằm hoàn toàn ngoài khung ô!');
      else if (chk.clipped) warns.push('Có phần nội dung nhìn thấy vượt biên ô (sẽ bị clip khi xuất).');
    }
    if (warns.length > 0) {
      warnBox.textContent = warns.join(' ');
      warnBox.classList.remove('hidden');
    } else {
      warnBox.classList.add('hidden');
    }

    // Reference Frame Info & Side-by-side Canvas (Spec §6.4)
    this._renderReferencePanel(refCell, cellWidth, cellHeight, dpr, project.settings.smoothing, guides);
  }

  _renderReferencePanel(refCell, cellWidth, cellHeight, dpr, smoothing, guides) {
    const refInfo = $('editor-ref-info');
    const sideBox = $('editor-ref-side-box');

    if (!this.app.referenceCellKey || !refCell) {
      refInfo.textContent = 'Chưa chọn frame tham chiếu.';
      sideBox.classList.add('hidden');
      return;
    }

    const rpos = parseCellKey(this.app.referenceCellKey);
    const ra = this.app.store.getAsset(refCell.assetId);
    const rs = ra ? this.app.store.getSource(ra.sourceId) : null;
    if (!ra || !rs) {
      refInfo.textContent = 'Frame tham chiếu không hợp lệ.';
      sideBox.classList.add('hidden');
      return;
    }

    const rAnal = this.app.assetManager.getCachedPixelAnalysis(ra, refCell.alphaThreshold);
    const rGeom = computeCellGeometry({
      cellWidth,
      cellHeight,
      region: ra.region,
      transform: refCell,
      alphaBounds: rAnal?.alphaBounds || null
    });

    const alphaDim = rGeom?.renderedAlphaRect
      ? `${formatNumber(rGeom.renderedAlphaRect.w, 1)}×${formatNumber(rGeom.renderedAlphaRect.h, 1)} px`
      : '—';
    const anchorStr = rGeom && Number.isFinite(rGeom.anchorOutX)
      ? `(${formatNumber(rGeom.anchorOutX, 1)}, ${formatNumber(rGeom.anchorOutY, 1)})`
      : '—';
    refInfo.textContent =
      `Tham chiếu: Ô (${rpos.row + 1},${rpos.col + 1}) • Zoom ${formatNumber(refCell.zoom * 100, 1)}% • Vùng nội dung: ${alphaDim} • Anchor: ${anchorStr}`;

    if (this.sideBySide) {
      sideBox.classList.remove('hidden');
      const s = Math.min(160 / cellWidth, 220 / cellHeight);
      const cw = Math.max(40, Math.round(cellWidth * s));
      const ch = Math.max(40, Math.round(cellHeight * s));
      this.refCanvas.style.width = `${cw}px`;
      this.refCanvas.style.height = `${ch}px`;
      this.refCanvas.width = Math.round(cw * dpr);
      this.refCanvas.height = Math.round(ch * dpr);
      const rctx = this.refCtx;
      rctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
      drawCheckerboard(rctx, 0, 0, cellWidth, cellHeight, Math.max(6, Math.round(10 / s)));
      const rDraw = this.app.assetManager.getAssetDrawableSync(ra, rs);
      if (rDraw) {
        drawCellOnContext(rctx, {
          cellWidth,
          cellHeight,
          region: ra.region,
          transform: refCell,
          alphaBounds: rAnal?.alphaBounds || null,
          drawable: rDraw,
          smoothing
        });
      }
      drawCellGuides(rctx, 0, 0, cellWidth, cellHeight, guides, s);
      if (rGeom && Number.isFinite(rGeom.anchorOutX)) {
        drawAnchorMarker(rctx, 0, 0, rGeom.anchorOutX, rGeom.anchorOutY, s, '#a855f7');
      }
    } else {
      sideBox.classList.add('hidden');
    }
  }

  _bindControls() {
    // Drag on editor canvas (output-pixel accurate regardless of CSS zoom or DPR, Spec §7 & T03!)
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.draft || e.button !== 0) return;

      if (this.pickingAnchor) {
        const rect = this.canvas.getBoundingClientRect();
        const outX = (e.clientX - rect.left) / this.previewScale;
        const outY = (e.clientY - rect.top) / this.previewScale;
        const asset = this.app.store.getAsset(this.draft.assetId);
        if (!asset) return;
        const analysis = this.app.assetManager.getCachedPixelAnalysis(asset, this.draft.alphaThreshold);
        const geom = computeCellGeometry({
          cellWidth: this.app.store.project.grid.cellWidth,
          cellHeight: this.app.store.project.grid.cellHeight,
          region: asset.region,
          transform: this.draft,
          alphaBounds: analysis?.alphaBounds || null
        });
        if (!geom) return;
        const srcX = (outX - geom.localX) / geom.scale;
        const srcY = (outY - geom.localY) / geom.scale;
        if (srcX < 0 || srcY < 0 || srcX > asset.region.w || srcY > asset.region.h) {
          showToast('Điểm anchor tùy chỉnh phải nằm trong vùng ảnh nguồn.', 'warn');
          return;
        }
        this._pushDraftHistory();
        this.draft.anchor = { mode: 'custom', x: srcX, y: srcY };
        this.pickingAnchor = false;
        $('btn-ed-pick-anchor').setAttribute('aria-pressed', 'false');
        this.canvas.classList.remove('is-picking-anchor');
        this._syncInputsFromDraft();
        this._markDraftDirty();
        return;
      }

      this._pushDraftHistory();
      this.dragState = {
        startX: e.clientX,
        startY: e.clientY,
        origOffsetX: this.draft.offsetX,
        origOffsetY: this.draft.offsetY,
        moved: false
      };
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragState || !this.draft) return;
      const dxCss = e.clientX - this.dragState.startX;
      const dyCss = e.clientY - this.dragState.startY;
      if (Math.abs(dxCss) > 0 || Math.abs(dyCss) > 0) this.dragState.moved = true;
      // Exact conversion from CSS px to output px using previewScale!
      this.draft.offsetX = this.dragState.origOffsetX + dxCss / this.previewScale;
      this.draft.offsetY = this.dragState.origOffsetY + dyCss / this.previewScale;
      $('ed-offset-x').value = formatNumber(this.draft.offsetX, 2);
      $('ed-offset-y').value = formatNumber(this.draft.offsetY, 2);
      this._markDraftDirty();
    });

    this.canvas.addEventListener('pointerup', () => {
      if (this.dragState && !this.dragState.moved) {
        this.draftUndoStack.pop();
      }
      this.dragState = null;
    });

    // Fit Mode
    $('ed-fit-mode').addEventListener('change', async (e) => {
      if (!this.draft) return;
      const newMode = e.target.value;
      const asset = this.app.store.getAsset(this.draft.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (newMode === 'alpha' && asset && source) {
        const info = await this.app.assetManager.analyzeAssetPixels(asset, source, this.draft.alphaThreshold);
        if (!info.ok || !info.alphaBounds) {
          showToast('Ảnh không có pixel vượt ngưỡng alpha — không thể áp dụng Fit Alpha.', 'error');
          e.target.value = this.draft.fitMode;
          return;
        }
      }
      this._pushDraftHistory();
      this.draft.fitMode = newMode;
      this._markDraftDirty();
    });

    // Alpha threshold
    $('ed-alpha-threshold').addEventListener('change', async (e) => {
      if (!this.draft) return;
      const val = Math.round(Number(e.target.value));
      if (!Number.isInteger(val) || val < 0 || val > 254) {
        e.target.value = String(this.draft.alphaThreshold);
        showToast('Ngưỡng alpha phải là số nguyên từ 0 đến 254.', 'warn');
        return;
      }
      const asset = this.app.store.getAsset(this.draft.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (asset && source) {
        const info = await this.app.assetManager.analyzeAssetPixels(asset, source, val);
        if (this.draft.fitMode === 'alpha' && (!info.ok || !info.alphaBounds)) {
          showToast(`Với ngưỡng ${val} không còn pixel hợp lệ cho Fit Alpha.`, 'warn');
          e.target.value = String(this.draft.alphaThreshold);
          return;
        }
      }
      this._pushDraftHistory();
      this.draft.alphaThreshold = val;
      this._markDraftDirty();
    });

    // Numeric Offset X/Y
    $('ed-offset-x').addEventListener('change', (e) => {
      if (!this.draft) return;
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) { e.target.value = formatNumber(this.draft.offsetX, 2); return; }
      this._pushDraftHistory();
      this.draft.offsetX = v;
      this._markDraftDirty();
    });

    $('ed-offset-y').addEventListener('change', (e) => {
      if (!this.draft) return;
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) { e.target.value = formatNumber(this.draft.offsetY, 2); return; }
      this._pushDraftHistory();
      this.draft.offsetY = v;
      this._markDraftDirty();
    });

    // Zoom slider & number
    $('ed-zoom-range').addEventListener('input', (e) => {
      if (!this.draft) return;
      const pct = Number(e.target.value);
      if (!Number.isFinite(pct)) return;
      this.draft.zoom = Math.max(LIMITS.MIN_ZOOM, Math.min(LIMITS.MAX_ZOOM, pct / 100));
      $('ed-zoom-num').value = formatNumber(pct, 1);
      this._markDraftDirty();
    });

    $('ed-zoom-num').addEventListener('change', (e) => {
      if (!this.draft) return;
      const pct = Number(e.target.value);
      const minPct = LIMITS.MIN_ZOOM * 100;
      const maxPct = LIMITS.MAX_ZOOM * 100;
      if (!Number.isFinite(pct) || pct < minPct || pct > maxPct) {
        e.target.value = formatNumber(this.draft.zoom * 100, 1);
        showToast(`Zoom phải nằm trong ${minPct}%–${maxPct}%.`, 'warn');
        return;
      }
      this._pushDraftHistory();
      this.draft.zoom = pct / 100;
      $('ed-zoom-range').value = String(Math.round(pct));
      this._markDraftDirty();
    });

    // Center & Reset
    $('btn-ed-center').addEventListener('click', () => {
      if (!this.draft) return;
      this._pushDraftHistory();
      this.draft.offsetX = 0;
      this.draft.offsetY = 0;
      this._syncInputsFromDraft();
      this._markDraftDirty();
    });

    $('btn-ed-reset').addEventListener('click', () => {
      if (!this.draft) return;
      this._pushDraftHistory();
      this.draft.fitMode = 'contain';
      this.draft.zoom = 1;
      this.draft.offsetX = 0;
      this.draft.offsetY = 0;
      this.draft.anchor = { mode: 'fit-center' };
      this._syncInputsFromDraft();
      this._markDraftDirty();
    });

    // Anchor Mode & Custom Anchor coords
    $('ed-anchor-mode').addEventListener('change', async (e) => {
      if (!this.draft) return;
      const mode = e.target.value;
      const asset = this.app.store.getAsset(this.draft.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (mode === 'alpha-bottom-center' && asset && source) {
        const info = await this.app.assetManager.analyzeAssetPixels(asset, source, this.draft.alphaThreshold);
        if (!info.ok || !info.alphaBounds) {
          showToast('Không có alpha bounds hợp lệ cho Đáy giữa alpha.', 'warn');
          e.target.value = this.draft.anchor?.mode || 'fit-center';
          return;
        }
      }
      this._pushDraftHistory();
      if (mode === 'custom') {
        const cx = asset ? asset.region.w / 2 : 0;
        const cy = asset ? asset.region.h / 2 : 0;
        this.draft.anchor = { mode: 'custom', x: this.draft.anchor?.x ?? cx, y: this.draft.anchor?.y ?? cy };
      } else {
        this.draft.anchor = { mode };
      }
      this._syncInputsFromDraft();
      this._markDraftDirty();
    });

    $('ed-anchor-x').addEventListener('change', (e) => {
      if (!this.draft || this.draft.anchor?.mode !== 'custom') return;
      const asset = this.app.store.getAsset(this.draft.assetId);
      const v = Number(e.target.value);
      if (!asset || !Number.isFinite(v) || v < 0 || v > asset.region.w) {
        showToast(`Anchor X phải nằm trong 0–${asset?.region.w ?? 0}.`, 'warn');
        e.target.value = formatNumber(this.draft.anchor.x, 2);
        return;
      }
      this._pushDraftHistory();
      this.draft.anchor.x = v;
      this._markDraftDirty();
    });

    $('ed-anchor-y').addEventListener('change', (e) => {
      if (!this.draft || this.draft.anchor?.mode !== 'custom') return;
      const asset = this.app.store.getAsset(this.draft.assetId);
      const v = Number(e.target.value);
      if (!asset || !Number.isFinite(v) || v < 0 || v > asset.region.h) {
        showToast(`Anchor Y phải nằm trong 0–${asset?.region.h ?? 0}.`, 'warn');
        e.target.value = formatNumber(this.draft.anchor.y, 2);
        return;
      }
      this._pushDraftHistory();
      this.draft.anchor.y = v;
      this._markDraftDirty();
    });

    $('btn-ed-pick-anchor').addEventListener('click', () => {
      this.pickingAnchor = !this.pickingAnchor;
      $('btn-ed-pick-anchor').setAttribute('aria-pressed', String(this.pickingAnchor));
      this.canvas.classList.toggle('is-picking-anchor', this.pickingAnchor);
      if (this.pickingAnchor) {
        showToast('Click lên nhân vật trong khung xem trước để đặt điểm anchor tùy chỉnh.', 'info', 2600);
      }
    });

    const alignTo = async (axis, custom = false) => {
      if (!this.draft) return;
      const asset = this.app.store.getAsset(this.draft.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (!asset || !source) return;
      const info = await this.app.assetManager.analyzeAssetPixels(asset, source, this.draft.alphaThreshold);
      const grid = this.app.store.project.grid;
      const geom = computeCellGeometry({
        cellWidth: grid.cellWidth,
        cellHeight: grid.cellHeight,
        region: asset.region,
        transform: this.draft,
        alphaBounds: info?.alphaBounds || null
      });
      if (!geom || !geom.anchorSource) {
        showToast('Không xác định được anchor hiện tại của ô.', 'warn');
        return;
      }
      const g = this.getActiveGuides();
      const tx = custom ? Number($('ed-align-tx').value) : g.x * grid.cellWidth;
      const ty = custom ? Number($('ed-align-ty').value) : g.y * grid.cellHeight;
      const next = computeAlignAnchorOffset({
        cellWidth: grid.cellWidth,
        cellHeight: grid.cellHeight,
        centerX: geom.centerX,
        centerY: geom.centerY,
        scale: geom.scale,
        ax: geom.anchorSource.ax,
        ay: geom.anchorSource.ay,
        tx,
        ty,
        currentOffsetX: this.draft.offsetX,
        currentOffsetY: this.draft.offsetY,
        axis
      });
      if (!next) {
        showToast('Tọa độ đích không hợp lệ.', 'warn');
        return;
      }
      this._pushDraftHistory();
      this.draft.offsetX = next.offsetX;
      this.draft.offsetY = next.offsetY;
      this._syncInputsFromDraft();
      this._markDraftDirty();
    };

    $('btn-align-both').addEventListener('click', () => alignTo('both', false));
    $('btn-align-x').addEventListener('click', () => alignTo('x', false));
    $('btn-align-y').addEventListener('click', () => alignTo('y', false));
    $('btn-align-custom').addEventListener('click', () => alignTo('both', true));
    $('ed-align-tx').addEventListener('input', (e) => { e.target.dataset.userEdited = '1'; });
    $('ed-align-ty').addEventListener('input', (e) => { e.target.dataset.userEdited = '1'; });

    // Reference & Onion Skin
    $('btn-ref-set-current').addEventListener('click', () => {
      if (this.cellKey && this.app.store.project.cells[this.cellKey]) {
        this.app.setReferenceCell(this.cellKey);
      }
    });
    $('btn-ref-prev').addEventListener('click', () => this.app.setAdjacentReference(-1));
    $('btn-ref-next').addEventListener('click', () => this.app.setAdjacentReference(1));
    $('btn-ref-clear').addEventListener('click', () => this.app.setReferenceCell(null));

    $('ed-onion-enable').addEventListener('change', (e) => {
      this.onionEnabled = e.target.checked;
      this.requestRender();
    });
    $('ed-onion-opacity').addEventListener('input', (e) => {
      const pct = Number(e.target.value);
      this.onionOpacity = Math.max(0.1, Math.min(0.9, pct / 100));
      $('ed-onion-opacity-label').textContent = `${pct}%`;
      this.requestRender();
    });
    $('btn-ed-side-by-side').addEventListener('click', () => {
      this.sideBySide = !this.sideBySide;
      $('btn-ed-side-by-side').setAttribute('aria-pressed', String(this.sideBySide));
      this.requestRender();
    });

    // Replace image button
    $('btn-editor-replace-img').addEventListener('click', async () => {
      if (!this.cellKey) return;
      const ok = await this.app.ensureDraftResolved();
      if (!ok) return;
      const pos = parseCellKey(this.cellKey);
      if (pos) this.app.promptImportSingleImageForCell(pos.row, pos.col);
    });

    // Draft buttons
    $('btn-draft-apply').addEventListener('click', () => this.applyDraft());
    $('btn-draft-cancel').addEventListener('click', () => this.discardDraft());
    $('btn-draft-undo').addEventListener('click', () => this.undoDraftStep());
  }
}
