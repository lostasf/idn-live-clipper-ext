/**
 * clipperStorage.js — IndexedDB Storage & Cache Engine for Live Stream Segments.
 *
 * Responsibilities:
 *  1. Open & manage IndexedDB database "BetterIdnLive_Clipper".
 *  2. Store raw segment chunks (ArrayBuffer) with timestamps & sequence numbers.
 *  3. Maintain rolling buffer (prune old segments beyond retention window or max size).
 *  4. Provide range queries for clipping & timeline scrubber.
 *  5. Provide stats (total segments, buffered duration, byte size).
 */
(function (global) {
  'use strict';

  const DB_NAME = 'BetterIdnLive_Clipper';
  const DB_VERSION = 1;
  const STORE_SEGMENTS = 'segments';
  const STORE_METADATA = 'metadata';

  // Default buffer retention: 30 minutes, max 1.2 GB
  const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
  const DEFAULT_MAX_BYTES = 1200 * 1024 * 1024;

  let dbPromise = null;

  class ClipperStorage {
    /**
     * Open or return cached IndexedDB instance.
     */
    static openDB() {
      if (dbPromise) return dbPromise;

      dbPromise = new Promise((resolve, reject) => {
        const idb = (typeof globalThis !== 'undefined' ? globalThis.indexedDB : null) ||
                    (typeof self !== 'undefined' ? self.indexedDB : null) ||
                    (typeof window !== 'undefined' ? window.indexedDB : null) ||
                    global.indexedDB;
        if (!idb) {
          return reject(new Error('IndexedDB is not supported in this environment'));
        }

        const request = idb.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
            const store = db.createObjectStore(STORE_SEGMENTS, { keyPath: 'id' });
            store.createIndex('streamSlug', 'streamSlug', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('sequence', 'sequence', { unique: false });
            store.createIndex('stream_sequence', ['streamSlug', 'sequence'], { unique: false });
            store.createIndex('stream_time', ['streamSlug', 'timestamp'], { unique: false });
          }

          if (!db.objectStoreNames.contains(STORE_METADATA)) {
            db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
          }
        };

        request.onsuccess = (event) => {
          const db = event.target.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };

        request.onerror = (event) => {
          console.error('[ClipperStorage] Failed to open DB:', event.target.error);
          dbPromise = null;
          reject(event.target.error);
        };
      });

      return dbPromise;
    }

    /**
     * Save a segment chunk to IndexedDB.
     */
    static async saveSegment({
      streamSlug,
      sequence,
      timestamp,
      duration = 2.0,
      url,
      data,
      quality = 'auto',
      isInitSegment = false,
    }) {
      const byteLength = data ? (data.byteLength ?? data.length ?? 0) : 0;
      if (!streamSlug || sequence == null || byteLength === 0) {
        return null;
      }

      const db = await this.openDB();
      const id = `${streamSlug}_${sequence}`;

      const record = {
        id,
        streamSlug,
        sequence: Number(sequence),
        timestamp: timestamp || Date.now(),
        duration: Number(duration) || 2.0,
        url: url || '',
        data, // ArrayBuffer
        byteLength,
        quality: quality || 'auto',
        isInitSegment: !!isInitSegment,
        savedAt: Date.now(),
      };

      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readwrite');
        const store = tx.objectStore(STORE_SEGMENTS);
        const getReq = store.get(id);

        getReq.onsuccess = () => {
          const existing = getReq.result;
          // Quality Guard: Never overwrite a higher quality segment with a degraded/low-res one (e.g. 160p from minimized window)
          if (existing && existing.byteLength > byteLength * 1.4 && existing.quality !== '160p' && quality === '160p') {
            return resolve(existing);
          }
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve(record);
          putReq.onerror = () => reject(putReq.error);
        };

        getReq.onerror = () => {
          const putReq = store.put(record);
          putReq.onsuccess = () => resolve(record);
          putReq.onerror = () => reject(putReq.error);
        };
      });
    }

    /**
     * Check if a segment by sequence already exists.
     */
    static async hasSegment(streamSlug, sequence) {
      const db = await this.openDB();
      const id = `${streamSlug}_${sequence}`;

      return new Promise((resolve) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readonly');
        const store = tx.objectStore(STORE_SEGMENTS);
        const req = store.getKey(id);
        req.onsuccess = () => resolve(!!req.result);
        req.onerror = () => resolve(false);
      });
    }

    /**
     * Get all cached segments for a given stream, ordered by sequence.
     */
    static async getAllSegments(streamSlug) {
      const db = await this.openDB();

      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readonly');
        const store = tx.objectStore(STORE_SEGMENTS);
        const index = store.index('streamSlug');
        const req = index.getAll(IDBKeyRange.only(streamSlug));

        req.onsuccess = () => {
          const results = req.result || [];
          results.sort((a, b) => a.sequence - b.sequence);
          resolve(results);
        };
        req.onerror = () => reject(req.error);
      });
    }

    /**
     * Get segments for a stream within a timestamp range [startTime, endTime].
     */
    static async getSegmentsInRange(streamSlug, startTimestamp, endTimestamp) {
      const all = await this.getAllSegments(streamSlug);
      if (!all || all.length === 0) return [];

      return all.filter((s) => {
        const segEnd = s.timestamp + (s.duration * 1000);
        return segEnd >= startTimestamp && s.timestamp <= endTimestamp;
      });
    }

    /**
     * Get statistics for a stream (count, total bytes, min/max timestamp, total duration).
     */
    static async getStats(streamSlug) {
      const segments = await this.getAllSegments(streamSlug);

      if (!segments || segments.length === 0) {
        return {
          count: 0,
          totalBytes: 0,
          minTime: 0,
          maxTime: 0,
          durationSec: 0,
          oldestSeq: null,
          newestSeq: null,
        };
      }

      let totalBytes = 0;
      let durationSec = 0;
      let minTime = Infinity;
      let maxTime = -Infinity;

      for (const s of segments) {
        totalBytes += s.byteLength || 0;
        durationSec += s.duration || 2.0;
        if (s.timestamp < minTime) minTime = s.timestamp;
        if (s.timestamp > maxTime) maxTime = s.timestamp;
      }

      return {
        count: segments.length,
        totalBytes,
        minTime: isFinite(minTime) ? minTime : 0,
        maxTime: isFinite(maxTime) ? maxTime : 0,
        durationSec: Math.round(durationSec * 10) / 10,
        oldestSeq: segments[0].sequence,
        newestSeq: segments[segments.length - 1].sequence,
      };
    }

    /**
     * Prune old segments beyond retention window or max bytes.
     */
    static async pruneOldSegments(
      streamSlug,
      retentionMs = DEFAULT_RETENTION_MS,
      maxBytes = DEFAULT_MAX_BYTES
    ) {
      const segments = await this.getAllSegments(streamSlug);
      if (!segments || segments.length <= 1) return 0;

      // Anchor cutoff to the latest segment timestamp so ended streams are never wiped out
      const latestTimestamp = (segments.length > 0 && segments[segments.length - 1].timestamp)
        ? segments[segments.length - 1].timestamp
        : Date.now();
      const cutoffTime = latestTimestamp - retentionMs;

      let toDeleteIds = [];
      let currentBytes = 0;

      for (const s of segments) {
        currentBytes += s.byteLength || 0;
      }

      // 1. Mark segments older than cutoff time (leave at least last 5 segments)
      for (let i = 0; i < segments.length - 5; i++) {
        const s = segments[i];
        if (s.timestamp < cutoffTime) {
          toDeleteIds.push(s.id);
          currentBytes -= s.byteLength || 0;
        }
      }

      // 2. If still exceeding max bytes, remove oldest remaining
      let idx = 0;
      while (currentBytes > maxBytes && idx < segments.length - 5) {
        const s = segments[idx];
        if (!toDeleteIds.includes(s.id)) {
          toDeleteIds.push(s.id);
          currentBytes -= s.byteLength || 0;
        }
        idx++;
      }

      if (toDeleteIds.length === 0) return 0;

      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readwrite');
        const store = tx.objectStore(STORE_SEGMENTS);
        for (const id of toDeleteIds) {
          store.delete(id);
        }
        tx.oncomplete = () => resolve(toDeleteIds.length);
        tx.onerror = () => resolve(0);
      });
    }

    /**
     * Save stream metadata (title, creator, status, etc.) to STORE_METADATA.
     */
    static async saveStreamMetadata(streamSlug, metadata = {}) {
      if (!streamSlug) return null;
      const db = await this.openDB();
      const existing = (await this.getStreamMetadata(streamSlug)) || {};
      const record = {
        key: streamSlug,
        slug: streamSlug,
        title: metadata.title || existing.title || streamSlug,
        creator: metadata.creator || existing.creator || '',
        creatorUsername: metadata.creatorUsername || existing.creatorUsername || '',
        creatorAvatar: metadata.creatorAvatar || existing.creatorAvatar || '',
        status: metadata.status || existing.status || 'live',
        playbackUrl: metadata.playbackUrl || existing.playbackUrl || '',
        createdAt: existing.createdAt || Date.now(),
        updatedAt: Date.now(),
      };

      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_METADATA], 'readwrite');
        const store = tx.objectStore(STORE_METADATA);
        const req = store.put(record);
        req.onsuccess = () => resolve(record);
        req.onerror = () => reject(req.error);
      });
    }

    /**
     * Get stream metadata from STORE_METADATA.
     */
    static async getStreamMetadata(streamSlug) {
      if (!streamSlug) return null;
      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction([STORE_METADATA], 'readonly');
        const store = tx.objectStore(STORE_METADATA);
        const req = store.get(streamSlug);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    /**
     * Get all metadata records.
     */
    static async getAllMetadata() {
      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction([STORE_METADATA], 'readonly');
        const store = tx.objectStore(STORE_METADATA);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }

    /**
     * Format byte sizes into human readable format (KB, MB, GB).
     */
    static formatBytes(bytes) {
      if (!bytes || bytes <= 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + sizes[i];
    }

    /**
     * Format duration seconds into human readable format.
     */
    static formatDuration(sec) {
      if (!sec || sec <= 0) return '0s';
      const s = Math.round(sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const remSec = s % 60;
      if (h > 0) return `${h}h ${m}m ${remSec}s`;
      if (m > 0) return `${m}m ${remSec}s`;
      return `${remSec}s`;
    }

    /**
     * Get all cached streams summary across the database.
     * Returns array of stream summaries with stats and metadata.
     */
    static async getAllCachedStreams() {
      const db = await this.openDB();

      // 1. Fetch all metadata records
      const metaList = await this.getAllMetadata();
      const metaMap = new Map();
      for (const m of metaList) {
        metaMap.set(m.slug || m.key, m);
      }

      // 2. Scan segments store by streamSlug to find all distinct streams and compute stats
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readonly');
        const store = tx.objectStore(STORE_SEGMENTS);
        const index = store.index('streamSlug');
        const streamStatsMap = new Map();

        const req = index.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const s = cursor.value;
            const slug = s.streamSlug;
            if (slug) {
              let stat = streamStatsMap.get(slug);
              if (!stat) {
                stat = {
                  streamSlug: slug,
                  count: 0,
                  totalBytes: 0,
                  durationSec: 0,
                  minTime: s.timestamp || Infinity,
                  maxTime: s.timestamp || -Infinity,
                  oldestSeq: s.sequence,
                  newestSeq: s.sequence,
                  lastSavedAt: s.savedAt || s.timestamp || Date.now(),
                };
                streamStatsMap.set(slug, stat);
              }
              stat.count++;
              stat.totalBytes += s.byteLength || 0;
              stat.durationSec += s.duration || 2.0;
              if (s.timestamp < stat.minTime) stat.minTime = s.timestamp;
              if (s.timestamp > stat.maxTime) stat.maxTime = s.timestamp;
              if (s.sequence < stat.oldestSeq) stat.oldestSeq = s.sequence;
              if (s.sequence > stat.newestSeq) stat.newestSeq = s.sequence;
              if (s.savedAt && s.savedAt > stat.lastSavedAt) stat.lastSavedAt = s.savedAt;
            }
            cursor.continue();
          } else {
            // Combine stats with metadata
            const results = [];
            for (const [slug, stats] of streamStatsMap.entries()) {
              const meta = metaMap.get(slug) || {};
              const durSec = Math.round(stats.durationSec * 10) / 10;
              results.push({
                streamSlug: slug,
                title: meta.title || slug,
                creator: meta.creator || '',
                creatorUsername: meta.creatorUsername || '',
                creatorAvatar: meta.creatorAvatar || '',
                status: meta.status || 'ended',
                playbackUrl: meta.playbackUrl || '',
                count: stats.count,
                totalBytes: stats.totalBytes,
                durationSec: durSec,
                minTime: isFinite(stats.minTime) ? stats.minTime : 0,
                maxTime: isFinite(stats.maxTime) ? stats.maxTime : 0,
                oldestSeq: stats.oldestSeq,
                newestSeq: stats.newestSeq,
                lastSavedAt: stats.lastSavedAt,
                updatedAt: meta.updatedAt || stats.lastSavedAt,
                formattedDuration: ClipperStorage.formatDuration(durSec),
                formattedSize: ClipperStorage.formatBytes(stats.totalBytes),
              });
            }

            // Sort by most recently saved/updated first
            results.sort((a, b) => (b.lastSavedAt || 0) - (a.lastSavedAt || 0));
            resolve(results);
          }
        };

        req.onerror = () => reject(req.error);
      });
    }

    /**
     * Clear all segments for a specific stream (memory-safe deletion).
     */
    static async clearStream(streamSlug) {
      if (!streamSlug) return 0;
      const db = await this.openDB();
      let deletedCount = 0;

      await new Promise((resolve) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readwrite');
        const store = tx.objectStore(STORE_SEGMENTS);
        const index = store.index('streamSlug');
        const req = index.openKeyCursor(IDBKeyRange.only(streamSlug));

        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            deletedCount++;
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve(deletedCount);
        tx.onerror = () => resolve(deletedCount);
      });

      // Also clean up metadata store
      try {
        await new Promise((resolve) => {
          const tx = db.transaction([STORE_METADATA], 'readwrite');
          const store = tx.objectStore(STORE_METADATA);
          const req = store.delete(streamSlug);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        });
      } catch (_) {}

      return deletedCount;
    }

    /**
     * Clear entire database (both segments and metadata).
     */
    static async clearAll() {
      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction([STORE_SEGMENTS, STORE_METADATA], 'readwrite');
        tx.objectStore(STORE_SEGMENTS).clear();
        tx.objectStore(STORE_METADATA).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
  }

  // Export to global scope
  global.ClipperStorage = ClipperStorage;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this)));
