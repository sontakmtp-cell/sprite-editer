/**
 * Sprite Sheet Builder V2.0 — Project Store & Transactional History Manager (Spec §4, §8, §10).
 * Pure logic, zero DOM dependency, testable in Node.js.
 */

import {
  PROJECT_FORMAT,
  PROJECT_SCHEMA_VERSION,
  PRESET_FORMAT,
  PRESET_SCHEMA_VERSION,
  DEFAULT_GRID,
  DEFAULT_SETTINGS,
  DEFAULT_CELL_TRANSFORM,
  BUILTIN_PRESETS,
  LIMITS,
  cellKey,
  parseCellKey,
  isCellInGrid,
  generateId,
  deepClone,
  mimeToExt
} from './constants.js';
import { scaleOffsetsForCellResize } from './geometry.js';
import { normalizeCellMask } from './mask.js';
import { validateGrid } from './validator.js';

export function createDefaultCell(assetId, defaultAlphaThreshold = 8) {
  return {
    assetId,
    fitMode: DEFAULT_CELL_TRANSFORM.fitMode,
    alphaThreshold: defaultAlphaThreshold,
    zoom: DEFAULT_CELL_TRANSFORM.zoom,
    offsetX: DEFAULT_CELL_TRANSFORM.offsetX,
    offsetY: DEFAULT_CELL_TRANSFORM.offsetY,
    anchor: { mode: 'fit-center' }
  };
}

export function createEmptyProject(name = 'Project mới') {
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: generateId('proj'),
    name,
    grid: { ...DEFAULT_GRID },
    presetId: null,
    expectedCells: null,
    sources: [],
    assets: [],
    cells: {},
    animations: [],
    settings: deepClone(DEFAULT_SETTINGS),
    customPresets: []
  };
}

export class ProjectStore {
  constructor(initialProject = null) {
    this.project = initialProject ? deepClone(initialProject) : createEmptyProject();
    this.revision = 1;
    this.lastSavedRevision = 1;
    this.saveState = 'clean'; // 'clean' | 'dirty' | 'download-requested' | 'saved-direct' | 'save-failed'
    this.lastSavedLabel = '';
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.historyPrunedCallback = null;
    this.sourceBytesLookup = null; // optional (sourceId) => byteLength
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event = { type: 'change' }) {
    for (const fn of this.listeners) {
      fn(this.project, event);
    }
  }

  get isDirty() {
    return this.revision !== this.lastSavedRevision || this.saveState === 'save-failed';
  }

  markDownloadRequested(revisionAtSave = this.revision) {
    this.lastSavedRevision = revisionAtSave;
    this.saveState = 'download-requested';
    this.lastSavedLabel = `Đã tạo bản lưu ở rev ${revisionAtSave}`;
    this.emit({ type: 'save-state' });
  }

  markSavedDirect(revisionAtSave = this.revision) {
    this.lastSavedRevision = revisionAtSave;
    this.saveState = 'saved-direct';
    this.lastSavedLabel = `Đã lưu ở rev ${revisionAtSave}`;
    this.emit({ type: 'save-state' });
  }

  markSaveFailed() {
    this.saveState = 'save-failed';
    this.lastSavedLabel = 'Lưu thất bại';
    this.emit({ type: 'save-state' });
  }

  /**
   * Replace entire project (New / Open / Recover). Resets history cleanly.
   */
  loadProject(projectData, { markClean = true } = {}) {
    this.project = deepClone(projectData);
    this.revision += 1;
    this.lastSavedRevision = markClean ? this.revision : this.revision - 1;
    this.saveState = markClean ? 'clean' : 'dirty';
    this.lastSavedLabel = '';
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ type: 'project-loaded' });
  }

  /**
   * Execute a state mutation as a single committed Undo transaction.
   * Mutator receives a cloned draft project; if it returns false, transaction aborts.
   */
  commit(label, mutator) {
    const before = deepClone(this.project);
    const next = deepClone(this.project);
    const result = mutator(next);
    if (result === false) return { committed: false };

    this.undoStack.push({
      label,
      before,
      after: deepClone(next),
      revisionBefore: this.revision
    });
    this.redoStack = [];

    this.project = next;
    this.revision += 1;
    this.saveState = 'dirty';

    this._enforceHistoryLimits();
    this.emit({ type: 'commit', label, revision: this.revision });
    return { committed: true, result };
  }

  _enforceHistoryLimits() {
    let prunedCount = 0;
    while (this.undoStack.length > LIMITS.MAX_HISTORY_ENTRIES) {
      this.undoStack.shift();
      prunedCount++;
    }

    // Check extra memory budget for orphaned history-only sources (never prune below MIN_HISTORY_ENTRIES unless exceeding budget)
    if (this.sourceBytesLookup) {
      const currentIds = new Set(this.project.sources.map((s) => s.id));
      const calcOrphanBytes = () => {
        const orphanIds = new Set();
        for (const entry of this.undoStack) {
          for (const s of entry.before.sources) {
            if (!currentIds.has(s.id)) orphanIds.add(s.id);
          }
        }
        let total = 0;
        for (const id of orphanIds) {
          total += this.sourceBytesLookup(id) || 0;
        }
        return total;
      };
      while (this.undoStack.length > 1 && calcOrphanBytes() > LIMITS.MAX_HISTORY_EXTRA_BYTES) {
        this.undoStack.shift();
        prunedCount++;
      }
    }

    if (prunedCount > 0 && this.historyPrunedCallback) {
      this.historyPrunedCallback(prunedCount);
    }
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.undoStack.length === 0) return null;
    const entry = this.undoStack.pop();
    this.redoStack.push(entry);
    this.project = deepClone(entry.before);
    this.revision += 1;
    this.saveState = this.revision === this.lastSavedRevision ? 'clean' : 'dirty';
    this.emit({ type: 'undo', label: entry.label, revision: this.revision });
    return entry;
  }

  redo() {
    if (this.redoStack.length === 0) return null;
    const entry = this.redoStack.pop();
    this.undoStack.push(entry);
    this.project = deepClone(entry.after);
    this.revision += 1;
    this.saveState = this.revision === this.lastSavedRevision ? 'clean' : 'dirty';
    this.emit({ type: 'redo', label: entry.label, revision: this.revision });
    return entry;
  }

  /**
   * Collect all source IDs still referenced by current project or Undo/Redo stacks.
   */
  getAllReferencedSourceIds() {
    const ids = new Set();
    for (const s of this.project.sources) ids.add(s.id);
    for (const e of this.undoStack) {
      for (const s of e.before.sources) ids.add(s.id);
      for (const s of e.after.sources) ids.add(s.id);
    }
    for (const e of this.redoStack) {
      for (const s of e.before.sources) ids.add(s.id);
      for (const s of e.after.sources) ids.add(s.id);
    }
    return ids;
  }

  // --- Queries & Helpers ---

  getSource(sourceId) {
    return this.project.sources.find((s) => s.id === sourceId) || null;
  }

  getAsset(assetId) {
    return this.project.assets.find((a) => a.id === assetId) || null;
  }

  getCell(row, col) {
    return this.project.cells[cellKey(row, col)] || null;
  }

  getAllPresets() {
    return [...BUILTIN_PRESETS, ...this.project.customPresets];
  }

  getPresetById(id) {
    if (!id) return null;
    return this.getAllPresets().find((p) => p.id === id) || null;
  }

  getExpectedCellSet() {
    if (!this.project.expectedCells) return null;
    return new Set(this.project.expectedCells);
  }

  isPresetUnusedCell(row, col) {
    if (!this.project.expectedCells) return false;
    return !this.project.expectedCells.includes(cellKey(row, col));
  }

  getAssetUsageMap() {
    const counts = new Map();
    for (const key of Object.keys(this.project.cells)) {
      const aid = this.project.cells[key].assetId;
      counts.set(aid, (counts.get(aid) || 0) + 1);
    }
    return counts;
  }

  getSourceUsageStats(sourceId) {
    const assetIds = new Set(
      this.project.assets.filter((a) => a.sourceId === sourceId).map((a) => a.id)
    );
    const affectedCells = [];
    for (const key of Object.keys(this.project.cells)) {
      if (assetIds.has(this.project.cells[key].assetId)) {
        affectedCells.push(key);
      }
    }
    return {
      assetCount: assetIds.size,
      affectedCells
    };
  }

  getProjectResourceUsage() {
    let totalSourcePixels = 0;
    let totalSourceBytes = 0;
    for (const s of this.project.sources) {
      totalSourcePixels += s.width * s.height;
      totalSourceBytes += s.byteLength;
    }
    let totalAnimationSlots = 0;
    for (const a of this.project.animations) {
      totalAnimationSlots += a.frames.length;
    }
    return {
      sourceCount: this.project.sources.length,
      assetCount: this.project.assets.length,
      animationCount: this.project.animations.length,
      totalAnimationSlots,
      totalSourcePixels,
      totalSourceBytes,
      filledCellCount: Object.keys(this.project.cells).length,
      totalCellCount: this.project.grid.cols * this.project.grid.rows
    };
  }

  /**
   * Preview impact of changing grid dimensions (Spec §4.1).
   */
  previewGridChange(newGrid) {
    const validation = validateGrid(newGrid);
    const oldGrid = this.project.grid;
    const removedCells = [];
    let removedAnimationSlots = 0;
    const affectedAnimations = new Set();

    for (const key of Object.keys(this.project.cells)) {
      const parsed = parseCellKey(key);
      if (parsed && (parsed.row >= newGrid.rows || parsed.col >= newGrid.cols)) {
        removedCells.push(key);
      }
    }

    for (const anim of this.project.animations) {
      for (const f of anim.frames) {
        if (f.row >= newGrid.rows || f.col >= newGrid.cols) {
          removedAnimationSlots++;
          affectedAnimations.add(anim.name);
        }
      }
    }

    const cellSizeChanged =
      newGrid.cellWidth !== oldGrid.cellWidth ||
      newGrid.cellHeight !== oldGrid.cellHeight;
    const gridDimsChanged =
      newGrid.cols !== oldGrid.cols || newGrid.rows !== oldGrid.rows;

    return {
      validation,
      removedCells,
      removedAnimationSlots,
      affectedAnimations: [...affectedAnimations],
      cellSizeChanged,
      gridDimsChanged,
      needsConfirm: removedCells.length > 0 || removedAnimationSlots > 0
    };
  }

  /**
   * Apply grid change (Spec §4.1):
   * - Keep exact coordinates, never compact frames
   * - Remove out-of-bounds cells & animation slots, keeping remaining order & empty groups
   * - Scale offsetX/offsetY proportionally when cellWidth/cellHeight change
   * - Transition away from preset to custom mode if deviating from active preset
   */
  applyGridChange(newGrid) {
    const validation = validateGrid(newGrid);
    if (!validation.ok) {
      return { committed: false, errors: validation.errors };
    }
    return this.commit('Đổi kích thước lưới', (p) => {
      const oldW = p.grid.cellWidth;
      const oldH = p.grid.cellHeight;
      const newW = newGrid.cellWidth;
      const newH = newGrid.cellHeight;
      const sizeChanged = oldW !== newW || oldH !== newH;

      p.grid = {
        cols: newGrid.cols,
        rows: newGrid.rows,
        cellWidth: newW,
        cellHeight: newH
      };

      const nextCells = {};
      for (const key of Object.keys(p.cells)) {
        const pos = parseCellKey(key);
        if (!pos || !isCellInGrid(pos.row, pos.col, p.grid)) continue;
        const cell = p.cells[key];
        if (sizeChanged) {
          const scaled = scaleOffsetsForCellResize(cell.offsetX, cell.offsetY, oldW, oldH, newW, newH);
          cell.offsetX = scaled.offsetX;
          cell.offsetY = scaled.offsetY;
        }
        nextCells[key] = cell;
      }
      p.cells = nextCells;

      for (const anim of p.animations) {
        anim.frames = anim.frames.filter((f) => isCellInGrid(f.row, f.col, p.grid));
      }

      if (p.expectedCells) {
        p.expectedCells = p.expectedCells.filter((k) => {
          const pos = parseCellKey(k);
          return pos && isCellInGrid(pos.row, pos.col, p.grid);
        });
      }

      // Check preset divergence -> custom mode without losing data (Spec §4.2)
      if (p.presetId) {
        const preset = this.getPresetById(p.presetId);
        if (
          !preset ||
          preset.grid.cols !== p.grid.cols ||
          preset.grid.rows !== p.grid.rows ||
          preset.grid.cellWidth !== p.grid.cellWidth ||
          preset.grid.cellHeight !== p.grid.cellHeight
        ) {
          p.presetId = null;
          p.expectedCells = null;
        }
      }
    });
  }

  /**
   * Preview impact of applying a preset (Spec §4.2).
   */
  previewApplyPreset(preset) {
    const gridImpact = this.previewGridChange(preset.grid);
    const willReplaceAnimations = this.project.animations.length > 0;
    return {
      ...gridImpact,
      willReplaceAnimations,
      existingAnimationCount: this.project.animations.length,
      needsConfirm:
        gridImpact.removedCells.length > 0 ||
        willReplaceAnimations ||
        Object.keys(this.project.cells).length > 0
    };
  }

  /**
   * Apply a preset as a single Undo transaction (Spec §4.2, §4.3).
   */
  applyPreset(preset) {
    const validation = validateGrid(preset.grid);
    if (!validation.ok) return { committed: false, errors: validation.errors };

    return this.commit(`Áp dụng preset "${preset.name}"`, (p) => {
      const oldW = p.grid.cellWidth;
      const oldH = p.grid.cellHeight;
      const newW = preset.grid.cellWidth;
      const newH = preset.grid.cellHeight;
      const sizeChanged = oldW !== newW || oldH !== newH;

      p.grid = { ...preset.grid };
      p.presetId = preset.id;
      p.expectedCells = Array.isArray(preset.expectedCells) ? [...preset.expectedCells] : null;
      if (preset.guides) {
        p.settings.guides = { x: preset.guides.x, y: preset.guides.y };
      }

      const nextCells = {};
      for (const key of Object.keys(p.cells)) {
        const pos = parseCellKey(key);
        if (!pos || !isCellInGrid(pos.row, pos.col, p.grid)) continue;
        const cell = p.cells[key];
        if (sizeChanged) {
          const scaled = scaleOffsetsForCellResize(cell.offsetX, cell.offsetY, oldW, oldH, newW, newH);
          cell.offsetX = scaled.offsetX;
          cell.offsetY = scaled.offsetY;
        }
        nextCells[key] = cell;
      }
      p.cells = nextCells;

      p.animations = preset.animations.map((a) => ({
        id: generateId('anim'),
        name: a.name,
        fps: a.fps,
        loopMode: a.loopMode,
        guides: a.guides ? { x: a.guides.x, y: a.guides.y } : null,
        sizeVarianceThreshold: null,
        frames: a.frames.map((f) => ({
          row: f.row,
          col: f.col,
          durationMs: f.durationMs ?? null
        }))
      }));
    });
  }

  /**
   * Create a Preset V1 object from current project configuration (Spec §4.3).
   */
  exportCurrentAsPreset(name, description = '') {
    const p = this.project;
    const expectedSet = new Set();
    if (p.expectedCells && p.expectedCells.length > 0) {
      for (const k of p.expectedCells) expectedSet.add(k);
    } else if (p.animations.length > 0) {
      for (const anim of p.animations) {
        for (const f of anim.frames) expectedSet.add(cellKey(f.row, f.col));
      }
    } else {
      for (let r = 0; r < p.grid.rows; r++) {
        for (let c = 0; c < p.grid.cols; c++) {
          expectedSet.add(cellKey(r, c));
        }
      }
    }

    return {
      format: PRESET_FORMAT,
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: generateId('preset'),
      name: name.trim(),
      description: description.trim(),
      grid: { ...p.grid },
      expectedCells: [...expectedSet],
      defaultFps: p.animations[0]?.fps ?? 8,
      guides: { ...p.settings.guides },
      animations: p.animations.map((a) => ({
        name: a.name,
        fps: a.fps,
        loopMode: a.loopMode,
        guides: a.guides ? { x: a.guides.x, y: a.guides.y } : null,
        frames: a.frames.map((f) => ({
          row: f.row,
          col: f.col,
          durationMs: f.durationMs ?? null
        }))
      }))
    };
  }

  /**
   * Mark project as custom when animation structure deviates from active preset.
   */
  _markCustomIfPresetDeviated(p) {
    if (!p.presetId) return;
    p.presetId = null;
    p.expectedCells = null;
  }

  // --- Source & Asset Operations ---

  addSourcesAndAssets(label, newSources, newAssets, cellAssignments = []) {
    return this.commit(label, (p) => {
      for (const src of newSources) {
        if (!p.sources.some((s) => s.id === src.id)) {
          p.sources.push({
            id: src.id,
            name: src.name,
            path: src.path || `sources/${src.id}.${mimeToExt(src.mime)}`,
            mime: src.mime,
            width: src.width,
            height: src.height,
            byteLength: src.byteLength,
            importedAt: src.importedAt ?? Date.now(),
            exifOrientation: src.exifOrientation ?? 1
          });
        }
      }
      for (const asset of newAssets) {
        p.assets.push({
          id: asset.id,
          sourceId: asset.sourceId,
          name: asset.name,
          isRegion: Boolean(asset.isRegion),
          region: { ...asset.region }
        });
      }
      for (const assign of cellAssignments) {
        const key = cellKey(assign.row, assign.col);
        p.cells[key] = createDefaultCell(assign.assetId, p.settings.defaultAlphaThreshold);
      }
    });
  }

  deleteSource(sourceId) {
    return this.commit('Xóa nguồn ảnh', (p) => {
      const removedAssetIds = new Set(
        p.assets.filter((a) => a.sourceId === sourceId).map((a) => a.id)
      );
      p.sources = p.sources.filter((s) => s.id !== sourceId);
      p.assets = p.assets.filter((a) => a.sourceId !== sourceId);
      for (const key of Object.keys(p.cells)) {
        if (removedAssetIds.has(p.cells[key].assetId)) {
          delete p.cells[key];
        }
      }
    });
  }

  deleteAsset(assetId) {
    return this.commit('Xóa asset', (p) => {
      const asset = p.assets.find((a) => a.id === assetId);
      if (!asset) return false;
      p.assets = p.assets.filter((a) => a.id !== assetId);
      for (const key of Object.keys(p.cells)) {
        if (p.cells[key].assetId === assetId) {
          delete p.cells[key];
        }
      }
      // If no other asset uses this source, also remove source from project
      const stillUsed = p.assets.some((a) => a.sourceId === asset.sourceId);
      if (!stillUsed) {
        p.sources = p.sources.filter((s) => s.id !== asset.sourceId);
      }
    });
  }

  updateAssetRegion(assetId, newRegion, { createNew = false, newName = null } = {}) {
    return this.commit(createNew ? 'Tạo vùng cắt mới' : 'Cập nhật vùng cắt', (p) => {
      const asset = p.assets.find((a) => a.id === assetId);
      if (!asset) return false;
      const src = p.sources.find((s) => s.id === asset.sourceId);
      if (!src) return false;
      if (
        !Number.isInteger(newRegion.x) || !Number.isInteger(newRegion.y) ||
        !Number.isInteger(newRegion.w) || !Number.isInteger(newRegion.h) ||
        newRegion.x < 0 || newRegion.y < 0 || newRegion.w < 1 || newRegion.h < 1 ||
        newRegion.x + newRegion.w > src.width || newRegion.y + newRegion.h > src.height
      ) {
        return false;
      }

      const isSub =
        newRegion.x !== 0 || newRegion.y !== 0 ||
        newRegion.w !== src.width || newRegion.h !== src.height;

      if (createNew) {
        const created = {
          id: generateId('asset'),
          sourceId: asset.sourceId,
          name: newName || `${asset.name}_region`,
          isRegion: isSub,
          region: { ...newRegion }
        };
        p.assets.push(created);
        return created.id;
      }

      asset.region = { ...newRegion };
      asset.isRegion = isSub;
      // Clamp custom anchors in cells referencing this asset if out of new region
      for (const key of Object.keys(p.cells)) {
        const c = p.cells[key];
        if (c.assetId === assetId && c.anchor?.mode === 'custom') {
          if (c.anchor.x > newRegion.w || c.anchor.y > newRegion.h) {
            c.anchor = { mode: 'fit-center' };
          }
        }
      }
      return assetId;
    });
  }

  // --- Cell Operations (Spec §8) ---

  setCellTransform(row, col, cellData, label = 'Chỉnh sửa frame') {
    const key = cellKey(row, col);
    return this.commit(label, (p) => {
      if (!isCellInGrid(row, col, p.grid)) return false;
      const asset = p.assets.find((a) => a.id === cellData?.assetId);
      if (!asset || !p.sources.some((s) => s.id === asset.sourceId)) return false;
      const clean = deepClone(cellData);
      const normMask = normalizeCellMask(clean.mask);
      if (normMask) clean.mask = normMask;
      else delete clean.mask;
      p.cells[key] = clean;
    });
  }

  applyMultipleCellTransforms(updatesMap, label = 'Đồng bộ căn chỉnh') {
    return this.commit(label, (p) => {
      let count = 0;
      for (const [key, cellData] of Object.entries(updatesMap)) {
        const pos = parseCellKey(key);
        if (!pos || !isCellInGrid(pos.row, pos.col, p.grid)) continue;
        const clean = deepClone(cellData);
        const normMask = normalizeCellMask(clean.mask);
        if (normMask) clean.mask = normMask;
        else delete clean.mask;
        p.cells[key] = clean;
        count++;
      }
      if (count === 0) return false;
    });
  }

  clearCells(keys) {
    return this.commit(`Xóa ${keys.length} ô`, (p) => {
      let changed = false;
      for (const key of keys) {
        if (p.cells[key]) {
          delete p.cells[key];
          changed = true;
        }
      }
      if (!changed) return false;
    });
  }

  moveOrSwapCell(fromKey, toKey, { copy = false } = {}) {
    if (fromKey === toKey) return { committed: false };
    return this.commit(copy ? 'Sao chép ô' : 'Di chuyển/Hoán đổi ô', (p) => {
      const fromPos = parseCellKey(fromKey);
      const toPos = parseCellKey(toKey);
      if (!fromPos || !toPos || !isCellInGrid(fromPos.row, fromPos.col, p.grid) || !isCellInGrid(toPos.row, toPos.col, p.grid)) {
        return false;
      }
      const srcCell = p.cells[fromKey];
      if (!srcCell) return false;

      if (copy) {
        p.cells[toKey] = deepClone(srcCell);
      } else {
        const dstCell = p.cells[toKey];
        p.cells[toKey] = deepClone(srcCell);
        if (dstCell) {
          p.cells[fromKey] = deepClone(dstCell);
        } else {
          delete p.cells[fromKey];
        }
      }
    });
  }

  pasteCells(pastePlan, label = 'Dán nội dung ô') {
    if (!Array.isArray(pastePlan) || pastePlan.length === 0) {
      return { committed: false, missingAssetIds: [] };
    }
    const validAssetMap = new Map(this.project.assets.map((a) => [a.id, a]));
    const validSourceIds = new Set(this.project.sources.map((s) => s.id));
    const missingAssetIds = [];
    for (const item of pastePlan) {
      if (!isCellInGrid(item.row, item.col, this.project.grid)) continue;
      const aid = item.cell?.assetId;
      const asset = aid ? validAssetMap.get(aid) : null;
      if (!asset || !validSourceIds.has(asset.sourceId)) {
        if (aid && !missingAssetIds.includes(aid)) missingAssetIds.push(aid);
        else if (!aid && !missingAssetIds.includes('(trống)')) missingAssetIds.push('(trống)');
      }
    }
    if (missingAssetIds.length > 0) {
      return { committed: false, missingAssetIds };
    }

    return this.commit(label, (p) => {
      const assetSet = new Set(p.assets.map((a) => a.id));
      const sourceSet = new Set(p.sources.map((s) => s.id));
      let count = 0;
      for (const item of pastePlan) {
        if (!isCellInGrid(item.row, item.col, p.grid)) continue;
        const asset = p.assets.find((a) => a.id === item.cell?.assetId);
        if (!asset || !assetSet.has(asset.id) || !sourceSet.has(asset.sourceId)) {
          return false;
        }
        const clean = deepClone(item.cell);
        const normMask = normalizeCellMask(clean.mask);
        if (normMask) clean.mask = normMask;
        else delete clean.mask;
        p.cells[cellKey(item.row, item.col)] = clean;
        count++;
      }
      if (count === 0) return false;
    });
  }

  // --- Animation Group CRUD (Spec §9) ---

  addAnimation({ name, fps = 8, loopMode = 'loop', frames = [], guides = null }) {
    return this.commit(`Tạo nhóm animation "${name}"`, (p) => {
      if (p.animations.length >= LIMITS.MAX_ANIMATIONS) return false;
      const anim = {
        id: generateId('anim'),
        name: name.trim() || 'Animation mới',
        fps,
        loopMode,
        guides: guides ? { x: guides.x, y: guides.y } : null,
        sizeVarianceThreshold: null,
        frames: frames
          .filter((f) => isCellInGrid(f.row, f.col, p.grid))
          .map((f) => ({ row: f.row, col: f.col, durationMs: f.durationMs ?? null }))
      };
      p.animations.push(anim);
      this._markCustomIfPresetDeviated(p);
      return anim.id;
    });
  }

  updateAnimation(animId, patch, label = 'Cập nhật nhóm animation') {
    return this.commit(label, (p) => {
      const anim = p.animations.find((a) => a.id === animId);
      if (!anim) return false;
      if (patch.name !== undefined) anim.name = patch.name.trim() || anim.name;
      if (patch.fps !== undefined) anim.fps = patch.fps;
      if (patch.loopMode !== undefined) anim.loopMode = patch.loopMode;
      if (patch.guides !== undefined) anim.guides = patch.guides ? { ...patch.guides } : null;
      if (patch.sizeVarianceThreshold !== undefined) anim.sizeVarianceThreshold = patch.sizeVarianceThreshold;
      if (patch.frames !== undefined) {
        anim.frames = patch.frames.map((f) => ({
          row: f.row,
          col: f.col,
          durationMs: f.durationMs ?? null
        }));
        this._markCustomIfPresetDeviated(p);
      }
    });
  }

  duplicateAnimation(animId) {
    return this.commit('Nhân bản nhóm animation', (p) => {
      const src = p.animations.find((a) => a.id === animId);
      if (!src || p.animations.length >= LIMITS.MAX_ANIMATIONS) return false;
      const copy = deepClone(src);
      copy.id = generateId('anim');
      copy.name = `${src.name} (bản sao)`;
      p.animations.push(copy);
      this._markCustomIfPresetDeviated(p);
      return copy.id;
    });
  }

  deleteAnimation(animId) {
    return this.commit('Xóa nhóm animation', (p) => {
      const before = p.animations.length;
      p.animations = p.animations.filter((a) => a.id !== animId);
      if (p.animations.length === before) return false;
      this._markCustomIfPresetDeviated(p);
    });
  }

  updateSettings(patch, label = 'Cập nhật thiết lập') {
    return this.commit(label, (p) => {
      if (patch.smoothing !== undefined) p.settings.smoothing = Boolean(patch.smoothing);
      if (patch.guides !== undefined) p.settings.guides = { x: patch.guides.x, y: patch.guides.y };
      if (patch.defaultAlphaThreshold !== undefined) p.settings.defaultAlphaThreshold = patch.defaultAlphaThreshold;
      if (patch.webpQuality !== undefined) p.settings.webpQuality = patch.webpQuality;
    });
  }
}
