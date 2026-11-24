/**
 * Sprite Sheet Builder V2.0 — Best-Effort Crash Recovery (IndexedDB) with Multi-Tab Conflict Guard (Spec §10.3).
 * Stores source blobs by ID + atomic committed snapshot marker so failed writes never corrupt
 * the last valid snapshot. Gracefully reports unavailability on restricted file:// or full quota.
 */

import {
  PROJECT_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION_V3,
  generateId,
  deepClone
} from '../core/constants.js';
import { normalizeCellMask, projectHasMasks } from '../core/mask.js';
import { validateProjectManifest } from '../core/validator.js';

const DB_NAME = 'sprite-sheet-builder-recovery-v2';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_SOURCES = 'sources';
const SNAPSHOT_KEY = 'latest_committed_snapshot';
const LOCK_LS_KEY = 'ssb_v2_active_tab_lock';
const LOCK_TTL_MS = 12000;

export class RecoveryManager {
  constructor() {
    this.tabId = generateId('tab');
    this.status = 'probing'; // 'probing' | 'available' | 'unavailable' | 'quota-exceeded' | 'disabled'
    this.statusMessage = 'Đang kiểm tra bộ nhớ phục hồi...';
    this.enabled = true;
    this.db = null;
    this.debounceTimer = null;
    this.debounceMs = 30000; // ~30s idle debounce (Spec §10.3)
    this.scheduledProjectId = null;
    this.scheduledToken = 0;
    this._opQueue = Promise.resolve();
    this.lastSavedSnapshotRev = null;
    this.multiTabConflict = false;
    this.channel = null;
    this.heartbeatTimer = null;
    this.onStatusChange = null;
  }

  _notify() {
    if (this.onStatusChange) {
      this.onStatusChange({
        status: this.status,
        enabled: this.enabled,
        message: this.statusMessage,
        multiTabConflict: this.multiTabConflict
      });
    }
  }

  _openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB không khả dụng trong trình duyệt này.'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_SOURCES)) {
          db.createObjectStore(STORE_SOURCES, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Không mở được IndexedDB.'));
      req.onblocked = () => reject(new Error('IndexedDB bị chặn bởi tab khác.'));
    });
  }

  _txPut(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Lỗi ghi IndexedDB.'));
      tx.onabort = () => reject(tx.error || new Error('Giao dịch IndexedDB bị hủy.'));
    });
  }

  _txGet(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Lỗi đọc IndexedDB.'));
    });
  }

  _txDelete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _txGetAllKeys(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Probe IndexedDB capability immediately on startup (Spec §10.3).
   */
  async init() {
    this._setupMultiTabGuard();
    try {
      this.db = await this._openDb();
      // Actual read/write/delete probe to verify file:// persistence works
      const probeKey = `__probe_${this.tabId}`;
      await this._txPut(STORE_META, { key: probeKey, ts: Date.now() });
      const readBack = await this._txGet(STORE_META, probeKey);
      await this._txDelete(STORE_META, probeKey);
      if (!readBack) throw new Error('Không đọc lại được dữ liệu kiểm tra IndexedDB.');

      this.status = 'available';
      this.statusMessage = 'Phục hồi tự động sẵn sàng (IndexedDB cục bộ)';
      this._notify();
      return true;
    } catch (err) {
      this.db = null;
      this.status = 'unavailable';
      this.statusMessage = 'Phục hồi tự động không khả dụng — hãy lưu project';
      this._notify();
      return false;
    }
  }

  _setupMultiTabGuard() {
    const checkConflict = () => {
      try {
        const raw = localStorage.getItem(LOCK_LS_KEY);
        if (raw) {
          const lock = JSON.parse(raw);
          if (lock && lock.tabId !== this.tabId && Date.now() - lock.ts < LOCK_TTL_MS) {
            this.multiTabConflict = true;
            this.statusMessage = 'Phát hiện tab khác đang mở — tạm dừng ghi đè recovery để tránh xung đột';
            this._notify();
            return true;
          }
        }
        localStorage.setItem(LOCK_LS_KEY, JSON.stringify({ tabId: this.tabId, ts: Date.now() }));
        if (this.multiTabConflict) {
          this.multiTabConflict = false;
          if (this.status === 'available') {
            this.statusMessage = 'Phục hồi tự động sẵn sàng (IndexedDB cục bộ)';
          }
          this._notify();
        }
      } catch {
        // localStorage may be blocked on file://; fallback to BroadcastChannel only
      }
      return false;
    };

    checkConflict();

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('ssb_v2_recovery_channel');
        this.channel.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg || msg.tabId === this.tabId) return;
          if (msg.type === 'ping') {
            this.channel.postMessage({ type: 'pong', tabId: this.tabId });
            this.multiTabConflict = true;
            this.statusMessage = 'Phát hiện tab khác đang mở — tạm dừng ghi đè recovery để tránh xung đột';
            this._notify();
          } else if (msg.type === 'pong') {
            this.multiTabConflict = true;
            this.statusMessage = 'Phát hiện tab khác đang mở — tạm dừng ghi đè recovery để tránh xung đột';
            this._notify();
          }
        };
        this.channel.postMessage({ type: 'ping', tabId: this.tabId });
      } catch {}
    }

    this.heartbeatTimer = setInterval(() => {
      checkConflict();
    }, 4000);

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.releaseLock());
    }
  }

  releaseLock() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      const raw = localStorage.getItem(LOCK_LS_KEY);
      if (raw) {
        const lock = JSON.parse(raw);
        if (lock && lock.tabId === this.tabId) {
          localStorage.removeItem(LOCK_LS_KEY);
        }
      }
    } catch {}
    if (this.channel) {
      try { this.channel.close(); } catch {}
      this.channel = null;
    }
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
    if (!this.enabled) {
      this.cancelPendingSave();
      this.statusMessage = 'Phục hồi tự động đang tắt';
    } else if (this.db) {
      this.status = 'available';
      this.statusMessage = 'Phục hồi tự động sẵn sàng (IndexedDB cục bộ)';
    } else {
      this.status = 'unavailable';
      this.statusMessage = 'Phục hồi tự động không khả dụng — hãy lưu project';
    }
    this._notify();
  }

  cancelPendingSave() {
    this.scheduledToken += 1;
    this.scheduledProjectId = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  _enqueueOp(fn) {
    const run = this._opQueue.then(fn, fn);
    this._opQueue = run.catch(() => {});
    return run;
  }

  /**
   * Schedule debounced idle snapshot save (30s default), pinned to the current projectId.
   * Cancelled automatically on New/Open/Restore so an old project timer can never overwrite
   * recovery with a newly opened/empty project (R4).
   */
  scheduleSave(getProjectAndAssetMgr, expectedProjectId = null) {
    this.cancelPendingSave();
    if (!this.enabled || !this.db || this.status !== 'available' || this.multiTabConflict) return;
    const token = this.scheduledToken;
    this.scheduledProjectId = expectedProjectId;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (token !== this.scheduledToken) return;
      const ctx = getProjectAndAssetMgr();
      if (!ctx || !ctx.project) return;
      if (expectedProjectId && ctx.project.projectId !== expectedProjectId) return;
      this.saveSnapshotNow(ctx.project, ctx.revision, ctx.assetManager, { expectedProjectId });
    }, this.debounceMs);
  }

  /**
   * Atomically save committed snapshot + missing source blobs + orphan cleanup in ONE
   * consistent IndexedDB readwrite transaction (serialized via _opQueue).
   * Aborts BEFORE touching IndexedDB if ANY referenced source binary is missing or invalid (R4).
   */
  saveSnapshotNow(project, revision, assetManager, { expectedProjectId = null } = {}) {
    if (!this.enabled || !this.db || this.multiTabConflict) {
      return Promise.resolve({ ok: false, reason: 'disabled-or-conflict' });
    }
    if (!project || (expectedProjectId && project.projectId !== expectedProjectId)) {
      return Promise.resolve({ ok: false, reason: 'project-mismatch' });
    }

    // Eagerly capture immutable snapshot metadata & all source bytes synchronously BEFORE awaiting IDB
    const projectCopy = deepClone(project);
    if (projectCopy.cells && typeof projectCopy.cells === 'object') {
      for (const key of Object.keys(projectCopy.cells)) {
        const cell = projectCopy.cells[key];
        const norm = normalizeCellMask(cell?.mask);
        if (norm) cell.mask = norm;
        else if (cell) delete cell.mask;
      }
    }
    projectCopy.schemaVersion = projectHasMasks(projectCopy)
      ? PROJECT_SCHEMA_VERSION_V3
      : PROJECT_SCHEMA_VERSION;
    const val = validateProjectManifest(projectCopy);
    if (!val.ok) {
      return Promise.resolve({ ok: false, reason: 'invalid-manifest', error: val.errors[0] });
    }

    const capturedSources = new Map();
    for (const src of projectCopy.sources) {
      const bytes = assetManager?.getSourceBytes ? assetManager.getSourceBytes(src.id) : null;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength !== src.byteLength) {
        // NEVER overwrite a valid recovery snapshot with a snapshot missing source binaries!
        return Promise.resolve({
          ok: false,
          reason: 'missing-source',
          error: `Thiếu dữ liệu nhị phân nguồn "${src.name}" (${src.id}) — giữ nguyên bản recovery trước đó.`
        });
      }
      capturedSources.set(src.id, {
        id: src.id,
        mime: src.mime,
        byteLength: bytes.byteLength,
        blob: new Blob([bytes], { type: src.mime })
      });
    }

    return this._enqueueOp(async () => {
      if (!this.enabled || !this.db || this.multiTabConflict) {
        return { ok: false, reason: 'disabled-or-conflict' };
      }
      try {
        const existingIds = new Set(await this._txGetAllKeys(STORE_SOURCES));
        const neededIds = new Set(projectCopy.sources.map((s) => s.id));

        const snapshot = {
          key: SNAPSHOT_KEY,
          status: 'committed',
          savedAt: Date.now(),
          tabId: this.tabId,
          revision,
          project: projectCopy
        };

        // Single atomic transaction across both stores: either all new sources + marker + GC commit together,
        // or the entire transaction rolls back leaving the previous valid snapshot untouched!
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction([STORE_SOURCES, STORE_META], 'readwrite');
          const srcStore = tx.objectStore(STORE_SOURCES);
          const metaStore = tx.objectStore(STORE_META);

          for (const src of projectCopy.sources) {
            if (!existingIds.has(src.id)) {
              srcStore.put(capturedSources.get(src.id));
            }
          }
          metaStore.put(snapshot);
          for (const oldId of existingIds) {
            if (!neededIds.has(oldId)) {
              srcStore.delete(oldId);
            }
          }

          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('Lỗi ghi giao dịch recovery.'));
          tx.onabort = () => reject(tx.error || new Error('Giao dịch recovery bị hủy.'));
        });

        this.lastSavedSnapshotRev = revision;
        this.status = 'available';
        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.statusMessage = `Đã sao lưu recovery lúc ${timeStr} (rev ${revision})`;
        this._notify();
        return { ok: true };
      } catch (err) {
        const isQuota = err && (err.name === 'QuotaExceededError' || String(err.message).includes('quota'));
        this.status = isQuota ? 'quota-exceeded' : 'unavailable';
        this.statusMessage = isQuota
          ? 'Bộ nhớ recovery hết dung lượng — hãy lưu project (.ssb)'
          : 'Phục hồi tự động không khả dụng — hãy lưu project';
        this._notify();
        return { ok: false, error: err?.message || 'Lỗi ghi recovery' };
      }
    });
  }

  /**
   * Check if a valid committed recovery snapshot exists on startup.
   */
  async loadValidSnapshot() {
    if (!this.db) return null;
    try {
      const snap = await this._txGet(STORE_META, SNAPSHOT_KEY);
      if (!snap || snap.status !== 'committed' || !snap.project) return null;

      const val = validateProjectManifest(snap.project);
      if (!val.ok) return null;

      const sourceBinaries = new Map();
      for (const src of snap.project.sources) {
        const rec = await this._txGet(STORE_SOURCES, src.id);
        if (!rec || !rec.blob) {
          // Incomplete sources -> snapshot invalid; do not offer partial recovery
          return null;
        }
        const buf = await rec.blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.byteLength !== src.byteLength) return null;
        sourceBinaries.set(src.id, { bytes, mime: src.mime });
      }

      return {
        savedAt: snap.savedAt,
        revision: snap.revision,
        project: snap.project,
        sourceBinaries
      };
    } catch {
      return null;
    }
  }

  /**
   * Clear all stored recovery data (does NOT touch downloaded `.ssb` files).
   * Serialized through _opQueue so it cannot race with an in-flight autosave (R4).
   */
  clearRecovery() {
    this.cancelPendingSave();
    if (!this.db) return Promise.resolve();
    return this._enqueueOp(async () => {
      if (!this.db) return;
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction([STORE_META, STORE_SOURCES], 'readwrite');
        tx.objectStore(STORE_META).clear();
        tx.objectStore(STORE_SOURCES).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      this.lastSavedSnapshotRev = null;
      if (this.status === 'available' || this.status === 'quota-exceeded') {
        this.status = 'available';
        this.statusMessage = 'Đã xóa dữ liệu recovery cục bộ';
        this._notify();
      }
    });
  }
}
