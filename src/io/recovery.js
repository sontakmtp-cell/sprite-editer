/**
 * Sprite Sheet Builder V2.0 — Best-Effort Crash Recovery (IndexedDB) with Multi-Tab Conflict Guard (Spec §10.3).
 * Stores source blobs by ID + atomic committed snapshot marker so failed writes never corrupt
 * the last valid snapshot. Gracefully reports unavailability on restricted file:// or full quota.
 */

import { generateId, deepClone } from '../core/constants.js';
import { validateProjectManifestV2 } from '../core/validator.js';

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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Schedule debounced idle snapshot save (30s default).
   */
  scheduleSave(getProjectAndAssetMgr) {
    this.cancelPendingSave();
    if (!this.enabled || !this.db || this.status !== 'available' || this.multiTabConflict) return;
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      const ctx = getProjectAndAssetMgr();
      if (!ctx) return;
      await this.saveSnapshotNow(ctx.project, ctx.revision, ctx.assetManager);
    }, this.debounceMs);
  }

  /**
   * Atomically save committed snapshot + only missing source blobs (incremental by source ID).
   * Never overwrites a previously valid snapshot if writing fails!
   */
  async saveSnapshotNow(project, revision, assetManager) {
    if (!this.enabled || !this.db || this.multiTabConflict) return { ok: false, reason: 'disabled-or-conflict' };
    try {
      // 1. Write only sources not already present in IDB
      const existingIds = new Set(await this._txGetAllKeys(STORE_SOURCES));
      const neededIds = new Set(project.sources.map((s) => s.id));

      for (const src of project.sources) {
        if (existingIds.has(src.id)) continue;
        const bytes = assetManager.getSourceBytes(src.id);
        if (!bytes) continue;
        const blob = new Blob([bytes], { type: src.mime });
        await this._txPut(STORE_SOURCES, {
          id: src.id,
          mime: src.mime,
          byteLength: bytes.byteLength,
          blob
        });
      }

      // 2. Atomically write committed snapshot marker in a single transaction
      const snapshot = {
        key: SNAPSHOT_KEY,
        status: 'committed',
        savedAt: Date.now(),
        tabId: this.tabId,
        revision,
        project: deepClone(project)
      };
      await this._txPut(STORE_META, snapshot);

      // 3. Garbage collect orphaned sources from IDB only AFTER new snapshot is committed
      for (const oldId of existingIds) {
        if (!neededIds.has(oldId)) {
          await this._txDelete(STORE_SOURCES, oldId).catch(() => {});
        }
      }

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
  }

  /**
   * Check if a valid committed recovery snapshot exists on startup.
   */
  async loadValidSnapshot() {
    if (!this.db) return null;
    try {
      const snap = await this._txGet(STORE_META, SNAPSHOT_KEY);
      if (!snap || snap.status !== 'committed' || !snap.project) return null;

      const val = validateProjectManifestV2(snap.project);
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
   */
  async clearRecovery() {
    this.cancelPendingSave();
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
  }
}
