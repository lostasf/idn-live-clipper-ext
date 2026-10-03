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
        const tx = db.transaction([STORE_SEGMENTS, STORE_METADATA], 'readwrite');
        const segStore = tx.objectStore(STORE_SEGMENTS);
        const metaStore = tx.objectStore(STORE_METADATA);
        const getReq = segStore.get(id);

        getReq.onsuccess = () => {
          const existing = getReq.result;
          // Quality Guard: Never overwrite a higher quality segment with a degraded/low-res one (e.g. 160p from minimized window)
          if (existing && existing.byteLength > byteLength * 1.4 && existing.quality !== '160p' && quality === '160p') {
            return resolve(existing);
          }
          segStore.put(record);

          // Update STORE_METADATA incrementally with stats and lightweight segmentsMeta
          const metaReq = metaStore.get(streamSlug);
          metaReq.onsuccess = () => {
            let meta = metaReq.result;
            if (!meta) {
              meta = {
                key: streamSlug,
                slug: streamSlug,
                title: streamSlug,
                creator: '',
                creatorUsername: '',
                creatorAvatar: '',
                status: 'live',
                playbackUrl: '',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
            }

            const segmentsMeta = Array.isArray(meta.segmentsMeta) ? meta.segmentsMeta : [];
            const existingIdx = segmentsMeta.findIndex((s) => s.sequence === record.sequence);
            const metaEntry = {
              sequence: record.sequence,
              timestamp: record.timestamp,
              duration: record.duration,
              byteLength: record.byteLength,
              quality: record.quality,
            };

            if (existingIdx >= 0) {
              segmentsMeta[existingIdx] = metaEntry;
            } else {
              segmentsMeta.push(metaEntry);
              segmentsMeta.sort((a, b) => a.sequence - b.sequence);
            }

            meta.segmentsMeta = segmentsMeta;

            // Recompute aggregate stats without reading ArrayBuffers
            let totalBytes = 0;
            let durationSec = 0;
            let minTime = Infinity;
            let maxTime = -Infinity;

            for (const s of segmentsMeta) {
              totalBytes += s.byteLength || 0;
              durationSec += s.duration || 2.0;
              if (s.timestamp < minTime) minTime = s.timestamp;
              if (s.timestamp > maxTime) maxTime = s.timestamp;
            }

            meta.stats = {
              count: segmentsMeta.length,
              totalBytes,
              durationSec: Math.round(durationSec * 10) / 10,
              minTime: isFinite(minTime) ? minTime : 0,
              maxTime: isFinite(maxTime) ? maxTime : 0,
              oldestSeq: segmentsMeta[0]?.sequence ?? null,
              newestSeq: segmentsMeta[segmentsMeta.length - 1]?.sequence ?? null,
              lastSavedAt: record.savedAt,
            };
            meta.updatedAt = Date.now();
            metaStore.put(meta);
          };

          tx.oncomplete = () => resolve(record);
          tx.onerror = () => reject(tx.error);
        };

        getReq.onerror = () => {
          segStore.put(record);
          tx.oncomplete = () => resolve(record);
          tx.onerror = () => reject(tx.error);
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
     * WARNING: Loads full binary ArrayBuffers. Use getSegmentsMeta when only sequence/timestamps/size are needed.
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
     * Get lightweight segment metadata for a stream WITHOUT loading heavy ArrayBuffer data.
     * Instant O(1) read from STORE_METADATA, ideal for timeline scrubbers and markers.
     */
    static async getSegmentsMeta(streamSlug) {
      if (!streamSlug) return [];

      // Fast path: check STORE_METADATA cache
      const meta = await this.getStreamMetadata(streamSlug);
      if (meta && Array.isArray(meta.segmentsMeta) && meta.segmentsMeta.length > 0) {
        return meta.segmentsMeta;
      }

      // Fallback: scan STORE_SEGMENTS with cursor, extracting only metadata fields (no data retention)
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readonly');
        const store = tx.objectStore(STORE_SEGMENTS);
        const index = store.index('streamSlug');
        const req = index.openCursor(IDBKeyRange.only(streamSlug));
        const list = [];

        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const val = cursor.value;
            list.push({
              sequence: val.sequence,
              timestamp: val.timestamp,
              duration: val.duration,
              byteLength: val.byteLength,
              quality: val.quality,
            });
            cursor.continue();
          } else {
            list.sort((a, b) => a.sequence - b.sequence);
            if (list.length > 0) {
              (async () => {
                try {
                  const currentMeta = (await ClipperStorage.getStreamMetadata(streamSlug)) || {
                    key: streamSlug,
                    slug: streamSlug,
                    title: streamSlug,
                    createdAt: Date.now(),
                  };
                  currentMeta.segmentsMeta = list;
                  let totalBytes = 0;
                  let durationSec = 0;
                  let minTime = Infinity;
                  let maxTime = -Infinity;
                  for (const s of list) {
                    totalBytes += s.byteLength || 0;
                    durationSec += s.duration || 2.0;
                    if (s.timestamp < minTime) minTime = s.timestamp;
                    if (s.timestamp > maxTime) maxTime = s.timestamp;
                  }
                  currentMeta.stats = {
                    count: list.length,
                    totalBytes,
                    durationSec: Math.round(durationSec * 10) / 10,
                    minTime: isFinite(minTime) ? minTime : 0,
                    maxTime: isFinite(maxTime) ? maxTime : 0,
                    oldestSeq: list[0]?.sequence ?? null,
                    newestSeq: list[list.length - 1]?.sequence ?? null,
                    lastSavedAt: currentMeta.updatedAt || Date.now(),
                  };
                  currentMeta.updatedAt = Date.now();
                  await ClipperStorage.saveStreamMetadata(streamSlug, currentMeta);
                } catch (_) {}
              })();
            }
            resolve(list);
          }
        };
        req.onerror = () => reject(req.error);
      });
    }

    /**
     * Get segments for a stream within a timestamp range [startTime, endTime].
     * Optimized to query only index 'stream_time' within the bounded window.
     */
    static async getSegmentsInRange(streamSlug, startTimestamp, endTimestamp) {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_SEGMENTS], 'readonly');
        const store = tx.objectStore(STORE_SEGMENTS);
        const index = store.index('stream_time');

        // Bounded range with 10s buffer
        const startRange = Math.max(0, (Number(startTimestamp) || 0) - 10000);
        const endRange = (Number(endTimestamp) || Infinity) + 10000;
        const range = IDBKeyRange.bound([streamSlug, startRange], [streamSlug, endRange]);
        const req = index.getAll(range);

        req.onsuccess = () => {
          const all = req.result || [];
          const filtered = all.filter((s) => {
            const segEnd = s.timestamp + (s.duration * 1000);
            return segEnd >= startTimestamp && s.timestamp <= endTimestamp;
          });
          filtered.sort((a, b) => a.sequence - b.sequence);
          resolve(filtered);
        };
        req.onerror = () => reject(req.error);
      });
    }

    /**
     * Get statistics for a stream (count, total bytes, min/max timestamp, total duration).
     * Instant O(1) read from STORE_METADATA without touching heavy ArrayBuffers.
     */
    static async getStats(streamSlug) {
      if (!streamSlug) {
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

      // Fast path: instant read from STORE_METADATA
      const meta = await this.getStreamMetadata(streamSlug);
      if (meta && meta.stats && typeof meta.stats.count === 'number') {
        return {
          count: meta.stats.count,
          totalBytes: meta.stats.totalBytes || 0,
          minTime: isFinite(meta.stats.minTime) ? meta.stats.minTime : 0,
          maxTime: isFinite(meta.stats.maxTime) ? meta.stats.maxTime : 0,
          durationSec: Math.round((meta.stats.durationSec || 0) * 10) / 10,
          oldestSeq: meta.stats.oldestSeq ?? null,
          newestSeq: meta.stats.newestSeq ?? null,
        };
      }

      // Fallback: populate from segmentsMeta
      const sMeta = await this.getSegmentsMeta(streamSlug);
      if (!sMeta || sMeta.length === 0) {
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

      for (const s of sMeta) {
        totalBytes += s.byteLength || 0;
        durationSec += s.duration || 2.0;
        if (s.timestamp < minTime) minTime = s.timestamp;
        if (s.timestamp > maxTime) maxTime = s.timestamp;
      }

      return {
        count: sMeta.length,
        totalBytes,
        minTime: isFinite(minTime) ? minTime : 0,
        maxTime: isFinite(maxTime) ? maxTime : 0,
        durationSec: Math.round(durationSec * 10) / 10,
        oldestSeq: sMeta[0].sequence,
        newestSeq: sMeta[sMeta.length - 1].sequence,
      };
    }

    /**
     * Prune old segments beyond retention window or max bytes.
     * Memory-safe: operates purely on segment metadata IDs without loading ArrayBuffers.
     */
    static async pruneOldSegments(
      streamSlug,
      retentionMs = DEFAULT_RETENTION_MS,
      maxBytes = DEFAULT_MAX_BYTES
    ) {
      if (!streamSlug) return 0;
      const segmentsMeta = await this.getSegmentsMeta(streamSlug);
      if (!segmentsMeta || segmentsMeta.length <= 1) return 0;

      const latestTimestamp = segmentsMeta[segmentsMeta.length - 1].timestamp || Date.now();
      const cutoffTime = latestTimestamp - retentionMs;

      let toDeleteIds = [];
      let currentBytes = 0;

      for (const s of segmentsMeta) {
        currentBytes += s.byteLength || 0;
      }

      // 1. Mark segments older than cutoff time (leave at least last 5 segments)
      for (let i = 0; i < segmentsMeta.length - 5; i++) {
        const s = segmentsMeta[i];
        if (s.timestamp < cutoffTime) {
          toDeleteIds.push(`${streamSlug}_${s.sequence}`);
          currentBytes -= s.byteLength || 0;
        }
      }

      // 2. If still exceeding max bytes, remove oldest remaining
      let idx = 0;
      while (currentBytes > maxBytes && idx < segmentsMeta.length - 5) {
        const s = segmentsMeta[idx];
        const segId = `${streamSlug}_${s.sequence}`;
        if (!toDeleteIds.includes(segId)) {
          toDeleteIds.push(segId);
          currentBytes -= s.byteLength || 0;
        }
        idx++;
      }

      if (toDeleteIds.length === 0) return 0;

      const db = await this.openDB();
      return new Promise((resolve) => {
        const tx = db.transaction([STORE_SEGMENTS, STORE_METADATA], 'readwrite');
        const segStore = tx.objectStore(STORE_SEGMENTS);
        const metaStore = tx.objectStore(STORE_METADATA);

        for (const id of toDeleteIds) {
          segStore.delete(id);
        }

        const metaReq = metaStore.get(streamSlug);
        metaReq.onsuccess = () => {
          const meta = metaReq.result;
          if (meta && Array.isArray(meta.segmentsMeta)) {
            const deletedIdSet = new Set(toDeleteIds);
            meta.segmentsMeta = meta.segmentsMeta.filter(s => !deletedIdSet.has(`${streamSlug}_${s.sequence}`));
            const remaining = meta.segmentsMeta;
            let totalBytes = 0;
            let durationSec = 0;
            let minTime = Infinity;
            let maxTime = -Infinity;
            for (const s of remaining) {
              totalBytes += s.byteLength || 0;
              durationSec += s.duration || 2.0;
              if (s.timestamp < minTime) minTime = s.timestamp;
              if (s.timestamp > maxTime) maxTime = s.timestamp;
            }
            meta.stats = {
              count: remaining.length,
              totalBytes,
              durationSec: Math.round(durationSec * 10) / 10,
              minTime: isFinite(minTime) ? minTime : 0,
              maxTime: isFinite(maxTime) ? maxTime : 0,
              oldestSeq: remaining[0]?.sequence ?? null,
              newestSeq: remaining[remaining.length - 1]?.sequence ?? null,
              lastSavedAt: meta.stats?.lastSavedAt || meta.updatedAt || Date.now(),
            };
            meta.updatedAt = Date.now();
            metaStore.put(meta);
          }
        };

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
        stats: existing.stats || metadata.stats || {
          streamSlug,
          count: 0,
          totalBytes: 0,
          durationSec: 0,
          minTime: 0,
          maxTime: 0,
          oldestSeq: null,
          newestSeq: null,
          lastSavedAt: Date.now(),
        },
        segmentsMeta: existing.segmentsMeta || metadata.segmentsMeta || [],
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
     * Fast path: reads STORE_METADATA directly (< 1ms, zero ArrayBuffer deserialization).
     * Automatically handles one-time migration for legacy records.
     */
    static async getAllCachedStreams() {
      const db = await this.openDB();

      // 1. Fetch all metadata records (instant, ~0.5ms)
      const metaList = await this.getAllMetadata();
      let needsMigration = false;
      const results = [];

      for (const meta of metaList) {
        const slug = meta.slug || meta.key;
        if (!slug) continue;

        if (meta.stats && typeof meta.stats.count === 'number') {
          if (meta.stats.count > 0 || meta.stats.totalBytes > 0) {
            const durSec = Math.round((meta.stats.durationSec || 0) * 10) / 10;
            results.push({
              streamSlug: slug,
              title: meta.title || slug,
              creator: meta.creator || '',
              creatorUsername: meta.creatorUsername || '',
              creatorAvatar: meta.creatorAvatar || '',
              status: meta.status || 'ended',
              playbackUrl: meta.playbackUrl || '',
              count: meta.stats.count,
              totalBytes: meta.stats.totalBytes || 0,
              durationSec: durSec,
              minTime: isFinite(meta.stats.minTime) ? meta.stats.minTime : 0,
              maxTime: isFinite(meta.stats.maxTime) ? meta.stats.maxTime : 0,
              oldestSeq: meta.stats.oldestSeq ?? null,
              newestSeq: meta.stats.newestSeq ?? null,
              lastSavedAt: meta.stats.lastSavedAt || meta.updatedAt || Date.now(),
              updatedAt: meta.updatedAt || Date.now(),
              formattedDuration: ClipperStorage.formatDuration(durSec),
              formattedSize: ClipperStorage.formatBytes(meta.stats.totalBytes || 0),
            });
          }
        } else {
          needsMigration = true;
        }
      }

      // Fast path: if all existing metadata entries have valid stats, return immediately in < 1ms!
      if (!needsMigration && metaList.length > 0) {
        results.sort((a, b) => (b.lastSavedAt || 0) - (a.lastSavedAt || 0));
        return results;
      }

      if (metaList.length === 0) {
        // Fast check: is STORE_SEGMENTS also empty?
        const hasSegments = await new Promise((res) => {
          const tx = db.transaction([STORE_SEGMENTS], 'readonly');
          const req = tx.objectStore(STORE_SEGMENTS).count();
          req.onsuccess = () => res((req.result || 0) > 0);
          req.onerror = () => res(false);
        });
        if (!hasSegments) {
          return [];
        }
      }

      // One-time migration scan for legacy databases without stored stats:
      // Scan segments once, compute and persist stats to STORE_METADATA
      const metaMap = new Map();
      for (const m of metaList) {
        metaMap.set(m.slug || m.key, m);
      }

      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_SEGMENTS, STORE_METADATA], 'readwrite');
        const store = tx.objectStore(STORE_SEGMENTS);
        const metaStore = tx.objectStore(STORE_METADATA);
        const index = store.index('streamSlug');
        const streamStatsMap = new Map();
        const streamSegmentsMap = new Map();

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
                streamSegmentsMap.set(slug, []);
              }
              stat.count++;
              stat.totalBytes += s.byteLength || 0;
              stat.durationSec += s.duration || 2.0;
              if (s.timestamp < stat.minTime) stat.minTime = s.timestamp;
              if (s.timestamp > stat.maxTime) stat.maxTime = s.timestamp;
              if (s.sequence < stat.oldestSeq) stat.oldestSeq = s.sequence;
              if (s.sequence > stat.newestSeq) stat.newestSeq = s.sequence;
              if (s.savedAt && s.savedAt > stat.lastSavedAt) stat.lastSavedAt = s.savedAt;

              streamSegmentsMap.get(slug).push({
                sequence: s.sequence,
                timestamp: s.timestamp,
                duration: s.duration,
                byteLength: s.byteLength,
                quality: s.quality,
              });
            }
            cursor.continue();
          } else {
            const finalResults = [];
            for (const [slug, stats] of streamStatsMap.entries()) {
              const meta = metaMap.get(slug) || {
                key: slug,
                slug,
                title: slug,
                createdAt: Date.now(),
              };
              const durSec = Math.round(stats.durationSec * 10) / 10;
              const segs = streamSegmentsMap.get(slug) || [];
              segs.sort((a, b) => a.sequence - b.sequence);

              meta.stats = stats;
              meta.segmentsMeta = segs;
              meta.updatedAt = stats.lastSavedAt || Date.now();
              metaStore.put(meta);

              finalResults.push({
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
                updatedAt: meta.updatedAt,
                formattedDuration: ClipperStorage.formatDuration(durSec),
                formattedSize: ClipperStorage.formatBytes(stats.totalBytes),
              });
            }

            // CRUCIAL: For any metadata records that had 0 segments in STORE_SEGMENTS,
            // persist empty stats so they are marked as migrated and don't re-trigger migration!
            for (const [slug, meta] of metaMap.entries()) {
              if (!streamStatsMap.has(slug)) {
                meta.stats = {
                  streamSlug: slug,
                  count: 0,
                  totalBytes: 0,
                  durationSec: 0,
                  minTime: 0,
                  maxTime: 0,
                  oldestSeq: null,
                  newestSeq: null,
                  lastSavedAt: meta.updatedAt || meta.createdAt || Date.now(),
                };
                meta.segmentsMeta = [];
                meta.updatedAt = Date.now();
                metaStore.put(meta);
              }
            }

            finalResults.sort((a, b) => (b.lastSavedAt || 0) - (a.lastSavedAt || 0));
            resolve(finalResults);
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
