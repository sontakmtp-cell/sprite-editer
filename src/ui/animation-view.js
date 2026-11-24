/**
 * Sprite Sheet Builder V2.0 — Animation Preview & Timeline Controller (Spec §9).
 * Uses AnimationClock + rAF monotonic timing, pauses when tab hidden without catch-up burst,
 * renders committed data only, supports group CRUD, timeline drag-to-reorder & per-frame durationMs.
 */

import { LIMITS, cellKey, parseCellKey } from '../core/constants.js';
import { AnimationClock } from '../core/animation-clock.js';
import { drawCellOnContext, drawCheckerboard, drawCellGuides } from '../engine/renderer.js';
import { $, clearEl, el, showChoiceDialog, showToast } from './dom-helpers.js';

export class AnimationView {
  constructor(app) {
    this.app = app;
    this.canvas = $('anim-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.clock = new AnimationClock();

    this.activeAnimId = null;
    this.showGuides = true;
    this.bgMode = 'checker'; // 'checker' | 'dark' | 'light'
    this.zoomMode = 'fit'; // 'fit' | '0.5' | '1' | '2'
    this._rafId = null;
    this._dragSlotIdx = null;

    this._bindEvents();
  }

  getActiveAnimation() {
    const anims = this.app.store.project.animations;
    if (!anims.length) return null;
    let found = anims.find((a) => a.id === this.activeAnimId);
    if (!found) {
      found = anims[0];
      this.activeAnimId = found.id;
    }
    return found;
  }

  onProjectChanged() {
    const anims = this.app.store.project.animations;
    if (!anims.some((a) => a.id === this.activeAnimId)) {
      this.activeAnimId = anims[0]?.id || null;
      this.clock.stop();
    }
    const anim = this.getActiveAnimation();
    this.clock.syncWithAnimation(anim);
    this._syncGroupControls();
    this.renderTimeline();
    this.renderCurrentFrame();
  }

  _syncGroupControls() {
    const sel = $('anim-group-select');
    const anims = this.app.store.project.animations;
    clearEl(sel);

    if (anims.length === 0) {
      sel.appendChild(el('option', { value: '', text: '(Chưa có nhóm animation)' }));
    } else {
      for (const a of anims) {
        const opt = el('option', { value: a.id, text: `${a.name} (${a.frames.length} frame)` });
        if (a.id === this.activeAnimId) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    const anim = this.getActiveAnimation();
    const disabled = !anim;
    $('btn-anim-dup').disabled = disabled;
    $('btn-anim-edit').disabled = disabled;
    $('btn-anim-del').disabled = disabled;
    $('btn-anim-play').disabled = disabled || anim.frames.length === 0;
    $('btn-anim-stop').disabled = disabled;
    $('btn-anim-prev').disabled = disabled || anim.frames.length === 0;
    $('btn-anim-next').disabled = disabled || anim.frames.length === 0;
    $('anim-fps').disabled = disabled;
    $('anim-loop-mode').disabled = disabled;
    $('btn-anim-add-sel').disabled = disabled;

    if (anim) {
      $('anim-fps').value = String(anim.fps);
      $('anim-loop-mode').value = anim.loopMode;
      this._updatePlayButton();
    }
  }

  _updatePlayButton() {
    const btn = $('btn-anim-play');
    if (btn) btn.textContent = this.clock.playing ? '⏸ Tạm dừng' : '▶ Phát';
  }

  startLoop() {
    if (this._rafId !== null) return;
    const step = (now) => {
      const anim = this.getActiveAnimation();
      if (!anim || !this.clock.playing) {
        this._rafId = null;
        this._updatePlayButton();
        return;
      }
      const res = this.clock.tick(anim, now);
      if (res.changed || res.ended) {
        this.renderCurrentFrame();
        this._highlightCurrentTimelineSlot();
      }
      if (res.ended) {
        this._rafId = null;
        this._updatePlayButton();
        return;
      }
      this._rafId = requestAnimationFrame(step);
    };
    this._rafId = requestAnimationFrame(step);
  }

  stopLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._updatePlayButton();
  }

  renderCurrentFrame() {
    const project = this.app.store.project;
    const { cellWidth, cellHeight } = project.grid;
    const anim = this.getActiveAnimation();
    const frameIdx = this.clock.getCurrentFrameIndex(anim);
    const total = anim ? anim.frames.length : 0;

    $('anim-frame-counter').textContent = total > 0 && frameIdx >= 0 ? `${frameIdx + 1} / ${total}` : '0 / 0';

    const warnBadge = $('anim-warning-inline');
    const dpr = window.devicePixelRatio || 1;
    let scale;
    if (this.zoomMode === 'fit') {
      scale = Math.min(144 / cellWidth, 144 / cellHeight);
    } else {
      scale = Number(this.zoomMode) || 1;
    }
    const cssW = Math.max(24, Math.round(cellWidth * scale));
    const cssH = Math.max(24, Math.round(cellHeight * scale));
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

    if (this.bgMode === 'checker') {
      drawCheckerboard(ctx, 0, 0, cellWidth, cellHeight, Math.max(6, Math.round(10 / scale)));
    } else {
      ctx.fillStyle = this.bgMode === 'light' ? '#f3f4f6' : '#111317';
      ctx.fillRect(0, 0, cellWidth, cellHeight);
    }

    if (!anim || total === 0 || frameIdx < 0) {
      warnBadge.classList.add('hidden');
      return;
    }

    const slot = anim.frames[frameIdx];
    const key = cellKey(slot.row, slot.col);
    const cell = project.cells[key];

    // Show warning if group contains any empty slots or current slot is empty
    const emptyCount = anim.frames.filter((f) => !project.cells[cellKey(f.row, f.col)]).length;
    if (emptyCount > 0) {
      warnBadge.textContent = !cell
        ? `Slot #${frameIdx + 1} trống (${emptyCount} ô trống trong nhóm)`
        : `${emptyCount} ô trống trong nhóm`;
      warnBadge.classList.remove('hidden');
    } else {
      warnBadge.classList.add('hidden');
    }

    if (cell) {
      const asset = this.app.store.getAsset(cell.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (asset && source) {
        const drawable = this.app.assetManager.getCellDrawableSync(asset, source, cell.mask);
        const analysis = cell.fitMode === 'alpha'
          ? this.app.assetManager.getCachedCellPixelAnalysis(asset, cell.alphaThreshold, cell.mask)
          : null;
        if (drawable && (cell.fitMode !== 'alpha' || analysis)) {
          if (!(cell.fitMode === 'alpha' && !analysis?.alphaBounds)) {
            drawCellOnContext(ctx, {
              cellWidth,
              cellHeight,
              region: asset.region,
              transform: cell,
              alphaBounds: analysis?.alphaBounds || null,
              drawable,
              smoothing: project.settings.smoothing
            });
          }
        } else {
          const projId = project.projectId;
          Promise.all([
            this.app.assetManager.getCellDrawable(asset, source, cell.mask),
            cell.fitMode === 'alpha'
              ? this.app.assetManager.analyzeCellPixels(asset, source, cell.alphaThreshold, cell.mask)
              : Promise.resolve(null)
          ]).then(() => {
            if (this.app.store.project.projectId === projId) this.renderCurrentFrame();
          }).catch(() => {});
        }
      }
    }

    if (this.showGuides) {
      const guides = anim.guides || project.settings.guides;
      drawCellGuides(ctx, 0, 0, cellWidth, cellHeight, guides, scale);
    }
  }

  _highlightCurrentTimelineSlot() {
    const strip = $('timeline-strip');
    const anim = this.getActiveAnimation();
    const cur = this.clock.getCurrentFrameIndex(anim);
    for (const child of strip.children) {
      const idx = Number(child.dataset.slotIndex);
      child.classList.toggle('is-current', idx === cur);
    }
  }

  renderTimeline() {
    const strip = $('timeline-strip');
    clearEl(strip);
    const project = this.app.store.project;
    const anim = this.getActiveAnimation();
    if (!anim) {
      strip.appendChild(el('div', { style: { color: 'var(--text-muted)', padding: '12px', fontSize: '12px' }, text: 'Tạo nhóm animation hoặc áp dụng preset để xem timeline.' }));
      return;
    }
    if (anim.frames.length === 0) {
      strip.appendChild(el('div', { style: { color: 'var(--warn)', padding: '12px', fontSize: '12px' }, text: 'Nhóm chưa có frame nào. Chọn ô trên lưới rồi bấm "+ Thêm ô chọn".' }));
      return;
    }

    const curIdx = this.clock.getCurrentFrameIndex(anim);
    const { cellWidth, cellHeight } = project.grid;

    anim.frames.forEach((slot, idx) => {
      const key = cellKey(slot.row, slot.col);
      const cell = project.cells[key];

      const thumbCanvas = el('canvas', { width: 44, height: 44 });
      if (cell) {
        const asset = this.app.store.getAsset(cell.assetId);
        const source = asset ? this.app.store.getSource(asset.sourceId) : null;
        if (asset && source) {
          const drawThumb = (drawable) => {
            const tctx = thumbCanvas.getContext('2d');
            const s = Math.min(44 / cellWidth, 44 / cellHeight);
            const ox = (44 - cellWidth * s) / 2;
            const oy = (44 - cellHeight * s) / 2;
            tctx.clearRect(0, 0, 44, 44);
            tctx.save();
            tctx.translate(ox, oy);
            tctx.scale(s, s);
            const anal = cell.fitMode === 'alpha'
              ? this.app.assetManager.getCachedCellPixelAnalysis(asset, cell.alphaThreshold, cell.mask)
              : null;
            if (!(cell.fitMode === 'alpha' && !anal?.alphaBounds)) {
              drawCellOnContext(tctx, {
                cellWidth,
                cellHeight,
                region: asset.region,
                transform: cell,
                alphaBounds: anal?.alphaBounds || null,
                drawable,
                smoothing: project.settings.smoothing
              });
            }
            tctx.restore();
          };
          const syncDraw = this.app.assetManager.getCellDrawableSync(asset, source, cell.mask);
          const syncAnal = cell.fitMode === 'alpha'
            ? this.app.assetManager.getCachedCellPixelAnalysis(asset, cell.alphaThreshold, cell.mask)
            : true;
          if (syncDraw && syncAnal) drawThumb(syncDraw);
          else {
            const projId = project.projectId;
            Promise.all([
              this.app.assetManager.getCellDrawable(asset, source, cell.mask),
              cell.fitMode === 'alpha'
                ? this.app.assetManager.analyzeCellPixels(asset, source, cell.alphaThreshold, cell.mask)
                : Promise.resolve(null)
            ]).then(([d]) => {
              if (d && this.app.store.project.projectId === projId) drawThumb(d);
            }).catch(() => {});
          }
        }
      }

      const durInput = el('input', {
        type: 'number',
        className: 'timeline-slot-dur',
        min: LIMITS.MIN_DURATION_MS,
        max: LIMITS.MAX_DURATION_MS,
        step: 5,
        placeholder: `${Math.round(1000 / anim.fps)}ms`,
        value: slot.durationMs ?? '',
        title: 'Thời lượng riêng của frame (10–10000 ms; để trống dùng FPS)',
        onClick: (e) => e.stopPropagation(),
        onChange: (e) => {
          const raw = e.target.value.trim();
          const val = raw === '' ? null : Number(raw);
          if (val !== null && (!Number.isFinite(val) || val < LIMITS.MIN_DURATION_MS || val > LIMITS.MAX_DURATION_MS)) {
            showToast('Thời lượng frame phải từ 10 đến 10.000 ms.', 'warn');
            e.target.value = slot.durationMs ?? '';
            return;
          }
          const nextFrames = anim.frames.map((f, i) => (i === idx ? { ...f, durationMs: val } : f));
          this.app.store.updateAnimation(anim.id, { frames: nextFrames }, 'Đổi thời lượng frame');
        }
      });

      const delBtn = el('button', {
        type: 'button',
        className: 'btn-xs',
        text: '×',
        title: 'Gỡ slot khỏi timeline (không xóa ảnh trong atlas)',
        style: { position: 'absolute', top: '2px', right: '2px', padding: '0 4px', lineHeight: '14px' },
        onClick: (e) => {
          e.stopPropagation();
          const nextFrames = anim.frames.filter((_, i) => i !== idx);
          this.app.store.updateAnimation(anim.id, { frames: nextFrames }, 'Gỡ frame khỏi timeline');
        }
      });

      const item = el('div', {
        className: `timeline-slot ${idx === curIdx ? 'is-current' : ''} ${!cell ? 'is-empty-slot' : ''}`,
        draggable: 'true',
        dataset: { slotIndex: idx },
        title: `Slot #${idx + 1} → Ô (${slot.row + 1}, ${slot.col + 1})${!cell ? ' [TRỐNG]' : ''} • Kéo để đổi thứ tự phát`,
        onClick: async () => {
          this.clock.setFrameIndex(anim, idx);
          this.renderCurrentFrame();
          this._highlightCurrentTimelineSlot();
          const ok = await this.app.ensureDraftResolved();
          if (ok) {
            this.app.selectCell(slot.row, slot.col);
            this.app.atlasView.scrollToCell(slot.row, slot.col);
          }
        }
      }, [
        delBtn,
        thumbCanvas,
        el('span', { className: 'timeline-slot-label', text: `#${idx + 1} (${slot.row + 1},${slot.col + 1})` }),
        durInput
      ]);

      // Drag to reorder playback order without moving atlas cells (Spec §9)
      item.addEventListener('dragstart', (e) => {
        this._dragSlotIdx = idx;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      });
      item.addEventListener('dragover', (e) => {
        if (this._dragSlotIdx === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        if (this._dragSlotIdx === null || this._dragSlotIdx === idx) return;
        const from = this._dragSlotIdx;
        this._dragSlotIdx = null;
        const nextFrames = [...anim.frames];
        const [moved] = nextFrames.splice(from, 1);
        nextFrames.splice(idx, 0, moved);
        this.app.store.updateAnimation(anim.id, { frames: nextFrames }, 'Đổi thứ tự phát timeline');
      });
      item.addEventListener('dragend', () => { this._dragSlotIdx = null; });

      strip.appendChild(item);
    });
  }

  _bindEvents() {
    // Pause on tab hidden / visibilitychange without catch-up burst (Spec §9, T19)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.clock.handleVisibilityHidden();
        this.stopLoop();
      }
    });
    window.addEventListener('blur', () => {
      if (this.clock.playing) {
        this.clock.handleVisibilityHidden();
        this.stopLoop();
      }
    });

    $('anim-group-select').addEventListener('change', (e) => {
      this.activeAnimId = e.target.value || null;
      this.clock.stop();
      this.stopLoop();
      this._syncGroupControls();
      this.renderTimeline();
      this.renderCurrentFrame();
    });

    $('btn-anim-play').addEventListener('click', () => {
      const anim = this.getActiveAnimation();
      if (!anim || anim.frames.length === 0) return;
      if (this.clock.playing) {
        this.clock.pause();
        this.stopLoop();
      } else {
        if (this.clock.play(anim, performance.now())) {
          this._updatePlayButton();
          this.startLoop();
        }
      }
    });

    $('btn-anim-stop').addEventListener('click', () => {
      this.clock.stop();
      this.stopLoop();
      this.renderCurrentFrame();
      this._highlightCurrentTimelineSlot();
    });

    $('btn-anim-prev').addEventListener('click', () => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      this.clock.pause();
      this.stopLoop();
      this.clock.step(anim, -1);
      this.renderCurrentFrame();
      this._highlightCurrentTimelineSlot();
    });

    $('btn-anim-next').addEventListener('click', () => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      this.clock.pause();
      this.stopLoop();
      this.clock.step(anim, 1);
      this.renderCurrentFrame();
      this._highlightCurrentTimelineSlot();
    });

    $('anim-fps').addEventListener('change', (e) => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v < LIMITS.MIN_FPS || v > LIMITS.MAX_FPS) {
        e.target.value = String(anim.fps);
        showToast('FPS phải từ 1 đến 60.', 'warn');
        return;
      }
      this.app.store.updateAnimation(anim.id, { fps: v }, 'Đổi FPS nhóm animation');
    });

    $('anim-loop-mode').addEventListener('change', (e) => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      this.app.store.updateAnimation(anim.id, { loopMode: e.target.value }, 'Đổi chế độ lặp');
    });

    $('anim-custom-dur').addEventListener('change', (e) => {
      this.clock.useCustomDurations = e.target.checked;
    });

    $('anim-zoom').addEventListener('change', (e) => {
      this.zoomMode = e.target.value;
      this.renderCurrentFrame();
    });

    $('btn-anim-guides').addEventListener('click', () => {
      this.showGuides = !this.showGuides;
      $('btn-anim-guides').setAttribute('aria-pressed', String(this.showGuides));
      this.renderCurrentFrame();
    });

    $('btn-anim-bg').addEventListener('click', () => {
      const order = ['checker', 'dark', 'light'];
      const labels = { checker: 'Nền: Caro', dark: 'Nền: Tối', light: 'Nền: Sáng' };
      this.bgMode = order[(order.indexOf(this.bgMode) + 1) % order.length];
      $('btn-anim-bg').textContent = labels[this.bgMode];
      this.renderCurrentFrame();
    });

    $('btn-anim-new').addEventListener('click', async () => {
      const nameInput = el('input', { type: 'text', value: `Nhóm ${this.app.store.project.animations.length + 1}`, style: { width: '100%' } });
      const choice = await showChoiceDialog({
        title: 'Tạo nhóm animation mới',
        message: el('div', { className: 'form-field' }, [
          el('label', { text: 'Tên nhóm animation:' }),
          nameInput
        ]),
        buttons: [
          { label: 'Hủy', value: 'cancel' },
          { label: 'Tạo nhóm', value: 'ok', className: 'btn-primary', autofocus: true }
        ]
      });
      if (choice === 'ok') {
        const res = this.app.store.addAnimation({ name: nameInput.value.trim() || 'Animation mới' });
        if (res.committed && res.result) {
          this.activeAnimId = res.result;
          this.onProjectChanged();
        }
      }
    });

    $('btn-anim-from-row').addEventListener('click', () => {
      const pos = this.app.activeCellKey ? parseCellKey(this.app.activeCellKey) : { row: 0, col: 0 };
      const { cols } = this.app.store.project.grid;
      const frames = [];
      for (let c = 0; c < cols; c++) {
        if (this.app.store.project.cells[cellKey(pos.row, c)]) {
          frames.push({ row: pos.row, col: c, durationMs: null });
        }
      }
      if (frames.length === 0) {
        for (let c = 0; c < cols; c++) frames.push({ row: pos.row, col: c, durationMs: null });
      }
      const res = this.app.store.addAnimation({ name: `Hàng ${pos.row + 1}`, frames });
      if (res.committed && res.result) {
        this.activeAnimId = res.result;
        this.onProjectChanged();
        showToast(`Đã tạo nhóm "Hàng ${pos.row + 1}" (${frames.length} frame).`, 'ok');
      }
    });

    $('btn-anim-from-sel').addEventListener('click', () => {
      const coords = [...this.app.selectedCells]
        .map(parseCellKey)
        .filter(Boolean)
        .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
      if (coords.length === 0) {
        showToast('Hãy chọn ít nhất một ô trên lưới trước.', 'warn');
        return;
      }
      const frames = coords.map((p) => ({ row: p.row, col: p.col, durationMs: null }));
      const res = this.app.store.addAnimation({ name: `Vùng chọn (${frames.length})`, frames });
      if (res.committed && res.result) {
        this.activeAnimId = res.result;
        this.onProjectChanged();
        showToast(`Đã tạo nhóm từ ${frames.length} ô đã chọn.`, 'ok');
      }
    });

    $('btn-anim-add-sel').addEventListener('click', () => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      const coords = [...this.app.selectedCells]
        .map(parseCellKey)
        .filter(Boolean)
        .sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
      if (coords.length === 0) {
        showToast('Chọn ít nhất một ô trên lưới để thêm vào timeline.', 'warn');
        return;
      }
      const nextFrames = [...anim.frames, ...coords.map((p) => ({ row: p.row, col: p.col, durationMs: null }))];
      this.app.store.updateAnimation(anim.id, { frames: nextFrames }, 'Thêm frame vào timeline');
    });

    $('btn-anim-dup').addEventListener('click', () => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      const res = this.app.store.duplicateAnimation(anim.id);
      if (res.committed && res.result) {
        this.activeAnimId = res.result;
        this.onProjectChanged();
      }
    });

    $('btn-anim-del').addEventListener('click', async () => {
      const anim = this.getActiveAnimation();
      if (!anim) return;
      const choice = await showChoiceDialog({
        title: 'Xóa nhóm animation',
        message: `Xóa nhóm "${anim.name}"? Các ảnh trên lưới atlas sẽ KHÔNG bị xóa.`,
        buttons: [
          { label: 'Hủy', value: 'cancel', autofocus: true },
          { label: 'Xóa nhóm', value: 'del', className: 'btn-danger' }
        ]
      });
      if (choice === 'del') {
        this.app.store.deleteAnimation(anim.id);
      }
    });

    $('btn-anim-edit').addEventListener('click', () => {
      const anim = this.getActiveAnimation();
      if (anim) this.app.modals.openAnimSettingsModal(anim);
    });
  }
}
