/**
 * Sprite Sheet Builder V2.0 — Modal Dialog Controllers (Spec §§4–12).
 * Implements Batch Import, Slice Engine, Manual Region Editor, Transform Sync,
 * Preset Manager, Preflight Inspector, Export Engine UI, Settings/Recovery, and Group Settings.
 */

import {
  LIMITS,
  cellKey,
  parseCellKey,
  generateId,
  sanitizeFilename,
  formatBytes,
  formatNumber,
  deepClone,
  mimeToExt
} from '../core/constants.js';
import { planBatchImport, computeSliceGrid } from '../core/batch-slice.js';
import { planTransformSync } from '../core/sync-engine.js';
import { runPreflight } from '../core/preflight.js';
import { validatePresetV1 } from '../core/validator.js';
import { executeExportJob, triggerBlobDownload } from '../engine/export-engine.js';
import { $, clearEl, el, showChoiceDialog, showToast } from './dom-helpers.js';

export class ModalsController {
  constructor(app) {
    this.app = app;
    // Wire close buttons on dialogs
    document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dlg = $(btn.dataset.closeDialog);
        if (dlg && dlg.open) dlg.close('cancel');
      });
    });
  }

  // =========================================================================
  // 1. BATCH IMPORT PREVIEW MODAL (Spec §5.2)
  // =========================================================================
  openBatchImportModal(items, opts = {}) {
    const dlg = $('dialog-batch');
    const body = $('batch-body');
    const footer = $('batch-footer');
    const startRev = this.app.store.revision;
    const startProjId = this.app.store.project.projectId;

    const state = {
      items: items.map((it, idx) => ({ ...it, importIndex: it.importIndex ?? idx })),
      mode: opts.mode || (this.app.store.project.presetId ? 'preset-expected' : 'from-cursor-row'),
      startCell: opts.startCell || (this.app.activeCellKey ? parseCellKey(this.app.activeCellKey) : { row: 0, col: 0 }),
      animationId: opts.animationId || this.app.animationView.getActiveAnimation()?.id || '',
      sortMode: opts.sortMode || 'natural',
      occupiedPolicy: 'skip',
      allowPresetUnused: false,
      onlyValidAccepted: false,
      overwriteConfirmed: false,
      preserveBlankSlots: Boolean(opts.preserveBlankSlots),
      isLibraryAssets: Boolean(opts.isLibraryAssets),
      onBeforeCommit: opts.onBeforeCommit || null
    };

    const render = () => {
      clearEl(body);
      clearEl(footer);

      const project = this.app.store.project;
      const plan = planBatchImport({
        project,
        items: state.items,
        mode: state.mode,
        startCell: state.startCell,
        selectedCells: [...this.app.selectedCells],
        animationId: state.animationId || null,
        occupiedPolicy: state.occupiedPolicy,
        allowPresetUnused: state.allowPresetUnused,
        sortMode: state.sortMode,
        onlyValidAccepted: state.onlyValidAccepted,
        preserveBlankSlots: state.preserveBlankSlots
      });

      // Controls row 1
      const modeSel = el('select', {
        onChange: (e) => { state.mode = e.target.value; render(); }
      }, [
        el('option', { value: 'from-cursor-row', text: `Từ ô (${state.startCell.row + 1},${state.startCell.col + 1}) theo hàng`, selected: state.mode === 'from-cursor-row' }),
        el('option', { value: 'from-cursor-col', text: `Từ ô (${state.startCell.row + 1},${state.startCell.col + 1}) theo cột`, selected: state.mode === 'from-cursor-col' }),
        el('option', { value: 'selected-cells', text: `Các ô đang chọn (${this.app.selectedCells.size} ô)`, selected: state.mode === 'selected-cells' }),
        el('option', { value: 'animation-group', text: 'Vào nhóm animation đã chọn', selected: state.mode === 'animation-group' }),
        el('option', { value: 'preset-expected', text: 'Các ô dự kiến còn trống của Preset', selected: state.mode === 'preset-expected' })
      ]);

      const sortSel = el('select', {
        onChange: (e) => { state.sortMode = e.target.value; render(); }
      }, [
        el('option', { value: 'natural', text: 'Tên tự nhiên (frame2 < frame10)', selected: state.sortMode === 'natural' }),
        el('option', { value: 'import', text: 'Thứ tự nhập', selected: state.sortMode === 'import' }),
        el('option', { value: 'reverse-natural', text: 'Đảo ngược tên tự nhiên', selected: state.sortMode === 'reverse-natural' }),
        el('option', { value: 'reverse-import', text: 'Đảo ngược thứ tự nhập', selected: state.sortMode === 'reverse-import' }),
        el('option', { value: 'manual', text: 'Thứ tự thủ công', selected: state.sortMode === 'manual' })
      ]);

      const occSel = el('select', {
        onChange: (e) => { state.occupiedPolicy = e.target.value; state.overwriteConfirmed = false; render(); }
      }, [
        el('option', { value: 'skip', text: 'Bỏ qua ô đã có ảnh (mặc định)', selected: state.occupiedPolicy === 'skip' }),
        el('option', { value: 'overwrite', text: 'Ghi đè ô đã có ảnh (cần xác nhận)', selected: state.occupiedPolicy === 'overwrite' })
      ]);

      const controls = el('div', { className: 'form-grid-2' }, [
        el('div', { className: 'form-field' }, [el('label', { text: 'Chế độ điền ô' }), modeSel]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Sắp xếp danh sách ảnh' }), sortSel]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Chính sách ô đã có ảnh' }), occSel])
      ]);

      if (state.mode === 'animation-group') {
        const animSel = el('select', {
          onChange: (e) => { state.animationId = e.target.value; render(); }
        }, project.animations.length === 0
          ? [el('option', { value: '', text: '(Không có nhóm nào)' })]
          : project.animations.map((a) => el('option', { value: a.id, text: `${a.name} (${a.frames.length} slot)`, selected: a.id === state.animationId }))
        );
        controls.appendChild(el('div', { className: 'form-field' }, [el('label', { text: 'Nhóm animation đích' }), animSel]));
      }

      body.appendChild(controls);

      // Preset unused toggle
      if (project.expectedCells) {
        const allowUnusedChk = el('input', {
          type: 'checkbox',
          checked: state.allowPresetUnused,
          onChange: (e) => { state.allowPresetUnused = e.target.checked; render(); }
        });
        body.appendChild(el('label', { className: 'form-row' }, [allowUnusedChk, 'Cho phép điền vào ô dư của Preset']));
      }

      // Invalid files banner (blocks commit until user explicitly clicks "Chỉ nhập ảnh hợp lệ")
      if (plan.invalidItems.length > 0) {
        const errBox = el('div', { className: 'alert-box is-error' }, [
          el('strong', { text: `Phát hiện ${plan.invalidItems.length} file không hợp lệ:` }),
          el('ul', { style: { margin: '4px 0 6px 18px', padding: 0 } },
            plan.invalidItems.map((it) => el('li', { text: `${it.name}: ${it.error || 'Định dạng không hỗ trợ'}` }))
          )
        ]);
        if (!state.onlyValidAccepted) {
          errBox.appendChild(el('button', {
            type: 'button',
            className: 'btn-sm btn-warn',
            text: `Chỉ nhập ảnh hợp lệ (${state.items.length - plan.invalidItems.length} ảnh)`,
            onClick: () => { state.onlyValidAccepted = true; render(); }
          }));
        } else {
          errBox.appendChild(el('div', { style: { fontWeight: '600' }, text: 'Đã chọn chế độ chỉ nhập ảnh hợp lệ. Các file lỗi sẽ bị bỏ qua.' }));
        }
        body.appendChild(errBox);
      }

      // Summary stats
      const summary = el('div', { className: 'alert-box' }, [
        `Sẽ điền: ${plan.assignments.length} ảnh • `,
        `Ghi đè: ${plan.overwritten.length} • `,
        `Bỏ qua ô có ảnh: ${plan.skippedOccupiedSlots.length} • `,
        `Ảnh dư (vượt phạm vi): ${plan.overflowItems.length} • `,
        `Ô trống còn lại trong phạm vi: ${plan.remainingEmptySlots}`
      ]);
      body.appendChild(summary);

      if (plan.overflowItems.length > 0) {
        body.appendChild(el('div', { className: 'alert-box is-warn' }, [
          `Cảnh báo: Có ${plan.overflowItems.length} ảnh dư vượt quá số ô khả dụng trong phạm vi chọn. Ứng dụng sẽ KHÔNG tự tăng lưới hay tràn sang nhóm khác; các ảnh dư vẫn có thể nhập vào thư viện riêng.`
        ]));
      }

      if (plan.overwritten.length > 0) {
        const chk = el('input', {
          type: 'checkbox',
          checked: state.overwriteConfirmed,
          onChange: (e) => { state.overwriteConfirmed = e.target.checked; render(); }
        });
        body.appendChild(el('div', { className: 'alert-box is-warn' }, [
          el('label', { className: 'form-row' }, [
            chk,
            `Tôi xác nhận ghi đè ${plan.overwritten.length} ô đã có ảnh (ảnh mới dùng transform mặc định).`
          ])
        ]));
      }

      // Preview mapping table with manual Up/Down reorder
      const table = el('table', { className: 'data-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: '#' }),
          el('th', { text: 'Tên ảnh' }),
          el('th', { text: 'Ô đích' }),
          el('th', { text: 'Trạng thái' }),
          el('th', { text: 'Sắp xếp' })
        ])),
        el('tbody', {}, plan.assignments.map((a, idx) => el('tr', {}, [
          el('td', { text: String(idx + 1) }),
          el('td', { text: a.item.name }),
          el('td', { text: `Hàng ${a.row + 1}, Cột ${a.col + 1}` }),
          el('td', {}, el('span', {
            className: a.willOverwrite ? 'badge badge-warn' : 'badge badge-accent',
            text: a.willOverwrite ? 'Ghi đè' : 'Điền mới'
          })),
          el('td', {}, [
            el('button', {
              type: 'button',
              className: 'btn-xs',
              text: '↑',
              disabled: idx === 0,
              title: 'Đưa lên trên',
              onClick: () => {
                // Switch to manual order matching current assignments
                const validOrdered = plan.assignments.map((x) => x.item).concat(plan.overflowItems);
                [validOrdered[idx - 1], validOrdered[idx]] = [validOrdered[idx], validOrdered[idx - 1]];
                state.items = validOrdered.concat(plan.invalidItems);
                state.sortMode = 'manual';
                render();
              }
            }),
            ' ',
            el('button', {
              type: 'button',
              className: 'btn-xs',
              text: '↓',
              disabled: idx === plan.assignments.length - 1,
              title: 'Đưa xuống dưới',
              onClick: () => {
                const validOrdered = plan.assignments.map((x) => x.item).concat(plan.overflowItems);
                [validOrdered[idx + 1], validOrdered[idx]] = [validOrdered[idx], validOrdered[idx + 1]];
                state.items = validOrdered.concat(plan.invalidItems);
                state.sortMode = 'manual';
                render();
              }
            })
          ])
        ])))
      ]);
      body.appendChild(el('div', { className: 'table-scroll' }, table));

      // Footer buttons
      const cancelBtn = el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') });
      const canSubmit = plan.canCommit && (!plan.needsOverwriteConfirm || state.overwriteConfirmed);

      const commitBtn = el('button', {
        type: 'button',
        className: 'btn-primary',
        disabled: !canSubmit,
        text: `Áp dụng (${plan.assignments.length} ô)`,
        onClick: async () => {
          // Verify revision/project hasn't changed while preview was open (Spec §12.2)
          if (this.app.store.project.projectId !== startProjId || this.app.store.revision !== startRev) {
            showToast('Project đã thay đổi trong lúc xem trước batch. Hãy kiểm tra lại ánh xạ.', 'warn');
            render();
            return;
          }
          if (state.onBeforeCommit) {
            await state.onBeforeCommit(plan);
          } else {
            this._commitBatchPlan(plan, state.isLibraryAssets);
          }
          dlg.close('ok');
        }
      });

      footer.appendChild(cancelBtn);
      footer.appendChild(commitBtn);
    };

    render();
    dlg.showModal();
  }

  _commitBatchPlan(plan, isLibraryAssets) {
    const newSources = [];
    const newAssets = [];
    const assignments = [];
    const usage = this.app.store.getProjectResourceUsage();
    let addedPixels = 0;
    let addedBytes = 0;

    for (const a of plan.assignments) {
      if (isLibraryAssets) {
        assignments.push({ row: a.row, col: a.col, assetId: a.item.assetId });
      } else {
        const src = a.item.source;
        addedPixels += src.width * src.height;
        addedBytes += src.byteLength;
        if (usage.totalSourcePixels + addedPixels > LIMITS.MAX_PROJECT_SOURCE_PIXELS) {
          showToast('Vượt ngân sách 256 Mi pixel nguồn ảnh của project — đã hủy batch.', 'error');
          return;
        }
        if (usage.totalSourceBytes + addedBytes > LIMITS.MAX_PROJECT_SOURCE_BYTES) {
          showToast('Vượt ngân sách 256 MiB dung lượng nguồn ảnh của project — đã hủy batch.', 'error');
          return;
        }
        this.app.assetManager.registerSourceBinary(src.id, a.item.bytes, src.mime);
        newSources.push(src);
        const assetId = generateId('asset');
        newAssets.push({
          id: assetId,
          sourceId: src.id,
          name: src.name.replace(/\.[^.]+$/, '') || src.name,
          isRegion: false,
          region: { x: 0, y: 0, w: src.width, h: src.height }
        });
        assignments.push({ row: a.row, col: a.col, assetId });
      }
    }

    this.app.store.addSourcesAndAssets(
      `Nhập hàng loạt ${assignments.length} ảnh`,
      newSources,
      newAssets,
      assignments
    );
    showToast(`Đã điền ${assignments.length} ảnh vào lưới (1 bước Undo).`, 'ok');
  }

  // =========================================================================
  // 2. SLICE ENGINE MODAL (Spec §5.3)
  // =========================================================================
  openSliceModal(initialSourceId = null) {
    const dlg = $('dialog-slice');
    const body = $('slice-body');
    const footer = $('slice-footer');

    const sources = this.app.store.project.sources;
    const state = {
      sourceId: initialSourceId || sources[0]?.id || '',
      mode: 'by-count',
      cols: 4,
      rows: 1,
      frameWidth: 192,
      frameHeight: 208,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      marginBottom: 0,
      gapX: 0,
      gapY: 0,
      zoom: 1,
      skipTransparent: false,
      preserveBlankSlots: false,
      remainderConfirmed: false,
      transparentMap: new Map(),
      excludedIndices: new Set(),
      activePreviewIdx: 0
    };

    const previewCanvas = el('canvas', { style: { display: 'block' } });

    const drawOverlay = async (sliceRes) => {
      const src = this.app.store.getSource(state.sourceId);
      if (!src) return;
      const bmp = await this.app.assetManager.getSourceBitmap(src.id);
      if (!bmp) return;
      const z = state.zoom;
      const w = Math.max(1, Math.round(src.width * z));
      const h = Math.max(1, Math.round(src.height * z));
      previewCanvas.width = w;
      previewCanvas.height = h;
      const ctx = previewCanvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.scale(z, z);
      ctx.drawImage(bmp, 0, 0);

      if (sliceRes.ok) {
        for (const reg of sliceRes.regions) {
          const isSkippedTrans = state.skipTransparent && state.transparentMap.get(reg.index) === true;
          const isExcluded = state.excludedIndices.has(reg.index) || isSkippedTrans;
          ctx.fillStyle = isExcluded ? 'rgba(239, 68, 68, 0.35)' : (reg.index === state.activePreviewIdx ? 'rgba(59, 130, 246, 0.25)' : 'rgba(34, 197, 94, 0.08)');
          ctx.fillRect(reg.x, reg.y, reg.w, reg.h);
          ctx.strokeStyle = isExcluded ? '#ef4444' : '#22c55e';
          ctx.lineWidth = Math.max(1 / z, 1);
          ctx.strokeRect(reg.x + 0.5 / z, reg.y + 0.5 / z, reg.w - 1 / z, reg.h - 1 / z);
          ctx.fillStyle = '#ffffff';
          ctx.font = `${Math.max(10, Math.round(12 / z))}px monospace`;
          ctx.fillText(String(reg.index + 1), reg.x + 3 / z, reg.y + 13 / z);
        }
      }
      ctx.restore();
    };

    const render = () => {
      clearEl(body);
      clearEl(footer);

      const allSources = this.app.store.project.sources;
      const src = this.app.store.getSource(state.sourceId);

      // Source picker row
      const srcSel = el('select', {
        style: { flex: '1' },
        onChange: (e) => {
          state.sourceId = e.target.value;
          state.transparentMap.clear();
          state.excludedIndices.clear();
          state.remainderConfirmed = false;
          render();
        }
      }, allSources.length === 0
        ? [el('option', { value: '', text: '(Chưa có ảnh nguồn — bấm Chọn file ảnh mới)' })]
        : allSources.map((s) => el('option', { value: s.id, text: `${s.name} (${s.width}×${s.height} px)`, selected: s.id === state.sourceId }))
      );

      const pickNewBtn = el('button', {
        type: 'button',
        className: 'btn-sm',
        text: 'Chọn file ảnh mới...',
        onClick: () => {
          const inp = $('file-slice-image');
          inp.value = '';
          inp.onchange = async () => {
            const f = inp.files?.[0];
            if (!f) return;
            const res = await this.app.assetManager.inspectAndVerifyFile(f);
            if (!res.ok) {
              showToast(`Không thể mở ảnh để tách: ${res.error}`, 'error');
              return;
            }
            this.app.assetManager.registerSourceBinary(res.source.id, res.bytes, res.source.mime);
            const fullAsset = {
              id: generateId('asset'),
              sourceId: res.source.id,
              name: res.source.name.replace(/\.[^.]+$/, ''),
              isRegion: false,
              region: { x: 0, y: 0, w: res.source.width, h: res.source.height }
            };
            this.app.store.addSourcesAndAssets('Nhập nguồn để tách atlas', [res.source], [fullAsset], []);
            state.sourceId = res.source.id;
            state.transparentMap.clear();
            state.excludedIndices.clear();
            render();
          };
          inp.click();
        }
      });

      body.appendChild(el('div', { className: 'form-row' }, [
        el('label', { text: 'Ảnh nguồn:' }),
        srcSel,
        pickNewBtn
      ]));

      if (!src) {
        body.appendChild(el('div', { className: 'alert-box' }, 'Chọn ảnh có sẵn trong thư viện hoặc tải một file atlas/strip mới để bắt đầu tách.'));
        footer.appendChild(el('button', { type: 'button', text: 'Đóng', onClick: () => dlg.close('cancel') }));
        return;
      }

      const sliceRes = computeSliceGrid({
        imageWidth: src.width,
        imageHeight: src.height,
        mode: state.mode,
        cols: state.cols,
        rows: state.rows,
        frameWidth: state.frameWidth,
        frameHeight: state.frameHeight,
        marginLeft: state.marginLeft,
        marginRight: state.marginRight,
        marginTop: state.marginTop,
        marginBottom: state.marginBottom,
        gapX: state.gapX,
        gapY: state.gapY
      });

      const mkNum = (label, key, min = 0) => el('div', { className: 'form-field' }, [
        el('label', { text: label }),
        el('input', {
          type: 'number',
          min,
          step: 1,
          value: state[key],
          onChange: (e) => {
            state[key] = parseInt(e.target.value, 10) || 0;
            state.transparentMap.clear();
            state.remainderConfirmed = false;
            render();
          }
        })
      ]);

      const modeSel = el('select', {
        onChange: (e) => { state.mode = e.target.value; state.remainderConfirmed = false; render(); }
      }, [
        el('option', { value: 'by-count', text: 'Theo số cột & hàng (chia hết nguyên)', selected: state.mode === 'by-count' }),
        el('option', { value: 'by-size', text: 'Theo kích thước frame (W × H)', selected: state.mode === 'by-size' })
      ]);

      const gridParams = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' } }, [
        el('div', { className: 'form-field', style: { gridColumn: 'span 2' } }, [el('label', { text: 'Chế độ tách' }), modeSel]),
        state.mode === 'by-count' ? mkNum('Số cột', 'cols', 1) : mkNum('Rộng frame (px)', 'frameWidth', 1),
        state.mode === 'by-count' ? mkNum('Số hàng', 'rows', 1) : mkNum('Cao frame (px)', 'frameHeight', 1),
        mkNum('Margin trái', 'marginLeft', 0),
        mkNum('Margin phải', 'marginRight', 0),
        mkNum('Margin trên', 'marginTop', 0),
        mkNum('Margin dưới', 'marginBottom', 0),
        mkNum('Gap ngang', 'gapX', 0),
        mkNum('Gap dọc', 'gapY', 0),
        el('div', { className: 'form-field', style: { gridColumn: 'span 2' } }, [
          el('label', { text: `Zoom xem trước (${Math.round(state.zoom * 100)}%)` }),
          el('input', {
            type: 'range',
            min: 25,
            max: 300,
            step: 25,
            value: Math.round(state.zoom * 100),
            onInput: (e) => { state.zoom = Number(e.target.value) / 100; drawOverlay(sliceRes); }
          })
        ])
      ]);
      body.appendChild(gridParams);

      if (!sliceRes.ok) {
        body.appendChild(el('div', { className: 'alert-box is-error' }, sliceRes.errors.join(' ')));
      } else {
        body.appendChild(el('div', { className: 'alert-box is-ok' },
          `Kết quả suy ra: ${sliceRes.cols} cột × ${sliceRes.rows} hàng = ${sliceRes.regions.length} vùng (${sliceRes.frameWidth}×${sliceRes.frameHeight} px/vùng).` +
          (sliceRes.hasRemainder ? ` Phần dư không cắt: ngang ${sliceRes.remainderX} px, dọc ${sliceRes.remainderY} px.` : '')
        ));

        if (sliceRes.hasRemainder) {
          body.appendChild(el('div', { className: 'alert-box is-warn' }, el('label', { className: 'form-row' }, [
            el('input', {
              type: 'checkbox',
              checked: state.remainderConfirmed,
              onChange: (e) => { state.remainderConfirmed = e.target.checked; render(); }
            }),
            `Xác nhận bỏ qua phần dư (${sliceRes.remainderX}×${sliceRes.remainderY} px), không cắt ô thiếu kích thước.`
          ])));
        }

        // Skip alpha === 0 & preserve blanks toggles
        const skipAlphaChk = el('input', {
          type: 'checkbox',
          checked: state.skipTransparent,
          onChange: async (e) => {
            state.skipTransparent = e.target.checked;
            if (state.skipTransparent && state.transparentMap.size === 0) {
              state.transparentMap = await this.app.assetManager.checkRegionsTransparency(src.id, sliceRes.regions);
            }
            render();
          }
        });

        const keepBlankChk = el('input', {
          type: 'checkbox',
          checked: state.preserveBlankSlots,
          onChange: (e) => { state.preserveBlankSlots = e.target.checked; }
        });

        body.appendChild(el('div', { className: 'form-row' }, [
          el('label', { className: 'form-row' }, [skipAlphaChk, 'Bỏ qua vùng hoàn toàn trong suốt (alpha = 0)']),
          el('label', { className: 'form-row', style: { marginLeft: '12px' } }, [keepBlankChk, 'Giữ khoảng trống slot khi điền lưới'])
        ]));
      }

      // Clickable preview canvas to toggle include/exclude individual slice
      previewCanvas.onclick = (e) => {
        if (!sliceRes.ok) return;
        const rect = previewCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / state.zoom;
        const y = (e.clientY - rect.top) / state.zoom;
        const hit = sliceRes.regions.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        if (hit) {
          if (state.excludedIndices.has(hit.index)) state.excludedIndices.delete(hit.index);
          else state.excludedIndices.add(hit.index);
          state.activePreviewIdx = hit.index;
          drawOverlay(sliceRes);
        }
      };

      body.appendChild(el('div', { className: 'slice-stage' }, previewCanvas));
      drawOverlay(sliceRes);

      const canCommit = sliceRes.ok && (!sliceRes.hasRemainder || state.remainderConfirmed);
      const buildSliceAssets = () => {
        const baseName = src.name.replace(/\.[^.]+$/, '') || 'slice';
        const createdAssets = [];
        const batchItems = [];
        for (const reg of sliceRes.regions) {
          const isSkipped = state.excludedIndices.has(reg.index) || (state.skipTransparent && state.transparentMap.get(reg.index) === true);
          if (isSkipped) {
            batchItems.push({ id: `blank_${reg.index}`, name: `blank_${reg.index}`, valid: true, isBlankSlot: true, importIndex: reg.index });
            continue;
          }
          const aid = generateId('asset');
          const name = `${baseName}_r${reg.row + 1}c${reg.col + 1}`;
          createdAssets.push({
            id: aid,
            sourceId: src.id,
            name,
            isRegion: true,
            region: { x: reg.x, y: reg.y, w: reg.w, h: reg.h }
          });
          batchItems.push({ id: aid, assetId: aid, name, valid: true, isBlankSlot: false, importIndex: reg.index });
        }
        return { createdAssets, batchItems };
      };

      footer.appendChild(el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') }));
      footer.appendChild(el('button', {
        type: 'button',
        disabled: !canCommit,
        text: 'Thêm vào Thư viện',
        onClick: () => {
          const { createdAssets } = buildSliceAssets();
          if (createdAssets.length === 0) {
            showToast('Không có vùng cắt hợp lệ nào được chọn.', 'warn');
            return;
          }
          this.app.store.addSourcesAndAssets(`Tách ${createdAssets.length} vùng từ "${src.name}"`, [], createdAssets, []);
          showToast(`Đã tạo ${createdAssets.length} asset vùng cắt (dùng chung 1 ảnh nguồn, không resample).`, 'ok');
          dlg.close('ok');
        }
      }));
      footer.appendChild(el('button', {
        type: 'button',
        className: 'btn-primary',
        disabled: !canCommit,
        text: 'Tách & Điền vào lưới...',
        onClick: () => {
          const { createdAssets, batchItems } = buildSliceAssets();
          if (createdAssets.length === 0) {
            showToast('Không có vùng cắt hợp lệ nào để điền.', 'warn');
            return;
          }
          dlg.close('batch');
          this.openBatchImportModal(batchItems, {
            sortMode: 'import',
            preserveBlankSlots: state.preserveBlankSlots,
            isLibraryAssets: true,
            onBeforeCommit: (plan) => {
              const assignments = plan.assignments.map((a) => ({ row: a.row, col: a.col, assetId: a.item.assetId }));
              this.app.store.addSourcesAndAssets(
                `Tách & điền ${assignments.length} frame từ "${src.name}"`,
                [],
                createdAssets,
                assignments
              );
              showToast(`Đã tách ${createdAssets.length} vùng và điền ${assignments.length} ô (1 bước Undo).`, 'ok');
            }
          });
        }
      }));
    };

    render();
    dlg.showModal();
  }

  // =========================================================================
  // 3. MANUAL REGION EDITOR MODAL (Spec §5.3)
  // =========================================================================
  openManualRegionModal(assetId) {
    const asset = this.app.store.getAsset(assetId);
    const src = asset ? this.app.store.getSource(asset.sourceId) : null;
    if (!asset || !src) return;

    const dlg = $('dialog-region');
    const body = $('region-body');
    const footer = $('region-footer');
    const usageCount = this.app.store.getAssetUsageMap().get(assetId) || 0;

    const reg = { ...asset.region };
    const canvas = el('canvas', { style: { display: 'block', maxWidth: '100%' } });

    const drawPreview = async () => {
      const bmp = await this.app.assetManager.getSourceBitmap(src.id);
      if (!bmp) return;
      const scale = Math.min(440 / src.width, 240 / src.height, 1);
      canvas.width = Math.max(1, Math.round(src.width * scale));
      canvas.height = Math.max(1, Math.round(src.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.scale(scale, scale);
      ctx.drawImage(bmp, 0, 0);
      ctx.strokeStyle = '#3b82f6';
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
      ctx.lineWidth = Math.max(2 / scale, 2);
      ctx.fillRect(reg.x, reg.y, reg.w, reg.h);
      ctx.strokeRect(reg.x, reg.y, reg.w, reg.h);
      ctx.restore();
    };

    const render = () => {
      clearEl(body);
      clearEl(footer);

      const valid =
        Number.isInteger(reg.x) && Number.isInteger(reg.y) &&
        Number.isInteger(reg.w) && Number.isInteger(reg.h) &&
        reg.x >= 0 && reg.y >= 0 && reg.w >= 1 && reg.h >= 1 &&
        reg.x + reg.w <= src.width && reg.y + reg.h <= src.height;

      body.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--text-muted)' }, text: `Nguồn: ${src.name} (${src.width}×${src.height} px)` }));
      const mk = (lbl, k) => el('div', { className: 'form-field' }, [
        el('label', { text: lbl }),
        el('input', {
          type: 'number',
          step: 1,
          value: reg[k],
          onChange: (e) => { reg[k] = parseInt(e.target.value, 10) || 0; render(); }
        })
      ]);
      body.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '6px' } }, [
        mk('X (px)', 'x'), mk('Y (px)', 'y'), mk('Rộng W', 'w'), mk('Cao H', 'h')
      ]));

      if (!valid) {
        body.appendChild(el('div', { className: 'alert-box is-error' }, `Vùng cắt phải là số nguyên nằm hoàn toàn trong ảnh (${src.width}×${src.height}).`));
      }
      if (usageCount > 0) {
        body.appendChild(el('div', { className: 'alert-box is-warn' }, `Asset này đang được sử dụng bởi ${usageCount} ô trên lưới. Bạn có thể tạo asset mới để không ảnh hưởng các ô cũ, hoặc xác nhận cập nhật cả ${usageCount} ô.`));
      }

      body.appendChild(el('div', { className: 'slice-stage' }, canvas));
      drawPreview();

      footer.appendChild(el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') }));
      footer.appendChild(el('button', {
        type: 'button',
        disabled: !valid,
        text: 'Tạo asset mới',
        onClick: () => {
          this.app.store.updateAssetRegion(assetId, reg, { createNew: true, newName: `${asset.name}_cut` });
          showToast('Đã tạo asset vùng cắt mới trong thư viện.', 'ok');
          dlg.close('ok');
        }
      }));
      footer.appendChild(el('button', {
        type: 'button',
        className: 'btn-primary',
        disabled: !valid,
        text: usageCount > 0 ? `Cập nhật vùng (${usageCount} ô)` : 'Lưu vùng cắt',
        onClick: () => {
          this.app.store.updateAssetRegion(assetId, reg, { createNew: false });
          showToast('Đã cập nhật vùng cắt.', 'ok');
          dlg.close('ok');
        }
      }));
    };

    render();
    dlg.showModal();
  }

  // =========================================================================
  // 4. TRANSFORM SYNC MODAL (Spec §6.5)
  // =========================================================================
  async openTransformSyncModal() {
    const okDraft = await this.app.ensureDraftResolved();
    if (!okDraft) return;

    const project = this.app.store.project;
    const filledKeys = Object.keys(project.cells);
    if (filledKeys.length === 0) {
      showToast('Chưa có ô nào chứa ảnh để đồng bộ căn chỉnh.', 'warn');
      return;
    }

    // Ensure alpha analysis is pre-populated for all filled cells (mask-aware)
    for (const k of filledKeys) {
      const c = project.cells[k];
      const a = this.app.store.getAsset(c.assetId);
      const s = a ? this.app.store.getSource(a.sourceId) : null;
      if (a && s) await this.app.assetManager.analyzeCellPixels(a, s, c.alphaThreshold, c.mask);
    }

    const dlg = $('dialog-sync');
    const body = $('sync-body');
    const footer = $('sync-footer');

    const refDefault =
      (this.app.referenceCellKey && project.cells[this.app.referenceCellKey] ? this.app.referenceCellKey : null) ||
      (this.app.activeCellKey && project.cells[this.app.activeCellKey] ? this.app.activeCellKey : null) ||
      filledKeys[0];

    const state = {
      referenceKey: refDefault,
      scope: this.app.selectedCells.size > 1 ? 'selected' : 'all',
      groupId: this.app.animationView.getActiveAnimation()?.id || '',
      rowIdx: parseCellKey(refDefault)?.row ?? 0,
      mode: 'sync-scale-and-anchor',
      copyFields: 'all',
      scaleDimension: 'height',
      anchorTargetType: 'reference-anchor',
      anchorAxis: 'both',
      customX: project.settings.guides.x * project.grid.cellWidth,
      customY: project.settings.guides.y * project.grid.cellHeight,
      skipInvalidConfirmed: false
    };

    const getTargetKeys = () => {
      if (state.scope === 'selected') return [...this.app.selectedCells];
      if (state.scope === 'group') {
        const anim = project.animations.find((a) => a.id === state.groupId);
        return anim ? anim.frames.map((f) => cellKey(f.row, f.col)) : [];
      }
      if (state.scope === 'row') {
        const keys = [];
        for (let c = 0; c < project.grid.cols; c++) keys.push(cellKey(state.rowIdx, c));
        return keys;
      }
      return Object.keys(project.cells);
    };

    const render = () => {
      clearEl(body);
      clearEl(footer);

      const targetKeys = getTargetKeys();
      const plan = planTransformSync({
        project,
        referenceKey: state.referenceKey,
        targetKeys,
        mode: state.mode,
        copyFields: state.copyFields,
        scaleDimension: state.scaleDimension,
        anchorTargetType: state.anchorTargetType,
        anchorAxis: state.anchorAxis,
        customTargetPx: { x: state.customX, y: state.customY },
        activeGuidesNormalized: project.settings.guides,
        getAlphaBounds: (aid, thr, cell) => {
          const asset = this.app.store.getAsset(aid);
          return asset ? (this.app.assetManager.getCachedCellPixelAnalysis(asset, thr, cell?.mask)?.alphaBounds || null) : null;
        },
        skipInvalidConfirmed: state.skipInvalidConfirmed
      });

      const refSel = el('select', {
        onChange: (e) => { state.referenceKey = e.target.value; render(); }
      }, filledKeys.map((k) => {
        const p = parseCellKey(k);
        return el('option', { value: k, text: `Ô (${p.row + 1}, ${p.col + 1})`, selected: k === state.referenceKey });
      }));

      const scopeSel = el('select', {
        onChange: (e) => { state.scope = e.target.value; state.skipInvalidConfirmed = false; render(); }
      }, [
        el('option', { value: 'selected', text: `Các ô đang chọn (${this.app.selectedCells.size})`, selected: state.scope === 'selected' }),
        el('option', { value: 'group', text: 'Cả nhóm animation', selected: state.scope === 'group' }),
        el('option', { value: 'row', text: 'Cả một hàng', selected: state.scope === 'row' }),
        el('option', { value: 'all', text: `Toàn bộ ô có ảnh (${filledKeys.length})`, selected: state.scope === 'all' })
      ]);

      const modeSel = el('select', {
        onChange: (e) => { state.mode = e.target.value; state.skipInvalidConfirmed = false; render(); }
      }, [
        el('option', { value: 'copy-transform', text: '1. Sao chép transform (fit mode, zoom, X/Y)', selected: state.mode === 'copy-transform' }),
        el('option', { value: 'sync-scale', text: '2. Đồng bộ tỷ lệ hiển thị theo vùng alpha', selected: state.mode === 'sync-scale' }),
        el('option', { value: 'sync-anchor', text: '3. Đồng bộ vị trí anchor (giữ zoom)', selected: state.mode === 'sync-anchor' }),
        el('option', { value: 'sync-scale-and-anchor', text: 'Kết hợp 2 + 3: Đồng bộ tỷ lệ rồi căn anchor', selected: state.mode === 'sync-scale-and-anchor' })
      ]);

      const topGrid = el('div', { className: 'form-grid-2' }, [
        el('div', { className: 'form-field' }, [el('label', { text: 'Ô tham chiếu nguồn' }), refSel]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Phạm vi ô đích' }), scopeSel]),
        el('div', { className: 'form-field', style: { gridColumn: 'span 2' } }, [el('label', { text: 'Chế độ đồng bộ' }), modeSel])
      ]);

      if (state.scope === 'group') {
        const gSel = el('select', {
          onChange: (e) => { state.groupId = e.target.value; render(); }
        }, project.animations.map((a) => el('option', { value: a.id, text: a.name, selected: a.id === state.groupId })));
        topGrid.appendChild(el('div', { className: 'form-field' }, [el('label', { text: 'Nhóm animation' }), gSel]));
      } else if (state.scope === 'row') {
        const rSel = el('select', {
          onChange: (e) => { state.rowIdx = Number(e.target.value); render(); }
        }, Array.from({ length: project.grid.rows }, (_, r) => el('option', { value: r, text: `Hàng ${r + 1}`, selected: r === state.rowIdx })));
        topGrid.appendChild(el('div', { className: 'form-field' }, [el('label', { text: 'Hàng đích' }), rSel]));
      }
      body.appendChild(topGrid);

      // Mode-specific options
      const subOpts = el('div', { className: 'form-row' });
      if (state.mode === 'copy-transform') {
        subOpts.appendChild(el('label', { text: 'Sao chép:' }));
        subOpts.appendChild(el('select', {
          onChange: (e) => { state.copyFields = e.target.value; render(); }
        }, [
          el('option', { value: 'all', text: 'Tất cả (Fit mode + Zoom + X/Y)', selected: state.copyFields === 'all' }),
          el('option', { value: 'zoom', text: 'Chỉ Zoom', selected: state.copyFields === 'zoom' }),
          el('option', { value: 'offset', text: 'Chỉ Offset X/Y', selected: state.copyFields === 'offset' })
        ]));
      }
      if (state.mode === 'sync-scale' || state.mode === 'sync-scale-and-anchor') {
        subOpts.appendChild(el('label', { text: 'Khớp theo:' }));
        subOpts.appendChild(el('select', {
          onChange: (e) => { state.scaleDimension = e.target.value; render(); }
        }, [
          el('option', { value: 'height', text: 'Chiều cao vùng alpha', selected: state.scaleDimension === 'height' }),
          el('option', { value: 'width', text: 'Chiều rộng vùng alpha', selected: state.scaleDimension === 'width' })
        ]));
      }
      if (state.mode === 'sync-anchor' || state.mode === 'sync-scale-and-anchor') {
        subOpts.appendChild(el('label', { text: 'Đích anchor:' }));
        subOpts.appendChild(el('select', {
          onChange: (e) => { state.anchorTargetType = e.target.value; render(); }
        }, [
          el('option', { value: 'reference-anchor', text: 'Anchor đã render của ô tham chiếu', selected: state.anchorTargetType === 'reference-anchor' }),
          el('option', { value: 'guides', text: 'Giao điểm đường gióng project', selected: state.anchorTargetType === 'guides' }),
          el('option', { value: 'custom', text: 'Tọa độ tùy chỉnh', selected: state.anchorTargetType === 'custom' })
        ]));
        subOpts.appendChild(el('select', {
          onChange: (e) => { state.anchorAxis = e.target.value; render(); }
        }, [
          el('option', { value: 'both', text: 'Cả X & Y', selected: state.anchorAxis === 'both' }),
          el('option', { value: 'x', text: 'Chỉ X', selected: state.anchorAxis === 'x' }),
          el('option', { value: 'y', text: 'Chỉ Y', selected: state.anchorAxis === 'y' })
        ]));
      }
      if (subOpts.children.length > 0) body.appendChild(subOpts);

      if (!plan.ok) {
        body.appendChild(el('div', { className: 'alert-box is-error' }, plan.fatalError));
      } else {
        body.appendChild(el('div', { className: 'alert-box' },
          `Hợp lệ: ${plan.validUpdateCount} ô • Lỗi: ${plan.errorCount} • Cảnh báo cắt ảnh: ${plan.warningCount} • Bỏ qua ô trống: ${plan.skippedEmptyCount}`
        ));

        if (plan.errorCount > 0) {
          body.appendChild(el('div', { className: 'alert-box is-error' }, el('label', { className: 'form-row' }, [
            el('input', {
              type: 'checkbox',
              checked: state.skipInvalidConfirmed,
              onChange: (e) => { state.skipInvalidConfirmed = e.target.checked; render(); }
            }),
            `Xác nhận bỏ qua ${plan.errorCount} ô lỗi / vượt giới hạn zoom ${Math.round(LIMITS.MIN_ZOOM * 100)}–${Math.round(LIMITS.MAX_ZOOM * 100)}% (không tự clamp) và áp dụng cho ${plan.validUpdateCount} ô hợp lệ.`
          ])));
        }

        const tbl = el('table', { className: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: 'Ô đích' }),
            el('th', { text: 'Zoom mới' }),
            el('th', { text: 'Offset mới (X, Y)' }),
            el('th', { text: 'Trạng thái / Cảnh báo' })
          ])),
          el('tbody', {}, plan.items.map((it) => el('tr', {}, [
            el('td', { text: `(${it.pos.row + 1}, ${it.pos.col + 1})` }),
            el('td', { text: it.nextCell ? `${formatNumber(it.nextCell.zoom * 100, 1)}%` : '—' }),
            el('td', { text: it.nextCell ? `${formatNumber(it.nextCell.offsetX, 1)}, ${formatNumber(it.nextCell.offsetY, 1)}` : '—' }),
            el('td', {}, it.status === 'error'
              ? el('span', { className: 'badge badge-danger', text: it.error })
              : it.warnings?.length
                ? el('span', { className: 'badge badge-warn', text: it.warnings.join(' ') })
                : el('span', { className: 'badge badge-accent', text: 'OK' })
            )
          ])))
        ]);
        body.appendChild(el('div', { className: 'table-scroll' }, tbl));
      }

      footer.appendChild(el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') }));
      footer.appendChild(el('button', {
        type: 'button',
        className: 'btn-primary',
        disabled: !plan.ok || !plan.canCommit,
        text: `Áp dụng đồng bộ (${plan.validUpdateCount || 0} ô)`,
        onClick: () => {
          this.app.store.applyMultipleCellTransforms(plan.updates, `Đồng bộ căn chỉnh (${plan.validUpdateCount} ô)`);
          showToast(`Đã đồng bộ căn chỉnh cho ${plan.validUpdateCount} ô (1 bước Undo).`, 'ok');
          dlg.close('ok');
        }
      }));
    };

    render();
    dlg.showModal();
  }

  // =========================================================================
  // 5. PRESET MANAGER MODAL (Spec §4.2, §4.3)
  // =========================================================================
  openPresetsModal() {
    const dlg = $('dialog-presets');
    const body = $('presets-body');
    const footer = $('presets-footer');

    const render = () => {
      clearEl(body);
      clearEl(footer);

      const presets = this.app.store.getAllPresets();
      const activeId = this.app.store.project.presetId;

      body.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--text-muted)' }, text: activeId ? `Đang dùng preset: ${activeId}` : 'Project hiện ở chế độ lưới tùy chỉnh.' }));

      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
      for (const preset of presets) {
        const expectedCount = preset.expectedCells?.length ?? preset.grid.cols * preset.grid.rows;
        const totalCells = preset.grid.cols * preset.grid.rows;
        const unusedCount = totalCells - expectedCount;
        const row = el('div', { className: 'alert-box', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } }, [
          el('div', {}, [
            el('strong', { text: preset.name }),
            preset.builtin ? el('span', { className: 'badge badge-accent', text: 'Mặc định', style: { marginLeft: '6px' } }) : null,
            activeId === preset.id ? el('span', { className: 'badge', text: 'Đang dùng', style: { marginLeft: '6px' } }) : null,
            el('div', { style: { fontSize: '11.5px', color: 'var(--text-muted)' }, text: `${preset.grid.cols}×${preset.grid.rows} ô (${preset.grid.cellWidth}×${preset.grid.cellHeight} px) • ${expectedCount} ô dự kiến, ${unusedCount} ô dư • ${preset.animations.length} nhóm` })
          ]),
          el('div', { style: { display: 'flex', gap: '4px', flexShrink: '0' } }, [
            el('button', {
              type: 'button',
              className: 'btn-sm btn-primary',
              text: 'Áp dụng',
              onClick: async () => {
                const okDraft = await this.app.ensureDraftResolved();
                if (!okDraft) return;
                const impact = this.app.store.previewApplyPreset(preset);
                if (impact.needsConfirm) {
                  const details = [];
                  if (impact.removedCells.length > 0) details.push(`Sẽ xóa ${impact.removedCells.length} ô nằm ngoài lưới preset mới.`);
                  if (impact.willReplaceAnimations) details.push(`Sẽ thay thế ${impact.existingAnimationCount} nhóm animation hiện tại bằng cấu trúc của preset.`);
                  const c = await showChoiceDialog({
                    title: `Áp dụng preset "${preset.name}"?`,
                    message: 'Thao tác này là 1 giao dịch Undo và có thể hoàn tác bằng Ctrl+Z.',
                    details,
                    buttons: [
                      { label: 'Hủy', value: 'cancel', autofocus: true },
                      { label: 'Áp dụng preset', value: 'ok', className: 'btn-primary' }
                    ]
                  });
                  if (c !== 'ok') return;
                }
                this.app.store.applyPreset(preset);
                showToast(`Đã áp dụng preset "${preset.name}".`, 'ok');
                dlg.close('ok');
              }
            }),
            el('button', {
              type: 'button',
              className: 'btn-sm',
              text: 'Xuất JSON',
              onClick: () => {
                const clean = deepClone(preset);
                delete clean.builtin;
                const bytes = new TextEncoder().encode(JSON.stringify(clean, null, 2));
                triggerBlobDownload(bytes, `${sanitizeFilename(preset.name, 'preset')}.preset.json`, 'application/json');
                showToast('Đã xuất file JSON preset.', 'ok');
              }
            }),
            !preset.builtin ? el('button', {
              type: 'button',
              className: 'btn-sm btn-danger',
              text: 'Xóa',
              onClick: () => {
                this.app.store.commit(`Xóa preset "${preset.name}"`, (p) => {
                  p.customPresets = p.customPresets.filter((x) => x.id !== preset.id);
                  if (p.presetId === preset.id) p.presetId = null;
                });
                render();
              }
            }) : null
          ])
        ]);
        list.appendChild(row);
      }
      body.appendChild(list);

      // Save current project config as custom preset
      const nameInput = el('input', { type: 'text', placeholder: 'Tên preset tùy chỉnh mới...', style: { flex: '1' } });
      body.appendChild(el('div', { className: 'editor-section' }, [
        el('div', { className: 'editor-section-title', text: 'Lưu cấu hình hiện tại thành Preset tùy chỉnh' }),
        el('div', { className: 'form-row' }, [
          nameInput,
          el('button', {
            type: 'button',
            className: 'btn-sm btn-primary',
            text: 'Lưu preset',
            onClick: () => {
              const nm = nameInput.value.trim();
              if (!nm) { showToast('Nhập tên cho preset tùy chỉnh.', 'warn'); return; }
              const preset = this.app.store.exportCurrentAsPreset(nm);
              const val = validatePresetV1(preset);
              if (!val.ok) { showToast(val.errors[0], 'error'); return; }
              this.app.store.commit(`Lưu preset "${nm}"`, (p) => {
                p.customPresets.push(preset);
              });
              showToast(`Đã lưu preset "${nm}" vào project.`, 'ok');
              render();
            }
          }),
          el('button', {
            type: 'button',
            className: 'btn-sm',
            text: 'Nhập JSON preset...',
            onClick: () => {
              const inp = $('file-import-preset');
              inp.value = '';
              inp.onchange = async () => {
                const f = inp.files?.[0];
                if (!f) return;
                try {
                  const text = await f.text();
                  const raw = JSON.parse(text);
                  const val = validatePresetV1(raw);
                  if (!val.ok) {
                    showToast(`Preset JSON không hợp lệ: ${val.errors[0]}`, 'error');
                    return;
                  }
                  if (this.app.store.project.customPresets.some((x) => x.id === raw.id)) {
                    raw.id = generateId('preset');
                  }
                  this.app.store.commit(`Nhập preset "${raw.name}"`, (p) => {
                    p.customPresets.push(raw);
                  });
                  showToast(`Đã nhập preset "${raw.name}".`, 'ok');
                  render();
                } catch {
                  showToast('Không đọc được file JSON preset.', 'error');
                }
              };
              inp.click();
            }
          })
        ])
      ]));

      footer.appendChild(el('button', { type: 'button', text: 'Đóng', onClick: () => dlg.close('cancel') }));
    };

    render();
    dlg.showModal();
  }

  // =========================================================================
  // 6. PREFLIGHT INSPECTOR MODAL (Spec §11.4)
  // =========================================================================
  async computePreflightReport(exportConfig = { type: 'atlas', format: 'image/png' }) {
    const project = this.app.store.project;
    // Analyze all filled cells on demand (keyed per cell so per-cell masks stay isolated)
    const analysisMap = new Map();
    for (const key of Object.keys(project.cells)) {
      const cell = project.cells[key];
      const asset = this.app.store.getAsset(cell.assetId);
      const source = asset ? this.app.store.getSource(asset.sourceId) : null;
      if (asset && source) {
        const res = await this.app.assetManager.analyzeCellPixels(asset, source, cell.alphaThreshold, cell.mask);
        analysisMap.set(key, res);
      }
    }

    const report = runPreflight({
      project,
      exportConfig,
      inspectAssetPixels: (assetId, threshold, cell, cellKeyStr) => {
        if (cellKeyStr && analysisMap.has(cellKeyStr)) {
          return analysisMap.get(cellKeyStr);
        }
        const asset = this.app.store.getAsset(assetId);
        if (!asset || !this.app.assetManager.hasSourceBinary(asset.sourceId)) {
          return { ok: false, missingSource: true };
        }
        return this.app.assetManager.getCachedCellPixelAnalysis(asset, threshold, cell?.mask) || { ok: true };
      }
    });

    // Update Atlas warning cell highlights & status bar badge
    const warnCells = new Set();
    for (const w of report.warnings) if (w.cellKey) warnCells.add(w.cellKey);
    for (const e of report.errors) if (e.cellKey) warnCells.add(e.cellKey);
    this.app.atlasView.setWarningCells(warnCells);
    const btn = $('status-preflight-btn');
    if (btn) {
      btn.textContent = report.errors.length > 0
        ? `Lỗi: ${report.errors.length} | Cảnh báo: ${report.warnings.length}`
        : `Cảnh báo: ${report.warnings.length}`;
      btn.className = report.errors.length > 0 ? 'btn-xs btn-danger' : (report.warnings.length > 0 ? 'btn-xs btn-warn' : 'btn-xs');
    }
    return report;
  }

  async openPreflightModal(exportConfig = { type: 'atlas', format: 'image/png' }) {
    const dlg = $('dialog-preflight');
    const body = $('preflight-body');
    const footer = $('preflight-footer');

    clearEl(body);
    clearEl(footer);
    body.appendChild(el('div', { className: 'alert-box', text: 'Đang phân tích các ô và kiểm tra preflight...' }));
    dlg.showModal();

    const report = await this.computePreflightReport(exportConfig);
    clearEl(body);

    body.appendChild(el('div', {
      className: report.errors.length > 0 ? 'alert-box is-error' : (report.warnings.length > 0 ? 'alert-box is-warn' : 'alert-box is-ok'),
      text: `Tổng kết: ${report.errors.length} lỗi chặn xuất • ${report.warnings.length} cảnh báo (cho phép xuất sau xác nhận).`
    }));

    const buildList = (title, items, badgeClass) => {
      if (items.length === 0) return null;
      const rows = items.map((it) => {
        const pos = it.cellKey ? parseCellKey(it.cellKey) : null;
        return el('tr', {}, [
          el('td', {}, el('span', { className: `badge ${badgeClass}`, text: it.code })),
          el('td', { text: it.message }),
          el('td', {}, pos ? el('button', {
            type: 'button',
            className: 'btn-xs',
            text: `Đi tới ô (${pos.row + 1},${pos.col + 1})`,
            onClick: () => {
              dlg.close('goto');
              this.app.selectCell(pos.row, pos.col);
              this.app.atlasView.scrollToCell(pos.row, pos.col);
            }
          }) : '—')
        ]);
      });
      return el('div', {}, [
        el('strong', { style: { display: 'block', marginBottom: '4px' }, text: title }),
        el('div', { className: 'table-scroll' }, el('table', { className: 'data-table' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Mã' }), el('th', { text: 'Mô tả' }), el('th', { text: 'Điều hướng' })])),
          el('tbody', {}, rows)
        ]))
      ]);
    };

    const errBlock = buildList('Lỗi chặn xuất (Bắt buộc khắc phục)', report.errors, 'badge-danger');
    const warnBlock = buildList('Cảnh báo (Không tự sửa dữ liệu)', report.warnings, 'badge-warn');
    if (errBlock) body.appendChild(errBlock);
    if (warnBlock) body.appendChild(warnBlock);
    if (!errBlock && !warnBlock) {
      body.appendChild(el('div', { className: 'alert-box is-ok', text: 'Không phát hiện lỗi hay cảnh báo nào!' }));
    }

    footer.appendChild(el('button', { type: 'button', text: 'Kiểm tra lại', onClick: () => this.openPreflightModal(exportConfig) }));
    footer.appendChild(el('button', { type: 'button', className: 'btn-primary', text: 'Đóng', onClick: () => dlg.close('ok') }));
  }

  // =========================================================================
  // 7. EXPORT MODAL (Spec §11)
  // =========================================================================
  async openExportModal() {
    const okDraft = await this.app.ensureDraftResolved();
    if (!okDraft) return;

    const dlg = $('dialog-export');
    const body = $('export-body');
    const footer = $('export-footer');
    const project = this.app.store.project;

    const state = {
      type: 'atlas', // 'atlas' | 'strip' | 'frames' | 'zip' | 'json'
      format: 'image/png',
      webpQuality: project.settings.webpQuality ?? 0.92,
      stripDirection: 'horizontal',
      groupIds: project.animations.map((a) => a.id),
      framesScope: 'all-filled', // 'all-filled' | 'selected-cells' | 'groups'
      includeEmptyGridFrames: false,
      includeAtlas: true,
      includeJson: true,
      includeStrips: false,
      includeFrames: false,
      includeGuidesAndAnchors: true,
      warningsConfirmed: false,
      largeExportConfirmed: false,
      report: null
    };

    const refreshReportAndRender = async () => {
      state.report = await this.computePreflightReport({
        ...state,
        selectedCells: [...this.app.selectedCells]
      });
      render();
    };

    const render = () => {
      clearEl(body);
      clearEl(footer);

      const typeSel = el('select', {
        onChange: (e) => { state.type = e.target.value; state.warningsConfirmed = false; refreshReportAndRender(); }
      }, [
        el('option', { value: 'atlas', text: 'Sprite Atlas (toàn lưới)', selected: state.type === 'atlas' }),
        el('option', { value: 'strip', text: 'Animation Strip (ngang / dọc)', selected: state.type === 'strip' }),
        el('option', { value: 'frames', text: 'Frame riêng lẻ', selected: state.type === 'frames' }),
        el('option', { value: 'zip', text: 'Gói tài nguyên ZIP (Atlas + Metadata + Strip/Frame)', selected: state.type === 'zip' }),
        el('option', { value: 'json', text: 'JSON Metadata độc lập (schema v1)', selected: state.type === 'json' })
      ]);

      const fmtSel = el('select', {
        disabled: state.type === 'json',
        onChange: (e) => { state.format = e.target.value; render(); }
      }, [
        el('option', { value: 'image/png', text: 'PNG (RGBA lossless bitmap, mặc định)', selected: state.format === 'image/png' }),
        el('option', { value: 'image/webp', text: 'WebP (có alpha, lossy theo quality)', selected: state.format === 'image/webp' })
      ]);

      const topRow = el('div', { className: 'form-grid-2' }, [
        el('div', { className: 'form-field' }, [el('label', { text: 'Loại tài nguyên xuất' }), typeSel]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Định dạng ảnh' }), fmtSel])
      ]);
      body.appendChild(topRow);

      if (state.type !== 'json' && state.format === 'image/webp') {
        const qPct = Math.round(state.webpQuality * 100);
        body.appendChild(el('div', { className: 'form-row' }, [
          el('label', { text: `Chất lượng WebP (${qPct}%):` }),
          el('input', {
            type: 'range', min: 1, max: 100, step: 1, value: qPct, style: { flex: '1' },
            onInput: (e) => { state.webpQuality = Number(e.target.value) / 100; render(); }
          })
        ]));
      }

      // ZIP components checkboxes
      if (state.type === 'zip') {
        const mkChk = (lbl, key) => el('label', { className: 'form-row' }, [
          el('input', { type: 'checkbox', checked: state[key], onChange: (e) => { state[key] = e.target.checked; refreshReportAndRender(); } }),
          lbl
        ]);
        body.appendChild(el('div', { className: 'editor-section' }, [
          el('div', { className: 'editor-section-title', text: 'Thành phần trong gói ZIP' }),
          el('div', { className: 'form-grid-2' }, [
            mkChk('Bao gồm Sprite Atlas', 'includeAtlas'),
            mkChk('Bao gồm JSON Metadata', 'includeJson'),
            mkChk('Bao gồm Animation Strip', 'includeStrips'),
            mkChk('Bao gồm Frame riêng', 'includeFrames')
          ])
        ]));
      }

      // Strip options
      if (state.type === 'strip' || (state.type === 'zip' && state.includeStrips)) {
        body.appendChild(el('div', { className: 'form-row' }, [
          el('label', { text: 'Hướng strip:' }),
          el('select', {
            onChange: (e) => { state.stripDirection = e.target.value; refreshReportAndRender(); }
          }, [
            el('option', { value: 'horizontal', text: 'Ngang (horizontal)', selected: state.stripDirection === 'horizontal' }),
            el('option', { value: 'vertical', text: 'Dọc (vertical)', selected: state.stripDirection === 'vertical' })
          ])
        ]));
      }

      // Frames scope options
      if (state.type === 'frames' || (state.type === 'zip' && state.includeFrames)) {
        body.appendChild(el('div', { className: 'form-row' }, [
          el('label', { text: 'Phạm vi frame:' }),
          el('select', {
            onChange: (e) => { state.framesScope = e.target.value; refreshReportAndRender(); }
          }, [
            el('option', { value: 'all-filled', text: 'Theo lưới (r001_c001)', selected: state.framesScope === 'all-filled' }),
            el('option', { value: 'selected-cells', text: `Ô đang chọn (${this.app.selectedCells.size} ô)`, selected: state.framesScope === 'selected-cells' }),
            el('option', { value: 'groups', text: 'Theo nhóm animation (<nhóm>_f001, giữ lặp)', selected: state.framesScope === 'groups' })
          ]),
          state.framesScope !== 'groups' ? el('label', { className: 'form-row' }, [
            el('input', {
              type: 'checkbox',
              checked: state.includeEmptyGridFrames,
              onChange: (e) => { state.includeEmptyGridFrames = e.target.checked; refreshReportAndRender(); }
            }),
            'Gồm cả ô trống'
          ]) : null
        ]));
      }

      // Group picker when needed
      const needGroups =
        state.type === 'strip' ||
        (state.type === 'frames' && state.framesScope === 'groups') ||
        (state.type === 'zip' && (state.includeStrips || (state.includeFrames && state.framesScope === 'groups')));
      if (needGroups) {
        const gBox = el('div', { className: 'editor-section' }, [
          el('div', { className: 'editor-section-title', text: 'Chọn nhóm animation' }),
          project.animations.length === 0
            ? el('div', { style: { color: 'var(--text-muted)', fontSize: '12px' }, text: 'Project chưa có nhóm animation nào.' })
            : el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } }, project.animations.map((a) => el('label', { className: 'form-row' }, [
                el('input', {
                  type: 'checkbox',
                  checked: state.groupIds.includes(a.id),
                  onChange: (e) => {
                    if (e.target.checked) state.groupIds.push(a.id);
                    else state.groupIds = state.groupIds.filter((id) => id !== a.id);
                    refreshReportAndRender();
                  }
                }),
                `${a.name} (${a.frames.length})`
              ])))
        ]);
        body.appendChild(gBox);
      }

      if (state.type === 'json' || (state.type === 'zip' && state.includeJson)) {
        body.appendChild(el('label', { className: 'form-row' }, [
          el('input', {
            type: 'checkbox',
            checked: state.includeGuidesAndAnchors,
            onChange: (e) => { state.includeGuidesAndAnchors = e.target.checked; }
          }),
          'Xuất kèm đường gióng (normalized) và anchor (pixel ô) trong JSON metadata'
        ]));
      }

      // Preflight summary inside Export Dialog
      const rep = state.report;
      if (rep) {
        if (rep.errors.length > 0) {
          body.appendChild(el('div', { className: 'alert-box is-error' }, [
            el('strong', { text: `Bị chặn bởi ${rep.errors.length} lỗi:` }),
            el('ul', { style: { margin: '4px 0 0 18px', padding: 0 } }, rep.errors.slice(0, 6).map((e) => el('li', { text: e.message })))
          ]));
        } else if (rep.warnings.length > 0) {
          body.appendChild(el('div', { className: 'alert-box is-warn' }, [
            el('div', { text: `Preflight phát hiện ${rep.warnings.length} cảnh báo (ví dụ: ${rep.warnings[0].message}).` }),
            el('label', { className: 'form-row', style: { marginTop: '6px' } }, [
              el('input', {
                type: 'checkbox',
                checked: state.warningsConfirmed,
                onChange: (e) => { state.warningsConfirmed = e.target.checked; render(); }
              }),
              'Tôi đã xem cảnh báo và xác nhận xuất nguyên trạng.'
            ])
          ]));
        } else {
          body.appendChild(el('div', { className: 'alert-box is-ok', text: 'Preflight đạt: 0 lỗi, 0 cảnh báo.' }));
        }

        if (rep.needsLargeExportConfirm) {
          body.appendChild(el('div', { className: 'alert-box is-warn' }, el('label', { className: 'form-row' }, [
            el('input', {
              type: 'checkbox',
              checked: state.largeExportConfirmed,
              onChange: (e) => { state.largeExportConfirmed = e.target.checked; render(); }
            }),
            `Kích thước atlas (${project.grid.cols * project.grid.cellWidth}×${project.grid.rows * project.grid.cellHeight} px) vượt ngưỡng an toàn 4096 px / 16 Mi px. Xác nhận bật Chế độ xuất lớn.`
          ])));
        }
      }

      const canExport =
        rep &&
        rep.errors.length === 0 &&
        (rep.warnings.length === 0 || state.warningsConfirmed) &&
        (!rep.needsLargeExportConfirm || state.largeExportConfirmed) &&
        !this.app.isJobRunning;

      footer.appendChild(el('button', { type: 'button', text: 'Xem chi tiết Preflight', onClick: () => { dlg.close('pre'); this.openPreflightModal(state); } }));
      footer.appendChild(el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') }));
      footer.appendChild(el('button', {
        type: 'button',
        className: 'btn-primary',
        disabled: !canExport,
        text: 'Xuất ngay',
        onClick: async () => {
          dlg.close('export');
          await this.app.runExportJob({ ...state, selectedCells: [...this.app.selectedCells] });
        }
      }));
    };

    dlg.showModal();
    await refreshReportAndRender();
  }

  // =========================================================================
  // 8. SETTINGS & CRASH RECOVERY MODAL (Spec §10.3, §12.3)
  // =========================================================================
  openSettingsModal() {
    const dlg = $('dialog-settings');
    const body = $('settings-body');
    const footer = $('settings-footer');
    const p = this.app.store.project;
    const rec = this.app.recovery;

    clearEl(body);
    clearEl(footer);

    const smoothChk = el('input', { type: 'checkbox', checked: p.settings.smoothing });
    const gxInput = el('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round(p.settings.guides.x * 100) });
    const gyInput = el('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round(p.settings.guides.y * 100) });
    const thrInput = el('input', { type: 'number', min: 0, max: 254, step: 1, value: p.settings.defaultAlphaThreshold });
    const qInput = el('input', { type: 'number', min: 1, max: 100, step: 1, value: Math.round(p.settings.webpQuality * 100) });
    const recChk = el('input', { type: 'checkbox', checked: rec.enabled, disabled: rec.status === 'unavailable' });

    body.appendChild(el('div', { className: 'editor-section' }, [
      el('div', { className: 'editor-section-title', text: 'Render & Đường gióng Project' }),
      el('label', { className: 'form-row' }, [smoothChk, 'Bật làm mịn ảnh (Smoothing — tắt khi dùng Pixel Art / Nearest-Neighbor)']),
      el('div', { className: 'form-grid-2' }, [
        el('div', { className: 'form-field' }, [el('label', { text: 'Trục dọc mặc định (%)' }), gxInput]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Baseline ngang mặc định (%)' }), gyInput]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Ngưỡng alpha mặc định (0–254)' }), thrInput]),
        el('div', { className: 'form-field' }, [el('label', { text: 'Chất lượng WebP mặc định (%)' }), qInput])
      ])
    ]));

    const recStatusBox = el('div', { className: rec.status === 'available' ? 'alert-box is-ok' : 'alert-box is-warn', text: `Trạng thái recovery: ${rec.statusMessage}` });
    body.appendChild(el('div', { className: 'editor-section' }, [
      el('div', { className: 'editor-section-title', text: 'Phục hồi sau sự cố (Best-Effort)' }),
      recStatusBox,
      el('label', { className: 'form-row' }, [recChk, 'Bật tự động lưu snapshot recovery khi rảnh (~30 giây)']),
      el('div', { style: { fontSize: '11.5px', color: 'var(--text-muted)' }, text: 'Dữ liệu recovery lưu cục bộ trong IndexedDB của trình duyệt (không gửi ra mạng) và không thay thế file lưu .ssb.' }),
      el('div', { className: 'form-row' }, [
        el('button', {
          type: 'button',
          className: 'btn-sm',
          disabled: rec.status !== 'available' || !rec.enabled,
          text: 'Lưu snapshot recovery ngay',
          onClick: async () => {
            const res = await rec.saveSnapshotNow(this.app.store.project, this.app.store.revision, this.app.assetManager);
            if (res.ok) showToast('Đã lưu snapshot recovery cục bộ.', 'ok');
            else showToast(`Không lưu được recovery: ${res.error || res.reason}`, 'warn');
            recStatusBox.textContent = `Trạng thái recovery: ${rec.statusMessage}`;
          }
        }),
        el('button', {
          type: 'button',
          className: 'btn-sm btn-danger',
          disabled: rec.status === 'unavailable',
          text: 'Xóa dữ liệu recovery',
          onClick: async () => {
            await rec.clearRecovery();
            showToast('Đã xóa toàn bộ dữ liệu recovery trong trình duyệt (file .ssb đã tải không bị ảnh hưởng).', 'ok');
            recStatusBox.textContent = `Trạng thái recovery: ${rec.statusMessage}`;
          }
        })
      ])
    ]));

    const cacheStats = this.app.assetManager.getCacheStats();
    const resUsage = this.app.store.getProjectResourceUsage();
    body.appendChild(el('div', { className: 'alert-box', style: { fontSize: '11.5px' } },
      `Tài nguyên: ${resUsage.sourceCount} nguồn (${formatBytes(resUsage.totalSourceBytes)}, ${(resUsage.totalSourcePixels / 1e6).toFixed(1)}M px) • ` +
      `Cache bitmap LRU: ${(cacheStats.cachedPixels / 1e6).toFixed(1)} / ${(cacheStats.maxCachePixels / 1e6).toFixed(0)}M px (${cacheStats.cacheEntries} mục, đã thu hồi ${cacheStats.evictionCount} lần).`
    ));

    footer.appendChild(el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') }));
    footer.appendChild(el('button', {
      type: 'button',
      className: 'btn-primary',
      text: 'Lưu cài đặt',
      onClick: () => {
        const gx = Math.max(0, Math.min(100, Number(gxInput.value))) / 100;
        const gy = Math.max(0, Math.min(100, Number(gyInput.value))) / 100;
        const thr = Math.max(0, Math.min(254, Math.round(Number(thrInput.value))));
        const q = Math.max(1, Math.min(100, Number(qInput.value))) / 100;
        this.app.store.updateSettings({
          smoothing: smoothChk.checked,
          guides: { x: gx, y: gy },
          defaultAlphaThreshold: thr,
          webpQuality: q
        });
        rec.setEnabled(recChk.checked);
        showToast('Đã cập nhật cài đặt project.', 'ok');
        dlg.close('ok');
      }
    }));

    dlg.showModal();
  }

  // =========================================================================
  // 9. ANIMATION GROUP SETTINGS MODAL (Spec §6.3, §11.4)
  // =========================================================================
  openAnimSettingsModal(anim) {
    const dlg = $('dialog-anim-settings');
    const body = $('anim-settings-body');
    const footer = $('anim-settings-footer');
    clearEl(body);
    clearEl(footer);

    const nameIn = el('input', { type: 'text', value: anim.name, maxlength: 128 });
    const useOverrideChk = el('input', { type: 'checkbox', checked: Boolean(anim.guides) });
    const gxIn = el('input', { type: 'number', min: 0, max: 100, value: Math.round((anim.guides?.x ?? this.app.store.project.settings.guides.x) * 100) });
    const gyIn = el('input', { type: 'number', min: 0, max: 100, value: Math.round((anim.guides?.y ?? this.app.store.project.settings.guides.y) * 100) });
    const varPct = anim.sizeVarianceThreshold === 0 ? 0 : Math.round((anim.sizeVarianceThreshold ?? LIMITS.DEFAULT_SIZE_VARIANCE_THRESHOLD) * 100);
    const varIn = el('input', { type: 'number', min: 0, max: 500, step: 5, value: varPct });

    body.appendChild(el('div', { className: 'form-field' }, [el('label', { text: 'Tên nhóm animation' }), nameIn]));
    body.appendChild(el('label', { className: 'form-row' }, [useOverrideChk, 'Override đường gióng riêng cho nhóm này']));
    body.appendChild(el('div', { className: 'form-grid-2' }, [
      el('div', { className: 'form-field' }, [el('label', { text: 'Trục dọc (%)' }), gxIn]),
      el('div', { className: 'form-field' }, [el('label', { text: 'Baseline ngang (%)' }), gyIn])
    ]));
    body.appendChild(el('div', { className: 'form-field' }, [
      el('label', { text: 'Ngưỡng cảnh báo chênh lệch chiều cao nội dung (%, đặt 0 để tắt)' }),
      varIn
    ]));

    footer.appendChild(el('button', { type: 'button', text: 'Hủy', onClick: () => dlg.close('cancel') }));
    footer.appendChild(el('button', {
      type: 'button',
      className: 'btn-primary',
      text: 'Lưu nhóm',
      onClick: () => {
        const guides = useOverrideChk.checked
          ? { x: Math.max(0, Math.min(100, Number(gxIn.value))) / 100, y: Math.max(0, Math.min(100, Number(gyIn.value))) / 100 }
          : null;
        const vVal = Math.max(0, Math.min(500, Number(varIn.value)));
        this.app.store.updateAnimation(anim.id, {
          name: nameIn.value.trim() || anim.name,
          guides,
          sizeVarianceThreshold: vVal === 0 ? 0 : vVal / 100
        }, 'Cập nhật cài đặt nhóm animation');
        dlg.close('ok');
      }
    }));

    dlg.showModal();
  }
}
