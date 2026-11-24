/**
 * Sprite Sheet Builder V2.0 — Frame Editor Panel with Draft Isolation, Per-Cell Eraser/Restore Brush,
 * Onion Skin, Side-by-Side Reference, Fit Alpha, Custom Anchor Picker, and Keyboard Nudging (Spec §3.4, §6).
 */

import { LIMITS, deepClone, formatNumber, parseCellKey } from '../core/constants.js';
import { computeCellGeometry, computeAlignAnchorOffset, analyzeRectInCell } from '../core/geometry.js';
import {
  hasCellMask,
  hasMaskStrokes,
  normalizeCellMask,
  getMaskSignature,
  roundMaskCoord,
  simplifyStrokePoints,
  checkMaskBudget,
  rasterizeMaskAlpha,
  rasterizeStrokeSegmentIntoAlpha
} from '../core/mask.js';
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

    // Edit tool mode: 'move' (default) | 'erase' | 'restore'
    this.toolMode = 'move';
    this.brushSize = LIMITS.DEFAULT_BRUSH_SIZE; // diameter in source px (1..128)
    this.viewZoom = 'fit'; // 'fit' | '1' | '1.5' | '2' | '3' | '4'

    this.previewScale = 1; // display CSS px per output pixel
    this._renderDpr = 1;
    this._pointerGeom = null; // actual geometry used to map pointer -> source px
    this.hoverOutPos = null; // { x, y } in cell output px for brush cursor overlay
    this.brushCursorRadiusCss = 0;

    this.dragState = null;
    this.brushState = null;

    // Reusable scratch buffers for 60fps live brush painting (sized to active crop only)
    this._liveMaskAlpha = null;
    this._liveMaskCanvas = null;
    this._liveMaskedCanvas = null;
    this._liveDims = null; // { w, h }
    this._liveDirty = false;
    this._liveFallbackSig = '';

    this._rafScheduled = false;
    this.renderCount = 0;

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

  _disposeLiveBrushBuffers() {
    if (this._liveMaskCanvas) {
      this._liveMaskCanvas.width = 0;
      this._liveMaskCanvas.height = 0;
      this._liveMaskCanvas = null;
    }
    if (this._liveMaskedCanvas) {
      this._liveMaskedCanvas.width = 0;
      this._liveMaskedCanvas.height = 0;
      this._liveMaskedCanvas = null;
    }
    this._liveMaskAlpha = null;
    this._liveDims = null;
    this._liveDirty = false;
    this._liveFallbackSig = '';
  }

  finishActiveInteraction() {
    if (this.brushState) {
      this._finishBrushStroke();
    }
    if (this.dragState) {
      if (!this.dragState.moved) {
        this.draftUndoStack.pop();
      }
      this.dragState = null;
    }
  }

  setToolMode(mode) {
    const valid = mode === 'erase' || mode === 'restore' ? mode : 'move';
    if (this.brushState) {
      this._finishBrushStroke();
    }
    if (this.dragState) {
      if (!this.dragState.moved) this.draftUndoStack.pop();
      this.dragState = null;
    }
    this.toolMode = valid;
    if (valid !== 'move' && this.pickingAnchor) {
      this.pickingAnchor = false;
      $('btn-ed-pick-anchor')?.setAttribute('aria-pressed', 'false');
      this.canvas.classList.remove('is-picking-anchor');
    }
    this._syncToolButtons();
    this.requestRender();
  }

  setBrushSize(size) {
    const n = Math.round(Number(size));
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(LIMITS.MIN_BRUSH_SIZE, Math.min(LIMITS.MAX_BRUSH_SIZE, n));
    this.brushSize = clamped;
    const rng = $('ed-brush-size-range');
    const num = $('ed-brush-size-num');
    if (rng) rng.value = String(clamped);
    if (num) num.value = String(clamped);
    this.requestRender();
  }

  _syncToolButtons() {
    const isBrush = this.toolMode === 'erase' || this.toolMode === 'restore';
    $('btn-ed-tool-move')?.setAttribute('aria-pressed', String(this.toolMode === 'move'));
    $('btn-ed-tool-erase')?.setAttribute('aria-pressed', String(this.toolMode === 'erase'));
    $('btn-ed-tool-restore')?.setAttribute('aria-pressed', String(this.toolMode === 'restore'));
    this.canvas.classList.toggle('is-brush-mode', isBrush);
    if (!isBrush) {
      this.canvas.classList.remove('is-brush-cursor-hidden');
      this.brushCursorRadiusCss = 0;
    }
  }

  _syncMaskStatusUI() {
    const badge = $('ed-mask-status');
    const btnClear = $('btn-ed-mask-clear');
    const count = hasCellMask(this.draft) ? this.draft.mask.strokes.length : 0;
    if (badge) {
      badge.textContent = count > 0 ? `${count} nét mặt nạ` : 'Chưa tẩy';
      badge.className = count > 0 ? 'badge badge-accent' : 'badge';
    }
    if (btnClear) {
      btnClear.disabled = count === 0;
    }
  }

  loadCell(key) {
    this.finishActiveInteraction();
    this._disposeLiveBrushBuffers();
    this.hoverOutPos = null;
    this.cellKey = key;
    this.pickingAnchor = false;
    $('btn-ed-pick-anchor')?.setAttribute('aria-pressed', 'false');
    this.canvas.classList.remove('is-picking-anchor');
    // Default back to Move mode when switching cells or selecting an empty cell
    this.toolMode = 'move';
    this._syncToolButtons();

    const cell = key ? this.app.store.project.cells[key] : null;
    if (!cell) {
      this.committedCell = null;
      this.draft = null;
      this.draftDirty = false;
      this.draftUndoStack = [];
      this._pointerGeom = null;
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
    if (this.draftUndoStack.length > 100) this.draftUndoStack.shift();
  }

  _markDraftDirty() {
    this.draftDirty = true;
    this._updateDraftBar();
    this._syncMaskStatusUI();
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
    this.finishActiveInteraction();
    if (!this.cellKey || !this.draft || !this.draftDirty) return true;
    const pos = parseCellKey(this.cellKey);
    if (!pos) return false;

    const cleanDraft = deepClone(this.draft);
    const normMask = normalizeCellMask(cleanDraft.mask);
    if (normMask) cleanDraft.mask = normMask;
    else delete cleanDraft.mask;

    // Validate mask budgets before commit
    if (cleanDraft.mask) {
      const budget = checkMaskBudget(this.app.store.project, this.cellKey, cleanDraft.mask);
      if (!budget.ok) {
        showToast(budget.message, 'error');
        return false;
      }
    }

    // Validate Fit Alpha before commit:
    // - Unmasked transparent image still blocks Fit Alpha (Spec §6.2, T12).
    // - Cell erased to empty WITH mask is allowed and exports transparently with warning (E05).
    if (cleanDraft.fitMode === 'alpha') {
      const asset = this.app.store.getAsset(cleanDraft.assetId);
      const analysis = asset
        ? this.app.assetManager.getCachedCellPixelAnalysis(asset, cleanDraft.alphaThreshold, cleanDraft.mask)
        : null;
      if (!analysis || !analysis.alphaBounds) {
        if (!hasCellMask(cleanDraft)) {
          showToast('Không thể áp dụng Fit Alpha vì ảnh không có pixel vượt ngưỡng alpha.', 'error');
          return false;
        }
        showToast('Ô đã bị tẩy hết phần nhìn thấy — sẽ xuất trong suốt (vẫn có thể Khôi phục hoặc Bỏ toàn bộ vết tẩy).', 'warn', 4200);
      }
    }

    this.app.store.setCellTransform(pos.row, pos.col, cleanDraft, `Chỉnh frame (${pos.row + 1},${pos.col + 1})`);
    this.draft = deepClone(cleanDraft);
    this.committedCell = deepClone(cleanDraft);
    this.draftDirty = false;
    this.draftUndoStack = [];
    this._disposeLiveBrushBuffers();
    this._updateDraftBar();
    this._syncMaskStatusUI();
    showToast(`Đã áp dụng chỉnh sửa ô (${pos.row + 1}, ${pos.col + 1}).`, 'ok', 2000);
    return true;
  }

  discardDraft() {
    this.finishActiveInteraction();
    this._disposeLiveBrushBuffers();
    if (!this.committedCell) return;
    this.draft = deepClone(this.committedCell);
    this.draftDirty = false;
    this.draftUndoStack = [];
    this._syncInputsFromDraft();
    this._updateDraftBar();
    this._ensureAnalysisAndRender();
  }

  undoDraftStep() {
    this.finishActiveInteraction();
    if (this.draftUndoStack.length === 0) return;
    this.draft = this.draftUndoStack.pop();
    this.draftDirty = JSON.stringify(this.draft) !== JSON.stringify(this.committedCell);
    this._disposeLiveBrushBuffers();
    this._syncInputsFromDraft();
    this._updateDraftBar();
    this._ensureAnalysisAndRender();
  }

  clearAllMaskStrokes() {
    this.finishActiveInteraction();
    if (!this.draft || !hasCellMask(this.draft)) return;
    this._pushDraftHistory();
    delete this.draft.mask;
    this._disposeLiveBrushBuffers();
    this._syncInputsFromDraft();
    this._markDraftDirty();
    this._ensureAnalysisAndRender();
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

    this._syncMaskStatusUI();
  }

  _ensureAnalysisAndRender() {
    if (!this.draft) return;
    const asset = this.app.store.getAsset(this.draft.assetId);
    const source = asset ? this.app.store.getSource(asset.sourceId) : null;
    if (!asset || !source) return;

    const projId = this.app.store.project.projectId;
    const maskSnap = this.draft.mask;
    const thrSnap = this.draft.alphaThreshold;

    Promise.all([
      this.app.assetManager.getAssetDrawable(asset, source),
      this.app.assetManager.getCellDrawable(asset, source, maskSnap),
      this.app.assetManager.analyzeCellPixels(asset, source, thrSnap, maskSnap)
    ]).then(() => {
      if (this.app.store.project.projectId === projId) {
        this.requestRender();
      }
    }).catch(() => {});

    // Also decode reference cell if set (mask-aware)
    if (this.app.referenceCellKey) {
      const refCell = this.app.store.project.cells[this.app.referenceCellKey];
      if (refCell) {
        const ra = this.app.store.getAsset(refCell.assetId);
        const rs = ra ? this.app.store.getSource(ra.sourceId) : null;
        if (ra && rs) {
          Promise.all([
            this.app.assetManager.getCellDrawable(ra, rs, refCell.mask),
            this.app.assetManager.analyzeCellPixels(ra, rs, refCell.alphaThreshold, refCell.mask)
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

  _ensureLiveScratchBuffers(w, h) {
    if (this._liveDims && this._liveDims.w === w && this._liveDims.h === h && this._liveMaskCanvas && this._liveMaskedCanvas) {
      return;
    }
    this._disposeLiveBrushBuffers();
    this._liveMaskAlpha = new Uint8Array(w * h);
    this._liveMaskCanvas = document.createElement('canvas');
    this._liveMaskCanvas.width = w;
    this._liveMaskCanvas.height = h;
    this._liveMaskedCanvas = document.createElement('canvas');
    this._liveMaskedCanvas.width = w;
    this._liveMaskedCanvas.height = h;
    this._liveDims = { w, h };
  }

  _recompositeLiveMaskedCanvas(baseDrawable, w, h) {
    if (!this._liveMaskCanvas || !this._liveMaskedCanvas || !this._liveMaskAlpha) return;
    const mctx = this._liveMaskCanvas.getContext('2d', { alpha: true });
    const imgData = mctx.createImageData(w, h);
    const data = imgData.data;
    const alpha = this._liveMaskAlpha;
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i];
      if (a !== 0) {
        const o = i * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = a;
      }
    }
    mctx.putImageData(imgData, 0, 0);

    const octx = this._liveMaskedCanvas.getContext('2d', { alpha: true });
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, w, h);
    octx.imageSmoothingEnabled = false;
    const dr = baseDrawable.drawRegion;
    octx.drawImage(baseDrawable.bitmap, dr.x, dr.y, dr.w, dr.h, 0, 0, w, h);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(this._liveMaskCanvas, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    this._liveDirty = false;
  }

  _clientToOutputCoords(clientX, clientY, rect, canvasW, canvasH, renderDpr, previewScale) {
    const bx = (clientX - rect.left) * (canvasW / rect.width);
    const by = (clientY - rect.top) * (canvasH / rect.height);
    return {
      outX: bx / (renderDpr * previewScale),
      outY: by / (renderDpr * previewScale)
    };
  }

  _clientToSourcePoint(clientX, clientY, locked) {
    const { outX, outY } = this._clientToOutputCoords(
      clientX,
      clientY,
      locked.rect,
      locked.canvasW,
      locked.canvasH,
      locked.renderDpr,
      locked.previewScale
    );
    const localSrcX = (outX - locked.geom.localX) / locked.geom.scale;
    const localSrcY = (outY - locked.geom.localY) / locked.geom.scale;
    const rawSrcX = locked.region.x + localSrcX;
    const rawSrcY = locked.region.y + localSrcY;
    const clampedX = Math.max(locked.region.x, Math.min(locked.region.x + locked.region.w, rawSrcX));
    const clampedY = Math.max(locked.region.y, Math.min(locked.region.y + locked.region.h, rawSrcY));
    return {
      outX,
      outY,
      localSrcX,
      localSrcY,
      rawSrcX,
      rawSrcY,
      srcX: roundMaskCoord(clampedX),
      srcY: roundMaskCoord(clampedY)
    };
  }

  _computeFallbackPointerGeom(cellWidth, cellHeight, region, transform) {
    return computeCellGeometry({
      cellWidth,
      cellHeight,
      row: 0,
      col: 0,
      region,
      transform: { ...transform, fitMode: 'contain' },
      alphaBounds: null
    });
  }

  render() {
    if (!this.draft || !this.cellKey) return;
    this.renderCount += 1;
    const project = this.app.store.project;
    const { cellWidth, cellHeight } = project.grid;
    const asset = this.app.store.getAsset(this.draft.assetId);
    const source = asset ? this.app.store.getSource(asset.sourceId) : null;
    if (!asset || !source) return;

    const dpr = window.devicePixelRatio || 1;
    const maxBoxW = this.sideBySide ? 180 : 280;
    const maxBoxH = 260;
    let scale;
    if (this.viewZoom === 'fit') {
      scale = Math.min(maxBoxW / cellWidth, maxBoxH / cellHeight);
    } else {
      const parsed = Number(this.viewZoom);
      scale = Number.isFinite(parsed) && parsed > 0 ? parsed : Math.min(maxBoxW / cellWidth, maxBoxH / cellHeight);
    }
    this.previewScale = scale;
    this._renderDpr = dpr;

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

    const analysis = this.app.assetManager.getCachedCellPixelAnalysis(asset, this.draft.alphaThreshold, this.draft.mask);
    const alphaBounds = analysis?.alphaBounds || null;
    const draftSig = getMaskSignature(this.draft.mask);

    // Determine drawable:
    // 1. Live painting scratch canvas (locked geometry while dragging stroke)
    // 2. Cached masked drawable (or immediate live fallback while cache warms)
    let drawable = null;
    let drawAlphaBounds = alphaBounds;
    let drawTransform = this.draft;

    if (this.brushState) {
      if (this._liveDirty) {
        this._recompositeLiveMaskedCanvas(this.brushState.baseDrawable, asset.region.w, asset.region.h);
      }
      drawable = {
        bitmap: this._liveMaskedCanvas,
        drawRegion: { x: 0, y: 0, w: asset.region.w, h: asset.region.h },
        isCropped: true,
        isMasked: true
      };
      drawAlphaBounds = this.brushState.locked.alphaBounds;
      drawTransform = this.brushState.locked.transform;
    } else {
      drawable = this.app.assetManager.getCellDrawableSync(asset, source, this.draft.mask);
      if (!drawable && draftSig && this._liveFallbackSig === draftSig && this._liveMaskedCanvas) {
        drawable = {
          bitmap: this._liveMaskedCanvas,
          drawRegion: { x: 0, y: 0, w: asset.region.w, h: asset.region.h },
          isCropped: true,
          isMasked: true
        };
      }
    }

    // Draw Onion Skin (reference frame behind or blended over, exact same cell coordinates, Spec §6.4)
    const refCell = this.app.referenceCellKey ? project.cells[this.app.referenceCellKey] : null;
    if (this.onionEnabled && refCell) {
      const ra = this.app.store.getAsset(refCell.assetId);
      const rs = ra ? this.app.store.getSource(ra.sourceId) : null;
      const rDraw = ra && rs ? this.app.assetManager.getCellDrawableSync(ra, rs, refCell.mask) : null;
      const rAnal = ra ? this.app.assetManager.getCachedCellPixelAnalysis(ra, refCell.alphaThreshold, refCell.mask) : null;
      if (rDraw && !(refCell.fitMode === 'alpha' && !rAnal?.alphaBounds)) {
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
    const erasedAllWithMask = !this.brushState && hasCellMask(this.draft) &&
      (analysis?.allTransparent || (this.draft.fitMode === 'alpha' && analysis && !analysis.alphaBounds));

    if (drawable && !erasedAllWithMask) {
      geom = drawCellOnContext(ctx, {
        cellWidth,
        cellHeight,
        region: asset.region,
        transform: drawTransform,
        alphaBounds: drawAlphaBounds,
        drawable,
        smoothing: project.settings.smoothing
      });
    }

    // Keep pointer geometry available even when a masked Fit Alpha cell was erased completely (so Restore works!)
    this._pointerGeom = geom || this._computeFallbackPointerGeom(cellWidth, cellHeight, asset.region, this.draft);

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

    // Brush cursor circle overlay (exact radius matching brushSize * geom.scale * previewScale)
    const activeBrushGeom = this.brushState ? this.brushState.locked.geom : this._pointerGeom;
    const isBrush = this.toolMode === 'erase' || this.toolMode === 'restore';
    if (isBrush && activeBrushGeom) {
      const radiusSrc = this.brushSize / 2;
      const radiusOut = radiusSrc * activeBrushGeom.scale;
      this.brushCursorRadiusCss = radiusOut * scale;
      this.canvas.classList.toggle('is-brush-cursor-hidden', this.brushCursorRadiusCss >= 3);

      if (this.hoverOutPos) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.hoverOutPos.x, this.hoverOutPos.y, radiusOut, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.lineWidth = 2.6 / scale;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(this.hoverOutPos.x, this.hoverOutPos.y, radiusOut, 0, Math.PI * 2);
        ctx.strokeStyle = this.toolMode === 'erase' ? '#fb7185' : '#34d399';
        ctx.lineWidth = 1.4 / scale;
        ctx.stroke();

        // Crisp center dot
        ctx.fillStyle = this.toolMode === 'erase' ? '#fb7185' : '#34d399';
        ctx.beginPath();
        ctx.arc(this.hoverOutPos.x, this.hoverOutPos.y, Math.max(0.8 / scale, 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else {
      this.brushCursorRadiusCss = 0;
      this.canvas.classList.remove('is-brush-cursor-hidden');
    }

    // Update Source Info text
    const r = asset.region;
    const alphaText = geom?.renderedAlphaRect
      ? `Nội dung hiển thị: ${formatNumber(geom.renderedAlphaRect.w, 1)}×${formatNumber(geom.renderedAlphaRect.h, 1)} px`
      : (analysis?.allTransparent
        ? (hasCellMask(this.draft) ? 'Đã tẩy hết phần nhìn thấy (alpha=0)' : 'Nguồn toàn trong suốt (alpha=0)')
        : 'Chưa có alpha bounds');
    $('editor-source-info').textContent =
      `${source.name} (${source.width}×${source.height} px) • Vùng: (${r.x},${r.y},${r.w}×${r.h}) • ${alphaText}`;

    // Editor Warnings
    const warnBox = $('editor-warnings');
    const warns = [];
    if (analysis?.allTransparent) {
      warns.push(
        hasCellMask(this.draft)
          ? 'Ô này đã bị tẩy hết phần nhìn thấy — sẽ xuất trong suốt. Bạn vẫn có thể dùng Khôi phục hoặc Bỏ toàn bộ vết tẩy.'
          : 'Ảnh nguồn hoàn toàn trong suốt (alpha = 0).'
      );
    } else if (this.draft.fitMode === 'alpha' && hasCellMask(this.draft) && analysis && !analysis.alphaBounds) {
      warns.push(`Sau khi tẩy không còn pixel vượt ngưỡng alpha ${this.draft.alphaThreshold} — Fit Alpha sẽ xuất trong suốt.`);
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

    const rAnal = this.app.assetManager.getCachedCellPixelAnalysis(ra, refCell.alphaThreshold, refCell.mask);
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
      const rDraw = this.app.assetManager.getCellDrawableSync(ra, rs, refCell.mask);
      if (rDraw && !(refCell.fitMode === 'alpha' && !rAnal?.alphaBounds)) {
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

  _startBrushStroke(e) {
    const asset = this.app.store.getAsset(this.draft.assetId);
    const source = asset ? this.app.store.getSource(asset.sourceId) : null;
    if (!asset || !source) return;

    const baseDrawable = this.app.assetManager.getAssetDrawableSync(asset, source);
    if (!baseDrawable) {
      this._ensureAnalysisAndRender();
      showToast('Ảnh đang giải mã, vui lòng thử lại sau giây lát.', 'info', 1800);
      return;
    }

    const analysis = this.app.assetManager.getCachedCellPixelAnalysis(asset, this.draft.alphaThreshold, this.draft.mask);
    const grid = this.app.store.project.grid;
    const liveAlphaBounds = analysis?.alphaBounds || null;
    let geom = computeCellGeometry({
      cellWidth: grid.cellWidth,
      cellHeight: grid.cellHeight,
      region: asset.region,
      transform: this.draft,
      alphaBounds: liveAlphaBounds
    });
    let lockedTransform = deepClone(this.draft);
    let lockedAlphaBounds = liveAlphaBounds ? { ...liveAlphaBounds } : null;
    if (!geom) {
      // Erased-empty under Fit Alpha -> fall back to contain geometry so user can Restore!
      geom = this._computeFallbackPointerGeom(grid.cellWidth, grid.cellHeight, asset.region, this.draft);
      lockedTransform.fitMode = 'contain';
      lockedAlphaBounds = null;
    }
    if (!geom) return;

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const locked = {
      rect,
      canvasW: this.canvas.width,
      canvasH: this.canvas.height,
      renderDpr: this._renderDpr,
      previewScale: this.previewScale,
      geom,
      region: { ...asset.region },
      alphaBounds: lockedAlphaBounds,
      transform: lockedTransform
    };

    const radius = this.brushSize / 2;
    const hit = this._clientToSourcePoint(e.clientX, e.clientY, locked);
    this.hoverOutPos = { x: hit.outX, y: hit.outY };

    // Ignore clicks completely outside brush reach of the asset crop
    if (
      hit.localSrcX < -radius || hit.localSrcX > locked.region.w + radius ||
      hit.localSrcY < -radius || hit.localSrcY > locked.region.h + radius
    ) {
      return;
    }

    const op = this.toolMode === 'restore' ? 'restore' : 'erase';
    const existingStrokes = hasMaskStrokes(this.draft.mask) ? this.draft.mask.strokes : [];

    // Pre-check stroke count / project budget before starting (never silently drop/truncate!)
    const preCandidate = {
      strokes: [...existingStrokes, { op, radius, points: [[hit.srcX, hit.srcY]] }]
    };
    const preBudget = checkMaskBudget(this.app.store.project, this.cellKey, preCandidate);
    if (!preBudget.ok) {
      showToast(preBudget.message, 'warn', 4500);
      return;
    }

    this._pushDraftHistory();

    // Prepare reusable live scratch buffers (crop-sized only, never full atlas!)
    const { x: rx, y: ry, w: rw, h: rh } = locked.region;
    this._ensureLiveScratchBuffers(rw, rh);
    const initAlpha = rasterizeMaskAlpha(rw, rh, rx, ry, existingStrokes);
    this._liveMaskAlpha.set(initAlpha);

    const p0 = [hit.srcX, hit.srcY];
    rasterizeStrokeSegmentIntoAlpha(this._liveMaskAlpha, rw, rh, rx, ry, op, radius, p0, p0);
    this._liveDirty = true;

    this.brushState = {
      pointerId: e.pointerId,
      op,
      radius,
      points: [p0],
      locked,
      baseDrawable,
      limitReached: false
    };

    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}

    this.requestRender();
  }

  _continueBrushStroke(e) {
    const bs = this.brushState;
    if (!bs) return;
    if (e.pointerId !== undefined && bs.pointerId !== undefined && e.pointerId !== bs.pointerId) return;

    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const events = coalesced && coalesced.length > 0 ? coalesced : [e];
    const { x: rx, y: ry, w: rw, h: rh } = bs.locked.region;
    const minDist = Math.max(0.25, bs.radius * 0.12);
    const minDistSq = minDist * minDist;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const hit = this._clientToSourcePoint(ev.clientX, ev.clientY, bs.locked);
      this.hoverOutPos = { x: hit.outX, y: hit.outY };

      if (bs.limitReached) continue;

      const prev = bs.points[bs.points.length - 1];
      const dx = hit.srcX - prev[0];
      const dy = hit.srcY - prev[1];
      if (dx * dx + dy * dy < minDistSq) continue;

      if (bs.points.length >= LIMITS.MAX_MASK_POINTS_PER_STROKE) {
        // Attempt gentle sub-pixel polyline simplification once before refusing additional points
        const eps = Math.min(0.35, Math.max(0.1, bs.radius * 0.04));
        const simplified = simplifyStrokePoints(bs.points, eps);
        if (simplified.length < LIMITS.MAX_MASK_POINTS_PER_STROKE) {
          bs.points = simplified;
        } else {
          bs.limitReached = true;
          showToast(
            `Nét vẽ đã đạt giới hạn tối đa ${LIMITS.MAX_MASK_POINTS_PER_STROKE} điểm — hãy nhả chuột để kết thúc nét.`,
            'warn',
            4500
          );
          continue;
        }
      }

      const nextPt = [hit.srcX, hit.srcY];
      bs.points.push(nextPt);
      rasterizeStrokeSegmentIntoAlpha(this._liveMaskAlpha, rw, rh, rx, ry, bs.op, bs.radius, prev, nextPt);
      this._liveDirty = true;
    }

    this.requestRender();
  }

  _finishBrushStroke(e = null) {
    const bs = this.brushState;
    if (!bs) return;
    this.brushState = null;

    if (bs.pointerId !== undefined) {
      try {
        if (this.canvas.hasPointerCapture?.(bs.pointerId)) {
          this.canvas.releasePointerCapture(bs.pointerId);
        }
      } catch {}
    }

    if (!this.draft) return;

    // Capture exact final endpoint if pointerup arrived at a slightly different spot
    if (e && typeof e.clientX === 'number' && typeof e.clientY === 'number' && !bs.limitReached) {
      const hit = this._clientToSourcePoint(e.clientX, e.clientY, bs.locked);
      this.hoverOutPos = { x: hit.outX, y: hit.outY };
      const prev = bs.points[bs.points.length - 1];
      if ((hit.srcX !== prev[0] || hit.srcY !== prev[1]) && bs.points.length < LIMITS.MAX_MASK_POINTS_PER_STROKE) {
        const nextPt = [hit.srcX, hit.srcY];
        bs.points.push(nextPt);
        const { x: rx, y: ry, w: rw, h: rh } = bs.locked.region;
        rasterizeStrokeSegmentIntoAlpha(this._liveMaskAlpha, rw, rh, rx, ry, bs.op, bs.radius, prev, nextPt);
        this._liveDirty = true;
      }
    }

    // Sub-pixel polyline simplification for long strokes (keeps exact endpoints)
    let finalPoints = bs.points;
    if (finalPoints.length > 32) {
      const eps = Math.min(0.35, Math.max(0.1, bs.radius * 0.04));
      finalPoints = simplifyStrokePoints(finalPoints, eps);
    }

    const existingStrokes = hasMaskStrokes(this.draft.mask) ? this.draft.mask.strokes : [];
    const candidateMask = {
      strokes: [
        ...existingStrokes,
        { op: bs.op, radius: bs.radius, points: finalPoints }
      ]
    };

    const budget = checkMaskBudget(this.app.store.project, this.cellKey, candidateMask);
    if (!budget.ok) {
      // Revert draft history entry cleanly — never silently truncate!
      this.draftUndoStack.pop();
      this._disposeLiveBrushBuffers();
      showToast(budget.message, 'error', 5000);
      this.requestRender();
      return;
    }

    // Keep finalized live canvas as immediate zero-flicker fallback while LRU cache updates
    if (this._liveDirty) {
      this._recompositeLiveMaskedCanvas(bs.baseDrawable, bs.locked.region.w, bs.locked.region.h);
    }
    this._liveFallbackSig = getMaskSignature(candidateMask);

    this.draft.mask = candidateMask;
    this._markDraftDirty();
    // Recompute masked drawable & masked alphaBounds (updates Fit Alpha / alpha anchor BEFORE Apply!)
    this._ensureAnalysisAndRender();
  }

  _bindToolbarKeyboardFallback() {
    const bar = $('ed-tool-toolbar');
    if (!bar || 'focusGroup' in HTMLElement.prototype) return;
    const items = Array.from(bar.querySelectorAll('button'));
    if (items.length === 0) return;

    items.forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
    bar.addEventListener('focusin', ({ target }) => {
      if (items.includes(target)) {
        items.forEach((b) => { b.tabIndex = b === target ? 0 : -1; });
      }
    });
    bar.addEventListener('keydown', (e) => {
      const idx = items.indexOf(document.activeElement);
      if (idx === -1) return;
      const rtl = getComputedStyle(bar).direction === 'rtl';
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + (rtl ? -1 : 1) + items.length) % items.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx + (rtl ? 1 : -1) + items.length) % items.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = items.length - 1;
      if (nextIdx !== -1) {
        e.preventDefault();
        items[nextIdx].focus();
      }
    });
  }

  _bindControls() {
    this._bindToolbarKeyboardFallback();

    // Edit Mode Toolbar: Move / Erase / Restore
    $('btn-ed-tool-move')?.addEventListener('click', () => this.setToolMode('move'));
    $('btn-ed-tool-erase')?.addEventListener('click', () => this.setToolMode('erase'));
    $('btn-ed-tool-restore')?.addEventListener('click', () => this.setToolMode('restore'));

    // Brush size controls (1..128 source px, default 12)
    $('ed-brush-size-range')?.addEventListener('input', (e) => this.setBrushSize(e.target.value));
    $('ed-brush-size-num')?.addEventListener('change', (e) => {
      const n = Math.round(Number(e.target.value));
      if (!Number.isFinite(n) || n < LIMITS.MIN_BRUSH_SIZE || n > LIMITS.MAX_BRUSH_SIZE) {
        showToast(`Cỡ cọ phải từ ${LIMITS.MIN_BRUSH_SIZE} đến ${LIMITS.MAX_BRUSH_SIZE} px ảnh nguồn.`, 'warn');
        e.target.value = String(this.brushSize);
        return;
      }
      this.setBrushSize(n);
    });

    // Editor view zoom (does NOT alter exported pixels!)
    $('ed-view-zoom')?.addEventListener('change', (e) => {
      this.viewZoom = e.target.value || 'fit';
      this.requestRender();
    });

    // Clear all mask strokes in current cell
    $('btn-ed-mask-clear')?.addEventListener('click', () => this.clearAllMaskStrokes());

    // Pointer interactions on editor canvas (Move drag, Anchor pick, or Erase/Restore brush)
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.draft || e.button !== 0) return;

      if (this.pickingAnchor) {
        const rect = this.canvas.getBoundingClientRect();
        const { outX, outY } = this._clientToOutputCoords(
          e.clientX, e.clientY, rect, this.canvas.width, this.canvas.height, this._renderDpr, this.previewScale
        );
        const asset = this.app.store.getAsset(this.draft.assetId);
        if (!asset) return;
        const analysis = this.app.assetManager.getCachedCellPixelAnalysis(asset, this.draft.alphaThreshold, this.draft.mask);
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

      if (this.toolMode === 'erase' || this.toolMode === 'restore') {
        e.preventDefault();
        this._startBrushStroke(e);
        return;
      }

      this._pushDraftHistory();
      this.dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origOffsetX: this.draft.offsetX,
        origOffsetY: this.draft.offsetY,
        moved: false
      };
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {}
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.draft) return;

      if (this.brushState) {
        this._continueBrushStroke(e);
        return;
      }

      // Track brush cursor position while hovering in erase/restore mode
      if (this.toolMode === 'erase' || this.toolMode === 'restore') {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const { outX, outY } = this._clientToOutputCoords(
            e.clientX, e.clientY, rect, this.canvas.width, this.canvas.height, this._renderDpr, this.previewScale
          );
          this.hoverOutPos = { x: outX, y: outY };
          this.requestRender();
        }
        return;
      }

      if (!this.dragState) return;
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

    this.canvas.addEventListener('pointerup', (e) => {
      if (this.brushState) {
        this._finishBrushStroke(e);
        return;
      }
      if (this.dragState) {
        if (!this.dragState.moved) {
          this.draftUndoStack.pop();
        }
        this.dragState = null;
      }
    });

    this.canvas.addEventListener('pointercancel', () => {
      this.finishActiveInteraction();
    });

    this.canvas.addEventListener('lostpointercapture', () => {
      this.finishActiveInteraction();
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (!this.brushState && this.hoverOutPos) {
        this.hoverOutPos = null;
        this.requestRender();
      }
    });

    window.addEventListener('blur', () => {
      this.finishActiveInteraction();
    });

    // Fit Mode
    $('ed-fit-mode').addEventListener('change', async (e) => {
      if (!this.draft) return;
      const newMode = e.target.value;
      const asset = this.app.store.getAsset(this.draft.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (newMode === 'alpha' && asset && source) {
        const info = await this.app.assetManager.analyzeCellPixels(asset, source, this.draft.alphaThreshold, this.draft.mask);
        if (!info.ok || !info.alphaBounds) {
          if (!hasCellMask(this.draft)) {
            showToast('Ảnh không có pixel vượt ngưỡng alpha — không thể áp dụng Fit Alpha.', 'error');
            e.target.value = this.draft.fitMode;
            return;
          }
          showToast('Ô đã bị tẩy hết phần nhìn thấy — Fit Alpha sẽ xuất trong suốt cho đến khi Khôi phục.', 'warn', 3600);
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
        const info = await this.app.assetManager.analyzeCellPixels(asset, source, val, this.draft.mask);
        if (this.draft.fitMode === 'alpha' && (!info.ok || !info.alphaBounds) && !hasCellMask(this.draft)) {
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
        const info = await this.app.assetManager.analyzeCellPixels(asset, source, this.draft.alphaThreshold, this.draft.mask);
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
      if (this.pickingAnchor && this.toolMode !== 'move') {
        this.setToolMode('move');
      }
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
      const info = await this.app.assetManager.analyzeCellPixels(asset, source, this.draft.alphaThreshold, this.draft.mask);
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
