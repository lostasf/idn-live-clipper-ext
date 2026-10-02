/**
 * clipperTransmuxer.js — Fast Browser-Side MPEG-TS to MP4 Remuxer.
 *
 * Responsibilities:
 *  1. Remux cached TS segments into standard ISO BMFF MP4 containers (no re-encoding!).
 *  2. Normalize timestamps so the exported clip starts at 00:00:00.
 *  3. Handle progress callbacks to update UI progress bars.
 *  4. Support both MPEG-TS (.ts) and Fragmented MP4 (.m4s / .mp4) streams.
 */
(function (global) {
  'use strict';

  class ClipperTransmuxer {
    /**
     * Safely convert any buffer/array representation to Uint8Array.
     */
    static toUint8Array(data) {
      if (!data) return new Uint8Array(0);
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (Array.isArray(data)) return new Uint8Array(data);
      if (typeof data === 'object') return new Uint8Array(Object.values(data));
      return new Uint8Array(0);
    }

    /**
     * Check if a data buffer is MPEG-TS (sync byte 0x47 every 188 bytes).
     */
    static isMpegTs(uint8Array) {
      if (!uint8Array || uint8Array.length < 188) return false;
      return uint8Array[0] === 0x47 && (uint8Array.length < 376 || uint8Array[188] === 0x47);
    }

    /**
     * Check if a data buffer is an MP4 box (ftyp, moof, moov, styp).
     */
    static isMp4Box(uint8Array) {
      if (!uint8Array || uint8Array.length < 8) return false;
      const type = String.fromCharCode(
        uint8Array[4],
        uint8Array[5],
        uint8Array[6],
        uint8Array[7]
      );
      return ['ftyp', 'moov', 'moof', 'styp', 'mdat'].includes(type);
    }

    /**
     * Transmux an array of segment records (from ClipperStorage) into an MP4 Blob.
     *
     * @param {Array<Object>} segments - Array of { data: ArrayBuffer, sequence, duration }
     * @param {Function} onProgress - Callback (percent, current, total)
     * @returns {Promise<{ blob: Blob, duration: number, size: number, segmentCount: number }>}
     */
    static async transmux(segments, onProgress = null) {
      if (!segments || segments.length === 0) {
        throw new Error('No segments provided for transmuxing');
      }

      const muxjs = global.muxjs || (typeof window !== 'undefined' ? window.muxjs : null);
      if (!muxjs || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
        throw new Error('mux.js library not loaded');
      }

      // Check format of first segment
      const firstChunk = this.toUint8Array(segments[0].data);
      const isTs = this.isMpegTs(firstChunk);

      if (!isTs && this.isMp4Box(firstChunk)) {
        // Segments are already fMP4! Direct concatenation into MP4 blob
        return this.concatFmp4(segments, onProgress);
      }

      // MPEG-TS remuxing via mux.js
      return new Promise(async (resolve, reject) => {
        try {
          const transmuxer = new muxjs.mp4.Transmuxer({
            remux: true,
            keepOriginalTimestamps: false, // Normalizes clip PTS to start at 0
          });

          let initSegment = null;
          const mediaChunks = [];

          transmuxer.on('data', (segment) => {
            if (segment.initSegment && !initSegment) {
              initSegment = segment.initSegment;
            }
            if (segment.data) {
              mediaChunks.push(segment.data);
            }
          });

          const totalSegments = segments.length;
          let totalDuration = 0;

          for (let i = 0; i < totalSegments; i++) {
            const seg = segments[i];
            totalDuration += Number(seg.duration) || 2.0;

            const u8 = this.toUint8Array(seg.data);
            transmuxer.push(u8);
            transmuxer.flush();

            if (onProgress) {
              const pct = Math.round(((i + 1) / totalSegments) * 100);
              onProgress(pct, i + 1, totalSegments);
            }

            // Yield to browser UI thread periodically
            if (i % 5 === 0) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          if (!initSegment || mediaChunks.length === 0) {
            return reject(new Error('Remuxer did not produce valid MP4 video data. Check segment format.'));
          }

          // Combine initSegment + media data chunks
          const totalBytes =
            initSegment.byteLength +
            mediaChunks.reduce((acc, c) => acc + c.byteLength, 0);

          const finalBuffer = new Uint8Array(totalBytes);
          finalBuffer.set(new Uint8Array(initSegment), 0);

          let offset = initSegment.byteLength;
          for (const chunk of mediaChunks) {
            finalBuffer.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
          }

          // Patch duration headers (mvhd, tkhd, mdhd, mehd) so media players
          // report the exact clip duration (e.g. 30s) instead of mux.js default 13h15m!
          ClipperTransmuxer.patchMp4Duration(finalBuffer, totalDuration);

          const blob = new Blob([finalBuffer], { type: 'video/mp4' });

          resolve({
            blob,
            duration: totalDuration,
            size: totalBytes,
            segmentCount: totalSegments,
          });
        } catch (err) {
          reject(err);
        }
      });
    }

    /**
     * Patch ISO BMFF MP4 header boxes (mvhd, tkhd, mdhd, mehd) with the exact clip duration.
     * Prevents media players from reporting ~13 hours caused by mux.js 0xFFFFFFFF defaults.
     *
     * @param {Uint8Array} buffer - MP4 file buffer containing moov box
     * @param {number} durationSec - Actual duration of the clip in seconds
     * @returns {Uint8Array}
     */
    static patchMp4Duration(buffer, durationSec) {
      if (!buffer || buffer.length < 8 || !durationSec || durationSec <= 0) return buffer;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      let movieTimescale = 90000;

      function readBoxHeader(offset) {
        if (offset + 8 > buffer.length) return null;
        let size = view.getUint32(offset);
        const type = String.fromCharCode(
          buffer[offset + 4],
          buffer[offset + 5],
          buffer[offset + 6],
          buffer[offset + 7]
        );
        let headerSize = 8;
        if (size === 1) {
          if (offset + 16 > buffer.length) return null;
          size = Number(view.getBigUint64(offset + 8));
          headerSize = 16;
        } else if (size === 0) {
          size = buffer.length - offset;
        }
        return { size, type, headerSize };
      }

      function traverseBoxes(offset, end) {
        let p = offset;
        while (p < end) {
          const box = readBoxHeader(p);
          if (!box || box.size <= 0 || p + box.size > buffer.length) break;
          const type = box.type;
          const payloadOffset = p + box.headerSize;
          const boxEnd = p + box.size;

          if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'mvex') {
            traverseBoxes(payloadOffset, boxEnd);
          } else if (type === 'mvhd') {
            const version = view.getUint8(payloadOffset);
            let timescaleOffset, durationOffset;
            if (version === 0) {
              timescaleOffset = payloadOffset + 12; // 4 (v/flags) + 4 (creation) + 4 (mod)
              durationOffset = payloadOffset + 16;
              movieTimescale = view.getUint32(timescaleOffset) || 90000;
              const units = Math.round(durationSec * movieTimescale);
              view.setUint32(durationOffset, units);
            } else if (version === 1) {
              timescaleOffset = payloadOffset + 20; // 4 (v/flags) + 8 (creation) + 8 (mod)
              durationOffset = payloadOffset + 24;
              movieTimescale = view.getUint32(timescaleOffset) || 90000;
              const units = BigInt(Math.round(durationSec * movieTimescale));
              view.setBigUint64(durationOffset, units);
            }
          } else if (type === 'tkhd') {
            const version = view.getUint8(payloadOffset);
            let durationOffset;
            if (version === 0) {
              durationOffset = payloadOffset + 20; // 4 + 4 + 4 + 4 + 4
              const units = Math.round(durationSec * movieTimescale);
              view.setUint32(durationOffset, units);
            } else if (version === 1) {
              durationOffset = payloadOffset + 28; // 4 + 8 + 8 + 4 + 4
              const units = BigInt(Math.round(durationSec * movieTimescale));
              view.setBigUint64(durationOffset, units);
            }
          } else if (type === 'mdhd') {
            const version = view.getUint8(payloadOffset);
            let timescaleOffset, durationOffset;
            if (version === 0) {
              timescaleOffset = payloadOffset + 12;
              durationOffset = payloadOffset + 16;
              const trackTimescale = view.getUint32(timescaleOffset) || movieTimescale;
              const units = Math.round(durationSec * trackTimescale);
              view.setUint32(durationOffset, units);
            } else if (version === 1) {
              timescaleOffset = payloadOffset + 20;
              durationOffset = payloadOffset + 24;
              const trackTimescale = view.getUint32(timescaleOffset) || movieTimescale;
              const units = BigInt(Math.round(durationSec * trackTimescale));
              view.setBigUint64(durationOffset, units);
            }
          } else if (type === 'mehd') {
            const version = view.getUint8(payloadOffset);
            let durationOffset;
            if (version === 0) {
              durationOffset = payloadOffset + 4;
              const units = Math.round(durationSec * movieTimescale);
              view.setUint32(durationOffset, units);
            } else if (version === 1) {
              durationOffset = payloadOffset + 4;
              const units = BigInt(Math.round(durationSec * movieTimescale));
              view.setBigUint64(durationOffset, units);
            }
          }

          p = boxEnd;
        }
      }

      traverseBoxes(0, buffer.length);
      return buffer;
    }

    /**
     * Direct concatenation for streams already in fMP4 format.
     */
    static async concatFmp4(segments, onProgress = null) {
      const parts = [];
      let totalBytes = 0;
      let totalDuration = 0;
      const total = segments.length;

      for (let i = 0; i < total; i++) {
        const seg = segments[i];
        totalDuration += Number(seg.duration) || 2.0;
        const u8Part = this.toUint8Array(seg.data);
        parts.push(u8Part);
        totalBytes += u8Part.byteLength;

        if (onProgress) {
          const pct = Math.round(((i + 1) / total) * 100);
          onProgress(pct, i + 1, total);
        }

        if (i % 10 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      // If parts has segments, combine into single buffer to patch duration if moov exists
      const finalBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const part of parts) {
        finalBuffer.set(part, offset);
        offset += part.byteLength;
      }
      ClipperTransmuxer.patchMp4Duration(finalBuffer, totalDuration);

      const blob = new Blob([finalBuffer], { type: 'video/mp4' });
      return {
        blob,
        duration: totalDuration,
        size: totalBytes,
        segmentCount: total,
      };
    }
  }

  // Export to global scope
  global.ClipperTransmuxer = ClipperTransmuxer;
})(typeof window !== 'undefined' ? window : globalThis);
