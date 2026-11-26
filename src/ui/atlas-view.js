/**
 * Sprite Sheet Builder V2.0 — Sprite Atlas Grid Canvas Controller (Spec §3.2, §8, §12.2).
 * Virtualizes visible cells in viewport, coalesces redraws via rAF, supports zoom 25–400%,
 * Space+drag pan, click/Ctrl/Shift/marquee selection, cell drag move/swap/Ctrl+copy,
 * file & library drag-and-drop, and context menu.
 */

import { cellKey, parseCellKey, isCellInGrid } from '../core/constants.js';
import { drawCellOnContext, drawCheckerboard, drawCellGuides } from '../engine/renderer.js';
import { $ } from './dom-helpers.js';

const HEADER_W = 42;
const HEADER_H = 24;
const PREVIEW_MARGIN = 128;

export class AtlasView {
  constructor(app) {
    this.app = app;
    this.stageWrap = $('atlas-stage-wrap');
    this.canvas = $('atlas-canvas');
    this.ctx = this.canvas.getContext('2d');

    this.zoom = 1.0; // 0.25 .. 4.0
    this.showGrid = true;
    this.showLabels = true;
    this.showGuides = false;
    this.showChecker = true;
    this.previewBgColor = '#1e222a';
    this.marqueeMode = false;

    this.spaceDown = false;
    this.panState = null;
    this.marqueeState = null;
    this.cellDragState = null;
    this.hoverDropKey = null;

    this._rafScheduled = false;
    this._warningCells = new Set();
    this._previewState = null;
    this._paintingPreviews = false;

    this._bindEvents();
  }

  setWarningCells(set) {
    this._warningCells = set || new Set();
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

  setZoom(z) {
    this.zoom = Math.max(0.25, Math.min(4.0, z));
    const pct = Math.round(this.zoom * 100);
    const slider = $('atlas-zoom');
    const lbl = $('atlas-zoom-label');
    if (slider) slider.value = String(pct);
    if (lbl) lbl.textContent = `${pct}%`;
    this.requestRender();
  }

  fitToViewport() {
    const { cols, rows, cellWidth, cellHeight } = this.app.store.project.grid;
    const atlasW = cols * cellWidth;
    const atlasH = rows * cellHeight;
    const availW = Math.max(100, this.stageWrap.clientWidth - HEADER_W - 28);
    const availH = Math.max(100, this.stageWrap.clientHeight - HEADER_H - 28);
    const z = Math.min(availW / atlasW, availH / atlasH, 1.0);
    this.setZoom(Math.max(0.25, Math.min(4.0, z)));
  }

  screenToCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const atlasX = (x - HEADER_W) / this.zoom;
    const atlasY = (y - HEADER_H) / this.zoom;
    const { cols, rows, cellWidth, cellHeight } = this.app.store.project.grid;
    if (atlasX < 0 || atlasY < 0) return null;
    const col = Math.floor(atlasX / cellWidth);
    const row = Math.floor(atlasY / cellHeight);
    if (!isCellInGrid(row, col, this.app.store.project.grid)) return null;
    return { row, col, key: cellKey(row, col) };
  }

  scrollToCell(row, col) {
    const { cellWidth, cellHeight } = this.app.store.project.grid;
    const cx = HEADER_W + (col + 0.5) * cellWidth * this.zoom;
    const cy = HEADER_H + (row + 0.5) * cellHeight * this.zoom;
    this.stageWrap.scrollLeft = Math.max(0, cx - this.stageWrap.clientWidth / 2);
    this.stageWrap.scrollTop = Math.max(0, cy - this.stageWrap.clientHeight / 2);
    this.requestRender();
  }

  _bindEvents() {
    // Re-render on scroll (for viewport virtualization)
    this.stageWrap.addEventListener('scroll', () => this.requestRender(), { passive: true });
    window.addEventListener('resize', () => this.requestRender(), { passive: true });

    // Space key for pan mode
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        if (document.activeElement === this.stageWrap || this.stageWrap.contains(document.activeElement)) {
          e.preventDefault();
          this.spaceDown = true;
          this.canvas.classList.add('is-panning');
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.canvas.classList.remove('is-panning');
      }
    });

    // Ctrl + Wheel zoom
    this.stageWrap.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.setZoom(this.zoom * factor);
    }, { passive: false });

    // Pointer interactions: pan, marquee, cell selection & drag move/swap/copy
    this.canvas.addEventListener('pointerdown', async (e) => {
      if (e.button === 2) return; // handled by contextmenu
      this.stageWrap.focus({ preventScroll: true });
      this.app.hideContextMenu();

      if (this.spaceDown || e.button === 1) {
        e.preventDefault();
        this.panState = {
          startX: e.clientX,
          startY: e.clientY,
          scrollLeft: this.stageWrap.scrollLeft,
          scrollTop: this.stageWrap.scrollTop
        };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }

      const hit = this.screenToCell(e.clientX, e.clientY);
      if (!hit) return;

      if (this.marqueeMode) {
        this.marqueeState = {
          startRow: hit.row,
          startCol: hit.col,
          curRow: hit.row,
          curCol: hit.col
        };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }

      // Unified selection path with draft guard (R2: handles click, re-click, Ctrl+click, Shift+click)
      const okSel = await this.app.selectCellWithGuard(hit.row, hit.col, {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey
      });
      if (!okSel) return;

      // Prepare cell drag if occupied
      if (this.app.store.project.cells[hit.key] && !e.shiftKey) {
        this.cellDragState = {
          fromKey: hit.key,
          startX: e.clientX,
          startY: e.clientY,
          dragging: false,
          copy: e.ctrlKey || e.metaKey
        };
        this.canvas.setPointerCapture(e.pointerId);
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.panState) {
        const dx = e.clientX - this.panState.startX;
        const dy = e.clientY - this.panState.startY;
        this.stageWrap.scrollLeft = this.panState.scrollLeft - dx;
        this.stageWrap.scrollTop = this.panState.scrollTop - dy;
        this.requestRender();
        return;
      }

      if (this.marqueeState) {
        const hit = this.screenToCell(e.clientX, e.clientY);
        if (hit) {
          this.marqueeState.curRow = hit.row;
          this.marqueeState.curCol = hit.col;
          this.requestRender();
        }
        return;
      }

      if (this.cellDragState) {
        const dist = Math.hypot(e.clientX - this.cellDragState.startX, e.clientY - this.cellDragState.startY);
        if (dist > 6) {
          this.cellDragState.dragging = true;
          this.cellDragState.copy = e.ctrlKey || e.metaKey;
          const hit = this.screenToCell(e.clientX, e.clientY);
          this.hoverDropKey = hit ? hit.key : null;
          this.requestRender();
        }
      }
    });

    this.canvas.addEventListener('pointerup', async (e) => {
      if (this.panState) {
        this.panState = null;
        return;
      }
      if (this.marqueeState) {
        const ms = this.marqueeState;
        this.marqueeState = null;
        await this.app.selectRectRangeWithGuard(ms.startRow, ms.startCol, ms.curRow, ms.curCol);
        this.requestRender();
        return;
      }
      if (this.cellDragState) {
        const ds = this.cellDragState;
        this.cellDragState = null;
        this.hoverDropKey = null;
        if (ds.dragging) {
          const hit = this.screenToCell(e.clientX, e.clientY);
          if (hit && hit.key !== ds.fromKey) {
            await this.app.handleCellDropMoveOrCopy(ds.fromKey, hit.key, e.ctrlKey || e.metaKey);
          }
        }
        this.requestRender();
      }
    });

    // Double click: occupied -> focus editor; empty -> pick file for this cell (Spec §3.2)
    this.canvas.addEventListener('dblclick', async (e) => {
      const hit = this.screenToCell(e.clientX, e.clientY);
      if (!hit) return;
      const ok = await this.app.selectCellWithGuard(hit.row, hit.col);
      if (!ok) return;
      if (this.app.store.project.cells[hit.key]) {
        this.app.focusEditorPanel();
      } else {
        this.app.promptImportSingleImageForCell(hit.row, hit.col);
      }
    });

    // Context menu
    this.canvas.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const hit = this.screenToCell(e.clientX, e.clientY);
      if (!hit) return;
      if (!this.app.selectedCells.has(hit.key)) {
        const ok = await this.app.selectCellWithGuard(hit.row, hit.col);
        if (!ok) return;
      }
      this.app.openContextMenu(e.clientX, e.clientY, hit.row, hit.col);
    });

    // Drag & Drop from Explorer OR Library Panel onto Atlas cells
    this.stageWrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.stageWrap.classList.add('is-drop-over');
      const hit = this.screenToCell(e.clientX, e.clientY);
      const nextHover = hit ? hit.key : null;
      if (nextHover !== this.hoverDropKey) {
        this.hoverDropKey = nextHover;
        this.requestRender();
      }
    });

    this.stageWrap.addEventListener('dragleave', (e) => {
      if (!this.stageWrap.contains(e.relatedTarget)) {
        this.stageWrap.classList.remove('is-drop-over');
        this.hoverDropKey = null;
        this.requestRender();
      }
    });

    this.stageWrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.stageWrap.classList.remove('is-drop-over');
      const hit = this.screenToCell(e.clientX, e.clientY);
      this.hoverDropKey = null;
      this.requestRender();

      const targetCell = hit || { row: 0, col: 0 };

      // Check internal library drag first
      const libData = e.dataTransfer.getData('application/x-ssb-assets');
      if (libData) {
        try {
          const assetIds = JSON.parse(libData);
          if (Array.isArray(assetIds) && assetIds.length > 0) {
            await this.app.handleDropLibraryAssetsOnCell(assetIds, targetCell);
          }
        } catch {}
        return;
      }

      // External Explorer files
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) {
        await this.app.handleIncomingFiles(files, { targetCell, directSingle: files.length === 1 && Boolean(hit) });
      }
    });
  }

  async _paintPreviews() {
    if (this._paintingPreviews) return;
    this._paintingPreviews = true;
    const manager = this.app.assetManager;
    let batchStart = performance.now();

    try {
      while (this._previewState.queue.length > 0) {
        const state = this._previewState;
        const job = state.queue.shift();
        const { entry, key, cell, asset, source, x, y, right, bottom, originX, originY } = job;
        const isCurrent = () => this._previewState === state &&
          this.app.store.project === state.project && state.entries.get(key) === entry && entry.job === job;
        if (!isCurrent()) continue;
        job.started = true;

        let preview = null;
        try {
          const analysis = cell.fitMode === 'alpha'
            ? await manager.analyzeCellPixels(asset, source, cell.alphaThreshold, cell.mask)
            : null;
          if (isCurrent() && (cell.fitMode !== 'alpha' || analysis?.alphaBounds)) {
            await manager.withPreviewDrawable(asset, source, cell.mask, (drawable) => {
              if (!isCurrent()) return;
              const canvas = document.createElement('canvas');
              canvas.width = right - x;
              canvas.height = bottom - y;
              const ctx = canvas.getContext('2d');
              ctx.setTransform(state.scale, 0, 0, state.scale, originX - x, originY - y);
              drawCellOnContext(ctx, {
                cellWidth: state.project.grid.cellWidth,
                cellHeight: state.project.grid.cellHeight,
                region: asset.region,
                transform: cell,
                alphaBounds: analysis?.alphaBounds || null,
                drawable,
                smoothing: state.project.settings.smoothing
              });
              preview = canvas;
            });
          }
        } catch {
          // A failed decode ends this request. A repaint alone must not retry it.
        }
        if (isCurrent()) {
          entry.preview = preview ? { canvas: preview, x, y } : null;
          job.complete = true;
          this.requestRender();
        }

        if (performance.now() - batchStart >= 8) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          batchStart = performance.now();
        }
      }
    } finally {
      this._paintingPreviews = false;
    }
  }

  render() {
    const project = this.app.store.project;
    const { cols, rows, cellWidth, cellHeight } = project.grid;
    const z = this.zoom;
    const dpr = window.devicePixelRatio || 1;

    const cssW = Math.ceil(HEADER_W + cols * cellWidth * z + 16);
    const cssH = Math.ceil(HEADER_H + rows * cellHeight * z + 16);

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Compute visible viewport bounds for virtualization (Spec §12.2)
    const scrollL = this.stageWrap.scrollLeft;
    const scrollT = this.stageWrap.scrollTop;
    const viewW = this.stageWrap.clientWidth || cssW;
    const viewH = this.stageWrap.clientHeight || cssH;
    const scale = dpr * z;
    // Use device-pixel rectangles so the preview can be copied back without resampling.
    // Align the buffered viewport to a grid so small scrolls reuse the same previews.
    const previewLeft = Math.max(0, (Math.floor(scrollL / PREVIEW_MARGIN) - 1) * PREVIEW_MARGIN * dpr);
    const previewTop = Math.max(0, (Math.floor(scrollT / PREVIEW_MARGIN) - 1) * PREVIEW_MARGIN * dpr);
    const previewRight = Math.min(targetW, (Math.ceil((scrollL + viewW) / PREVIEW_MARGIN) + 1) * PREVIEW_MARGIN * dpr);
    const previewBottom = Math.min(targetH, (Math.ceil((scrollT + viewH) / PREVIEW_MARGIN) + 1) * PREVIEW_MARGIN * dpr);
    if (this._previewState?.project !== project || this._previewState.z !== z || this._previewState.dpr !== dpr) {
      this._previewState = { project, z, dpr, scale, entries: new Map(), queue: [] };
    }
    const state = this._previewState;

    const visMinCol = Math.max(0, Math.floor((scrollL - HEADER_W) / (cellWidth * z)) - 1);
    const visMaxCol = Math.min(cols - 1, Math.ceil((scrollL + viewW - HEADER_W) / (cellWidth * z)) + 1);
    const visMinRow = Math.max(0, Math.floor((scrollT - HEADER_H) / (cellHeight * z)) - 1);
    const visMaxRow = Math.min(rows - 1, Math.ceil((scrollT + viewH - HEADER_H) / (cellHeight * z)) + 1);

    const atlasDrawW = cols * cellWidth * z;
    const atlasDrawH = rows * cellHeight * z;

    // Background inside atlas area
    if (this.showChecker) {
      drawCheckerboard(ctx, HEADER_W, HEADER_H, atlasDrawW, atlasDrawH, Math.max(8, Math.round(12 * z)));
    } else {
      ctx.fillStyle = this.previewBgColor;
      ctx.fillRect(HEADER_W, HEADER_H, atlasDrawW, atlasDrawH);
    }

    // Build row -> animation group name label map
    const rowGroupNames = new Map();
    if (this.showLabels) {
      for (const anim of project.animations) {
        if (anim.frames.length > 0) {
          const r0 = anim.frames[0].row;
          if (!rowGroupNames.has(r0)) rowGroupNames.set(r0, anim.name);
        }
      }
    }

    const expectedSet = project.expectedCells ? new Set(project.expectedCells) : null;
    const previewKeys = new Set();
    const queue = [];

    // Draw visible cells in atlas coordinate space scaled by z
    ctx.save();
    ctx.translate(HEADER_W, HEADER_H);
    ctx.scale(z, z);

    for (let r = visMinRow; r <= visMaxRow; r++) {
      for (let c = visMinCol; c <= visMaxCol; c++) {
        const key = cellKey(r, c);
        const ox = c * cellWidth;
        const oy = r * cellHeight;
        const isUnused = expectedSet ? !expectedSet.has(key) : false;

        // Unused preset slot shading
        if (isUnused) {
          ctx.fillStyle = 'rgba(100, 116, 139, 0.24)';
          ctx.fillRect(ox, oy, cellWidth, cellHeight);
        }

        const originX = HEADER_W * dpr + ox * scale;
        const originY = HEADER_H * dpr + oy * scale;
        const x = Math.floor(Math.max(previewLeft, originX));
        const y = Math.floor(Math.max(previewTop, originY));
        const right = Math.ceil(Math.min(previewRight, originX + cellWidth * scale));
        const bottom = Math.ceil(Math.min(previewBottom, originY + cellHeight * scale));
        const cell = project.cells[key];
        if (cell && x < right && y < bottom) {
          const asset = project.assets.find((a) => a.id === cell.assetId);
          const source = asset ? project.sources.find((s) => s.id === asset.sourceId) : null;
          if (asset && source) {
            previewKeys.add(key);
            let entry = state.entries.get(key);
            if (!entry) {
              entry = { job: null, preview: null };
              state.entries.set(key, entry);
            }
            const job = entry.job;
            if (!job || job.x !== x || job.y !== y || job.right !== right || job.bottom !== bottom) {
              entry.job = { entry, key, cell, asset, source, x, y, right, bottom, originX, originY };
            }
            if (!entry.job.started) queue.push(entry.job);

            if (entry.preview) {
              const { canvas, x: previewX, y: previewY } = entry.preview;
              ctx.save();
              ctx.resetTransform();
              ctx.drawImage(canvas, previewX, previewY);
              ctx.restore();
            } else if (!entry.job.complete) {
              ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
              ctx.fillRect(ox + 2, oy + 2, cellWidth - 4, cellHeight - 4);
            }
          }
        }

        if (this.showGuides) {
          drawCellGuides(ctx, ox, oy, cellWidth, cellHeight, project.settings.guides, z);
        }

        // Cell borders & overlays
        if (this.showGrid) {
          ctx.strokeStyle = isUnused ? 'rgba(148, 163, 184, 0.35)' : 'rgba(148, 163, 184, 0.55)';
          ctx.lineWidth = 1 / z;
          ctx.strokeRect(ox + 0.5 / z, oy + 0.5 / z, cellWidth - 1 / z, cellHeight - 1 / z);
        }

        // Warning highlight
        if (this._warningCells.has(key)) {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 2 / z;
          ctx.strokeRect(ox + 2 / z, oy + 2 / z, cellWidth - 4 / z, cellHeight - 4 / z);
        }

        // Selected cells highlight
        if (this.app.selectedCells.has(key)) {
          const isPrimary = key === this.app.activeCellKey;
          ctx.fillStyle = isPrimary ? 'rgba(59, 130, 246, 0.18)' : 'rgba(59, 130, 246, 0.12)';
          ctx.fillRect(ox, oy, cellWidth, cellHeight);
          ctx.strokeStyle = isPrimary ? '#3b82f6' : '#60a5fa';
          ctx.lineWidth = (isPrimary ? 2.5 : 1.5) / z;
          ctx.strokeRect(ox + 1.5 / z, oy + 1.5 / z, cellWidth - 3 / z, cellHeight - 3 / z);
        }

        // Drop target highlight
        if (this.hoverDropKey === key) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.25)';
          ctx.fillRect(ox, oy, cellWidth, cellHeight);
          ctx.strokeStyle = '#22c55e';
          ctx.lineWidth = 3 / z;
          ctx.strokeRect(ox + 1.5 / z, oy + 1.5 / z, cellWidth - 3 / z, cellHeight - 3 / z);
        }

        // Cell labels (unused tag or reference badge)
        if (this.showLabels) {
          ctx.font = `${Math.max(9, Math.round(11 / z))}px "Segoe UI", sans-serif`;
          if (isUnused && !cell) {
            ctx.fillStyle = 'rgba(203, 213, 225, 0.65)';
            ctx.fillText('dư', ox + 4 / z, oy + 13 / z);
          }
          if (this.app.referenceCellKey === key) {
            ctx.fillStyle = '#a855f7';
            ctx.fillRect(ox + cellWidth - 28 / z, oy + 2 / z, 26 / z, 14 / z);
            ctx.fillStyle = '#ffffff';
            ctx.fillText('REF', ox + cellWidth - 25 / z, oy + 12 / z);
          }
        }
      }
    }

    // Marquee preview box
    if (this.marqueeState) {
      const r0 = Math.min(this.marqueeState.startRow, this.marqueeState.curRow);
      const r1 = Math.max(this.marqueeState.startRow, this.marqueeState.curRow);
      const c0 = Math.min(this.marqueeState.startCol, this.marqueeState.curCol);
      const c1 = Math.max(this.marqueeState.startCol, this.marqueeState.curCol);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2 / z;
      ctx.fillRect(c0 * cellWidth, r0 * cellHeight, (c1 - c0 + 1) * cellWidth, (r1 - r0 + 1) * cellHeight);
      ctx.strokeRect(c0 * cellWidth, r0 * cellHeight, (c1 - c0 + 1) * cellWidth, (r1 - r0 + 1) * cellHeight);
    }

    ctx.restore();

    // Draw 1-based Column & Row Headers
    if (this.showLabels) {
      ctx.fillStyle = 'rgba(30, 34, 42, 0.92)';
      ctx.fillRect(0, 0, cssW, HEADER_H);
      ctx.fillRect(0, 0, HEADER_W, cssH);

      ctx.font = '11px "Cascadia Code", Consolas, monospace';
      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let c = visMinCol; c <= visMaxCol; c++) {
        const cx = HEADER_W + (c + 0.5) * cellWidth * z;
        ctx.fillText(String(c + 1), cx, HEADER_H / 2);
      }
      for (let r = visMinRow; r <= visMaxRow; r++) {
        const cy = HEADER_H + (r + 0.5) * cellHeight * z;
        ctx.fillText(String(r + 1), HEADER_W / 2, cy);
        const gName = rowGroupNames.get(r);
        if (gName) {
          ctx.save();
          ctx.textAlign = 'left';
          ctx.font = 'bold 10.5px "Segoe UI", sans-serif';
          const labelX = HEADER_W + 4;
          const labelY = HEADER_H + r * cellHeight * z + 10;
          const tw = ctx.measureText(gName).width + 8;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
          ctx.fillRect(labelX - 2, labelY - 7, tw, 14);
          ctx.fillStyle = '#93c5fd';
          ctx.fillText(gName, labelX + 2, labelY);
          ctx.restore();
        }
      }
    }

    for (const key of state.entries.keys()) {
      if (!previewKeys.has(key)) state.entries.delete(key);
    }
    state.queue = queue;
    if (queue.length > 0) this._paintPreviews();
  }
}
