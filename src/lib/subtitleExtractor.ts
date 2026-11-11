import {
  ByteReader,
  createFileByteReader,
  createRangeByteReader,
  iterateMp4Children,
  readAscii,
  readEbmlId,
  readEbmlSize,
  readEbmlUint,
} from './audioTracks';
import {
  buildMp4SampleTable,
  openMkvContainerContext,
  readMp4MoovBox,
  unpackMkvBlockFrames,
} from './mseAudioPlayer';

export interface ExtractedSubtitleCue {
  start: number;
  end: number;
  text: string;
}

export type EmbeddedSubtitleOpenResult =
  | {
      mode: 'complete';
      cues: ExtractedSubtitleCue[];
      vttText: string;
    }
  | {
      mode: 'streaming';
      controller: EmbeddedSubtitleController;
    };

function formatVttTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export function cuesToWebVtt(cues: ExtractedSubtitleCue[]): string {
  const lines: string[] = ['WEBVTT', ''];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (!c.text) continue;
    lines.push(`${formatVttTimestamp(c.start)} --> ${formatVttTimestamp(Math.max(c.end, c.start + 0.1))}`);
    lines.push(c.text);
    lines.push('');
  }
  return lines.join('\n');
}

function decodeUtf8Bytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff && typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe && typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  return readAscii(bytes, 0, bytes.length);
}

async function decompressBlockBytes(
  raw: Uint8Array,
  compAlgo: number,
  compHeader: Uint8Array
): Promise<Uint8Array> {
  let payload = raw;
  if (compAlgo === 3 && compHeader.length > 0) {
    const combined = new Uint8Array(compHeader.length + raw.length);
    combined.set(compHeader, 0);
    combined.set(raw, compHeader.length);
    return combined;
  }

  if (compAlgo === 0) {
    const DS = (
      globalThis as unknown as {
        DecompressionStream?: new (format: string) => {
          writable: WritableStream<Uint8Array>;
          readable: ReadableStream<Uint8Array>;
        };
      }
    ).DecompressionStream;

    if (typeof DS === 'function') {
      try {
        const stream = new DS('deflate');
        const writer = stream.writable.getWriter();
        const copy = new Uint8Array(raw.byteLength);
        copy.set(raw);
        writer.write(copy).catch(() => {});
        writer.close().catch(() => {});

        const reader = stream.readable.getReader();
        const chunks: Uint8Array[] = [];
        let totalLen = 0;
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          if (step.value) {
            chunks.push(step.value);
            totalLen += step.value.length;
          }
        }
        const merged = new Uint8Array(totalLen);
        let pos = 0;
        for (let i = 0; i < chunks.length; i++) {
          merged.set(chunks[i], pos);
          pos += chunks[i].length;
        }
        payload = merged;
      } catch {
        return raw;
      }
    }
  }

  return payload;
}

function parseAssCommaCount(codecPrivate: Uint8Array): number {
  if (codecPrivate.length === 0) return 8;
  const header = decodeUtf8Bytes(codecPrivate);
  const lines = header.replace(/\r\n/g, '\n').split('\n');
  let inEvents = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) === '[') {
      inEvents = line.toLowerCase() === '[events]';
      continue;
    }
    if (inEvents && line.toLowerCase().indexOf('format:') === 0) {
      const cols = line.slice(7).split(',');
      let payloadFieldCount = 0;
      let hasReadOrder = false;
      for (let c = 0; c < cols.length; c++) {
        const colName = cols[c].trim().toLowerCase();
        if (!colName) continue;
        if (colName === 'start' || colName === 'end') continue;
        if (colName === 'readorder') hasReadOrder = true;
        payloadFieldCount++;
      }
      if (!hasReadOrder) {
        // Matroska strips Start/End and prepends ReadOrder before remaining fields
        payloadFieldCount++;
      }
      return Math.max(0, payloadFieldCount - 1);
    }
  }
  return 8;
}

export function cleanSubtitleText(
  rawText: string,
  codecRaw?: string,
  assCommaCount = 8
): string {
  if (!rawText) return '';
  let text = rawText.replace(/\0+$/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const upperCodec = (codecRaw || '').toUpperCase();
  if (upperCodec === 'S_TEXT/ASS' || upperCodec === 'S_TEXT/SSA') {
    let commasFound = 0;
    let splitAt = 0;
    for (let i = 0; i < text.length && commasFound < assCommaCount; i++) {
      if (text.charCodeAt(i) === 44) {
        commasFound++;
        if (commasFound === assCommaCount) {
          splitAt = i + 1;
        }
      }
    }
    if (commasFound === assCommaCount) {
      text = text.slice(splitAt);
    }

    // Strip ASS vector drawing mode segments ({\p1}...{\p0}) so coordinates are never rendered as text
    text = text.replace(/\{[^}]*\\p[1-9]\d*(?:\\[^}]*)?\}[\s\S]*?(?=\{[^}]*\\p0[^}]*\}|$)/g, '');
  }

  // Strip ASS override blocks like {\an8}, {\i1}, {\pos(x,y)} (also seen in SRT/MKV muxes)
  text = text.replace(/\{[^}]*\}/g, '');
  // Convert ASS line-break & hard-space escapes
  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  // Strip HTML-like markup tags (<i>, <b>, <font ...>, <c.color>)
  text = text.replace(/<[^>]+>/g, '');

  const lines = text.split('\n');
  const cleanedLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) cleanedLines.push(trimmed);
  }
  return cleanedLines.join('\n').trim();
}

function normalizeAndSortCues(cues: ExtractedSubtitleCue[]): ExtractedSubtitleCue[] {
  const sorted = cues.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const deduped: ExtractedSubtitleCue[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (!c.text) continue;
    const key = `${Math.round(c.start * 1000)}|${Math.round(c.end * 1000)}|${c.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }
  return deduped;
}

// ============================================================================
// MP4 Embedded Subtitle Extractor (tx3g, wvtt, text)
// ============================================================================

async function extractMp4Subtitles(
  reader: ByteReader,
  subtitleTrackIndex: number
): Promise<EmbeddedSubtitleOpenResult | null> {
  const moovBytes = await readMp4MoovBox(reader);
  if (!moovBytes) return null;

  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  let mvhdTimescale = 1000;
  const chapterTrackIds = new Set<number>();

  interface RawSubTrak {
    trackId: number;
    handler: string;
    fourcc: string;
    mdhdTs: number;
    emptyDelay: number;
    sttsBytes: Uint8Array | null;
    stscBytes: Uint8Array | null;
    stszBytes: Uint8Array | null;
    stcoBytes: Uint8Array | null;
    isCo64: boolean;
  }

  const candidateTraks: RawSubTrak[] = [];

  iterateMp4Children(moovBytes, 0, moovBytes.length, (type, pStart, pEnd) => {
    if (type === 'mvhd' && pStart + 20 <= pEnd) {
      const v = moovBytes[pStart];
      mvhdTimescale = view.getUint32(pStart + (v === 1 ? 20 : 12), false) || 1000;
      return;
    }
    if (type !== 'trak') return;

    let trackId = 0;
    let handler = '';
    let fourcc = '';
    let mdhdTs = 1000;
    let emptyDelay = 0;
    let sttsBytes: Uint8Array | null = null;
    let stscBytes: Uint8Array | null = null;
    let stszBytes: Uint8Array | null = null;
    let stcoBytes: Uint8Array | null = null;
    let isCo64 = false;

    iterateMp4Children(moovBytes, pStart, pEnd, (tType, tStart, tEnd) => {
      if (tType === 'tkhd' && tStart + 4 <= tEnd) {
        const v = moovBytes[tStart];
        const idOff = tStart + (v === 1 ? 20 : 12);
        if (idOff + 4 <= tEnd) trackId = view.getUint32(idOff, false);
      } else if (tType === 'tref') {
        iterateMp4Children(moovBytes, tStart, tEnd, (rType, rStart, rEnd) => {
          if (rType === 'chap') {
            for (let off = rStart; off + 4 <= rEnd; off += 4) {
              chapterTrackIds.add(view.getUint32(off, false));
            }
          }
        });
      } else if (tType === 'edts') {
        iterateMp4Children(moovBytes, tStart, tEnd, (eType, eStart, eEnd) => {
          if (eType === 'elst' && eStart + 8 <= eEnd) {
            const ev = moovBytes[eStart];
            const count = view.getUint32(eStart + 4, false);
            if (count >= 1) {
              if (ev === 0 && eStart + 20 <= eEnd) {
                const segDur = view.getUint32(eStart + 8, false);
                const mediaTime = view.getInt32(eStart + 12, false);
                if (mediaTime === -1) emptyDelay = segDur;
              } else if (ev === 1 && eStart + 28 <= eEnd) {
                const segDur =
                  view.getUint32(eStart + 8, false) * 4294967296 +
                  view.getUint32(eStart + 12, false);
                const mediaTime = view.getInt32(eStart + 16, false);
                if (mediaTime === -1) emptyDelay = segDur;
              }
            }
          }
        });
      } else if (tType === 'mdia') {
        iterateMp4Children(moovBytes, tStart, tEnd, (mType, mStart, mEnd) => {
          if (mType === 'mdhd' && mStart + 20 <= mEnd) {
            const mv = moovBytes[mStart];
            mdhdTs = view.getUint32(mStart + (mv === 1 ? 20 : 12), false) || 1000;
          } else if (mType === 'hdlr' && mStart + 12 <= mEnd) {
            handler = readAscii(moovBytes, mStart + 8, 4);
          } else if (mType === 'minf') {
            iterateMp4Children(moovBytes, mStart, mEnd, (miType, miStart, miEnd) => {
              if (miType !== 'stbl') return;
              iterateMp4Children(moovBytes, miStart, miEnd, (sbType, sbStart, sbEnd) => {
                if (sbType === 'stsd' && sbStart + 16 <= sbEnd) {
                  fourcc = readAscii(moovBytes, sbStart + 12, 4);
                } else if (sbType === 'stts') {
                  sttsBytes = moovBytes.subarray(sbStart, sbEnd);
                } else if (sbType === 'stsc') {
                  stscBytes = moovBytes.subarray(sbStart, sbEnd);
                } else if (sbType === 'stsz') {
                  stszBytes = moovBytes.subarray(sbStart, sbEnd);
                } else if (sbType === 'stco') {
                  stcoBytes = moovBytes.subarray(sbStart, sbEnd);
                  isCo64 = false;
                } else if (sbType === 'co64') {
                  stcoBytes = moovBytes.subarray(sbStart, sbEnd);
                  isCo64 = true;
                }
              });
            });
          }
        });
      }
    });

    if (handler === 'sbtl' || handler === 'text' || handler === 'subp') {
      candidateTraks.push({
        trackId,
        handler,
        fourcc,
        mdhdTs,
        emptyDelay,
        sttsBytes,
        stscBytes,
        stszBytes,
        stcoBytes,
        isCo64,
      });
    }
  });

  let subIdx = -1;
  let target: RawSubTrak | null = null;
  for (let i = 0; i < candidateTraks.length; i++) {
    if (chapterTrackIds.has(candidateTraks[i].trackId)) continue;
    subIdx++;
    if (subIdx === subtitleTrackIndex) {
      target = candidateTraks[i];
      break;
    }
  }

  if (!target) return null;
  if (target.fourcc !== 'tx3g' && target.fourcc !== 'wvtt' && target.fourcc !== 'text') {
    return null;
  }

  const initialDtsTicks = Math.round((target.emptyDelay / mvhdTimescale) * target.mdhdTs);
  const table = buildMp4SampleTable(
    target.sttsBytes,
    target.stscBytes,
    target.stszBytes,
    target.stcoBytes,
    target.isCo64,
    initialDtsTicks,
    0
  );
  if (!table) return null;

  const totalSamples = table.sizes.length;
  const cues: ExtractedSubtitleCue[] = [];
  let i = 0;

  while (i < totalSamples) {
    if (table.sizes[i] === 0) {
      i++;
      continue;
    }
    const spanStart = table.offsets[i];
    let spanEnd = spanStart + table.sizes[i];
    let j = i + 1;
    while (j < totalSamples) {
      if (table.sizes[j] === 0) {
        j++;
        continue;
      }
      const nextStart = table.offsets[j];
      const nextEnd = nextStart + table.sizes[j];
      if (nextStart >= spanStart && nextStart - spanEnd <= 65536 && nextEnd - spanStart <= 2 * 1024 * 1024) {
        if (nextEnd > spanEnd) spanEnd = nextEnd;
        j++;
      } else {
        break;
      }
    }

    const buf = await reader.read(spanStart, spanEnd - spanStart);
    for (let k = i; k < j; k++) {
      const sz = table.sizes[k];
      const rel = table.offsets[k] - spanStart;
      if (sz <= 0 || rel < 0 || rel + sz > buf.length) continue;

      const startSec = table.dts[k] / target.mdhdTs;
      const durSec = table.durations[k] / target.mdhdTs;
      const endSec = durSec > 0 ? startSec + durSec : startSec + 3.0;
      const sampleBytes = buf.subarray(rel, rel + sz);

      if (target.fourcc === 'wvtt') {
        iterateMp4Children(sampleBytes, 0, sampleBytes.length, (boxType, bStart, bEnd) => {
          if (boxType !== 'vttc') return;
          iterateMp4Children(sampleBytes, bStart, bEnd, (innerType, iStart, iEnd) => {
            if (innerType === 'payl' && iEnd > iStart) {
              const raw = decodeUtf8Bytes(sampleBytes.subarray(iStart, iEnd));
              const cleaned = cleanSubtitleText(raw, 'S_TEXT/WEBVTT');
              if (cleaned) {
                cues.push({ start: startSec, end: endSec, text: cleaned });
              }
            }
          });
        });
      } else {
        // tx3g / QuickTime text: 2-byte unsigned big-endian text length followed by text
        if (sampleBytes.length >= 2) {
          const textLen = (sampleBytes[0] << 8) | sampleBytes[1];
          if (textLen > 0 && 2 + textLen <= sampleBytes.length) {
            const raw = decodeUtf8Bytes(sampleBytes.subarray(2, 2 + textLen));
            const cleaned = cleanSubtitleText(raw, target.fourcc);
            if (cleaned) {
              cues.push({ start: startSec, end: endSec, text: cleaned });
            }
          }
        }
      }
    }
    i = j;
  }

  const normalized = normalizeAndSortCues(cues);
  return {
    mode: 'complete',
    cues: normalized,
    vttText: cuesToWebVtt(normalized),
  };
}

// ============================================================================
// MKV Embedded Subtitle Extractor & Cues-Guided Streaming Controller
// ============================================================================

interface CoveredRange {
  startSec: number;
  endSec: number;
  endByteOffset: number;
  atEnd: boolean;
}

export class EmbeddedSubtitleController {
  private readonly reader: ByteReader;
  private readonly segmentEnd: number;
  private readonly timestampScaleNs: number;
  private readonly trackNumber: number;
  private readonly codecId: string;
  private readonly assCommaCount: number;
  private readonly defaultDurationSec: number;
  private readonly compAlgo: number;
  private readonly compHeader: Uint8Array;
  private readonly clusterRefs: { timeSec: number; absOffset: number }[];
  private readonly readClusterHeader: (
    absOffset: number
  ) => Promise<{ dataStart: number; endOffset: number; timeSec: number } | null>;
  private readonly findClusterStartOffset: (targetTimeSec: number) => Promise<number | null>;
  private readonly onCuesUpdated: (cues: ExtractedSubtitleCue[]) => void;

  private cues: ExtractedSubtitleCue[] = [];
  private cueKeys = new Set<string>();
  private coveredRanges: CoveredRange[] = [];
  private destroyed = false;
  private scanning = false;
  private generation = 0;

  constructor(params: {
    reader: ByteReader;
    segmentEnd: number;
    timestampScaleNs: number;
    trackNumber: number;
    codecId: string;
    assCommaCount: number;
    defaultDurationSec: number;
    compAlgo: number;
    compHeader: Uint8Array;
    clusterRefs: { timeSec: number; absOffset: number }[];
    readClusterHeader: (
      absOffset: number
    ) => Promise<{ dataStart: number; endOffset: number; timeSec: number } | null>;
    findClusterStartOffset: (targetTimeSec: number) => Promise<number | null>;
    onCuesUpdated: (cues: ExtractedSubtitleCue[]) => void;
  }) {
    this.reader = params.reader;
    this.segmentEnd = params.segmentEnd;
    this.timestampScaleNs = params.timestampScaleNs;
    this.trackNumber = params.trackNumber;
    this.codecId = params.codecId;
    this.assCommaCount = params.assCommaCount;
    this.defaultDurationSec = params.defaultDurationSec;
    this.compAlgo = params.compAlgo;
    this.compHeader = params.compHeader;
    this.clusterRefs = params.clusterRefs;
    this.readClusterHeader = params.readClusterHeader;
    this.findClusterStartOffset = params.findClusterStartOffset;
    this.onCuesUpdated = params.onCuesUpdated;
  }

  public getCues(): ExtractedSubtitleCue[] {
    return this.cues;
  }

  private findCoveredRangeAt(timeSec: number): CoveredRange | null {
    for (let i = 0; i < this.coveredRanges.length; i++) {
      const r = this.coveredRanges[i];
      if (timeSec >= r.startSec && timeSec <= r.endSec) {
        return r;
      }
    }
    return null;
  }

  private addCoveredRange(range: CoveredRange) {
    this.coveredRanges.push(range);
    this.coveredRanges.sort((a, b) => a.startSec - b.startSec);
    const merged: CoveredRange[] = [];
    for (let i = 0; i < this.coveredRanges.length; i++) {
      const cur = this.coveredRanges[i];
      if (merged.length === 0) {
        merged.push({ ...cur });
        continue;
      }
      const last = merged[merged.length - 1];
      if (cur.startSec <= last.endSec + 1.0) {
        last.endSec = Math.max(last.endSec, cur.endSec);
        if (cur.endByteOffset > last.endByteOffset) {
          last.endByteOffset = cur.endByteOffset;
          last.atEnd = cur.atEnd;
        } else {
          last.atEnd = last.atEnd || cur.atEnd;
        }
      } else {
        merged.push({ ...cur });
      }
    }
    this.coveredRanges = merged;
  }

  private async decodeAndAddCue(
    rawFrame: Uint8Array,
    startSec: number,
    endSec: number
  ): Promise<boolean> {
    const decompressed = await decompressBlockBytes(rawFrame, this.compAlgo, this.compHeader);
    const rawStr = decodeUtf8Bytes(decompressed);
    const cleaned = cleanSubtitleText(rawStr, this.codecId, this.assCommaCount);
    if (!cleaned) return false;

    const safeStart = Math.max(0, startSec);
    const safeEnd = endSec > safeStart ? endSec : safeStart + 2.5;
    const key = `${Math.round(safeStart * 1000)}|${Math.round(safeEnd * 1000)}|${cleaned}`;
    if (this.cueKeys.has(key)) return false;

    this.cueKeys.add(key);
    this.cues.push({ start: safeStart, end: safeEnd, text: cleaned });
    return true;
  }

  private async scanFromClusterOffset(
    startOffset: number,
    targetTimeSec: number,
    minEndSec: number,
    gen: number
  ): Promise<boolean> {
    const tickToSec = this.timestampScaleNs / 1000000000;
    let clusterOff = startOffset;
    let firstWindowStartSec: number | null = null;
    let maxWindowEndSec = targetTimeSec;
    let bytesScanned = 0;
    let clustersRead = 0;
    let atEnd = false;
    let addedAny = false;

    while (clusterOff < this.segmentEnd && clustersRead < 128) {
      if (this.destroyed || gen !== this.generation) return false;
      clustersRead++;

      const hdr = await this.readClusterHeader(clusterOff);
      if (!hdr || hdr.endOffset <= clusterOff) {
        atEnd = true;
        break;
      }

      if (firstWindowStartSec === null) {
        firstWindowStartSec = hdr.timeSec;
      }
      if (hdr.timeSec > maxWindowEndSec) {
        maxWindowEndSec = hdr.timeSec;
      }

      const clusterSize = hdr.endOffset - hdr.dataStart;
      if (clusterSize > 36 * 1024 * 1024) {
        clusterOff = hdr.endOffset;
        continue;
      }

      const cBuf = await this.reader.read(hdr.dataStart, clusterSize);
      if (this.destroyed || gen !== this.generation) return false;
      bytesScanned += clusterSize;

      let clusterTimeTicks = Math.round(hdr.timeSec / tickToSec);
      let cp = 0;
      while (cp < cBuf.length) {
        const eid = readEbmlId(cBuf, cp, cBuf.length);
        if (!eid) break;
        const esz = readEbmlSize(cBuf, eid.nextPos, cBuf.length);
        if (!esz || esz.size < 0) break;
        const bStart = esz.nextPos;
        const bEnd = Math.min(cBuf.length, bStart + esz.size);

        if (eid.id === 0xe7) {
          clusterTimeTicks = readEbmlUint(cBuf, bStart, bEnd - bStart);
        } else if (eid.id === 0xa3) {
          const slice = unpackMkvBlockFrames(cBuf, bStart, bEnd, this.trackNumber);
          if (slice && slice.frames.length > 0) {
            const cueStart = Math.max(0, (clusterTimeTicks + slice.relTimeMs) * tickToSec);
            const cueDur = this.defaultDurationSec > 0 ? this.defaultDurationSec : 4.0;
            const cueEnd = cueStart + cueDur;
            if (cueEnd > maxWindowEndSec) maxWindowEndSec = cueEnd;
            for (let fi = 0; fi < slice.frames.length; fi++) {
              if (await this.decodeAndAddCue(slice.frames[fi], cueStart, cueEnd)) {
                addedAny = true;
              }
            }
          }
        } else if (eid.id === 0xa0) {
          // BlockGroup: Block (0xA1) and BlockDuration (0x9B) may appear in either order
          let blockSlice: { relTimeMs: number; frames: Uint8Array[] } | null = null;
          let blockDurTicks: number | null = null;
          let bp = bStart;
          while (bp < bEnd) {
            const bid = readEbmlId(cBuf, bp, bEnd);
            if (!bid) break;
            const bsz = readEbmlSize(cBuf, bid.nextPos, bEnd);
            if (!bsz || bsz.size < 0) break;
            const bvStart = bsz.nextPos;
            const bvEnd = Math.min(bEnd, bvStart + bsz.size);
            if (bid.id === 0xa1) {
              blockSlice = unpackMkvBlockFrames(cBuf, bvStart, bvEnd, this.trackNumber);
            } else if (bid.id === 0x9b) {
              blockDurTicks = readEbmlUint(cBuf, bvStart, bvEnd - bvStart);
            }
            bp = bvEnd;
          }

          if (blockSlice && blockSlice.frames.length > 0) {
            const cueStart = Math.max(0, (clusterTimeTicks + blockSlice.relTimeMs) * tickToSec);
            const cueDur =
              blockDurTicks !== null && blockDurTicks > 0
                ? blockDurTicks * tickToSec
                : this.defaultDurationSec > 0
                  ? this.defaultDurationSec
                  : 4.0;
            const cueEnd = cueStart + cueDur;
            if (cueEnd > maxWindowEndSec) maxWindowEndSec = cueEnd;
            for (let fi = 0; fi < blockSlice.frames.length; fi++) {
              if (await this.decodeAndAddCue(blockSlice.frames[fi], cueStart, cueEnd)) {
                addedAny = true;
              }
            }
          }
        }

        cp = bEnd;
      }

      clusterOff = hdr.endOffset;
      if (clusterOff >= this.segmentEnd) {
        atEnd = true;
        break;
      }

      // Always cover at least up to targetTimeSec; once past targetTimeSec + 5s, respect byte budget
      if (hdr.timeSec >= minEndSec) {
        break;
      }
      if (hdr.timeSec > targetTimeSec + 5 && bytesScanned >= 20 * 1024 * 1024) {
        break;
      }
      if (bytesScanned >= 48 * 1024 * 1024) {
        break;
      }
    }

    if (firstWindowStartSec !== null) {
      const clampedStart = firstWindowStartSec <= 2 ? 0 : Math.min(firstWindowStartSec, targetTimeSec);
      this.addCoveredRange({
        startSec: clampedStart,
        endSec: Math.max(maxWindowEndSec, clampedStart + 1),
        endByteOffset: clusterOff,
        atEnd,
      });
    }

    if (addedAny) {
      this.cues.sort((a, b) => a.start - b.start || a.end - b.end);
      if (!this.destroyed) {
        this.onCuesUpdated(this.cues.slice());
      }
    }

    return true;
  }

  private resolveLookbackClusterOffset(mainOff: number, lookbackSec: number): number {
    if (this.clusterRefs.length === 0) return mainOff;
    let idx = 0;
    for (let i = 0; i < this.clusterRefs.length; i++) {
      if (this.clusterRefs[i].absOffset <= mainOff) idx = i;
      else break;
    }
    const baseTime = this.clusterRefs[idx].timeSec;
    while (
      idx > 0 &&
      baseTime - this.clusterRefs[idx - 1].timeSec <= lookbackSec &&
      mainOff - this.clusterRefs[idx - 1].absOffset <= 8 * 1024 * 1024
    ) {
      idx--;
    }
    return this.clusterRefs[idx].absOffset;
  }

  public async seekTo(timeSec: number): Promise<void> {
    if (this.destroyed) return;
    if (this.findCoveredRangeAt(timeSec)) return;

    const myGen = ++this.generation;
    while (this.scanning) {
      await new Promise((r) => setTimeout(r, 20));
      if (this.destroyed || myGen !== this.generation) return;
    }

    this.scanning = true;
    try {
      const mainOff = await this.findClusterStartOffset(Math.max(0, timeSec));
      if (mainOff === null || this.destroyed || myGen !== this.generation) return;
      const startOff = this.resolveLookbackClusterOffset(mainOff, 4);
      await this.scanFromClusterOffset(startOff, timeSec, timeSec + 45, myGen);
    } finally {
      this.scanning = false;
    }
  }

  public async ensureBufferedAt(timeSec: number): Promise<void> {
    if (this.destroyed || this.scanning) return;
    const covered = this.findCoveredRangeAt(timeSec);
    if (!covered) {
      await this.seekTo(timeSec);
      return;
    }

    if (covered.atEnd || covered.endSec - timeSec >= 15) {
      return;
    }

    const myGen = this.generation;
    this.scanning = true;
    try {
      await this.scanFromClusterOffset(
        covered.endByteOffset,
        covered.endSec,
        covered.endSec + 45,
        myGen
      );
    } finally {
      this.scanning = false;
    }
  }

  public async scanAllFrom(startOffset: number): Promise<void> {
    if (this.destroyed) return;
    this.scanning = true;
    const myGen = ++this.generation;
    try {
      let nextOff = startOffset;
      for (let pass = 0; pass < 64 && !this.destroyed && myGen === this.generation; pass++) {
        const hdr = await this.readClusterHeader(nextOff);
        if (!hdr || hdr.endOffset <= nextOff) break;
        const ok = await this.scanFromClusterOffset(nextOff, hdr.timeSec, Number.MAX_SAFE_INTEGER, myGen);
        if (!ok || this.coveredRanges.length === 0) break;
        const last = this.coveredRanges[this.coveredRanges.length - 1];
        if (last.atEnd || last.endByteOffset <= nextOff) break;
        nextOff = last.endByteOffset;
      }
    } finally {
      this.scanning = false;
    }
  }

  public destroy() {
    this.destroyed = true;
    this.generation++;
  }
}

async function openMkvSubtitleSource(
  reader: ByteReader,
  subtitleTrackIndex: number,
  onCuesUpdated: (cues: ExtractedSubtitleCue[]) => void
): Promise<EmbeddedSubtitleOpenResult | null> {
  const ctx = await openMkvContainerContext(reader);
  if (!ctx) return null;

  const { tracksBuf, segmentEnd, timestampScaleNs, clusterRefs, firstClusterAbsOffset, readClusterHeader, findClusterStartOffset } = ctx;

  let currentSubIdx = -1;
  let trackNumber = 0;
  let codecId = '';
  let codecPrivate = new Uint8Array(0);
  let defaultDurationNs = 0;
  let compAlgo = -1;
  let compHeader = new Uint8Array(0);

  let tp = 0;
  while (tp < tracksBuf.length) {
    const id = readEbmlId(tracksBuf, tp, tracksBuf.length);
    if (!id) break;
    const sz = readEbmlSize(tracksBuf, id.nextPos, tracksBuf.length);
    if (!sz || sz.size < 0) break;
    const eStart = sz.nextPos;
    const eEnd = Math.min(tracksBuf.length, eStart + sz.size);

    if (id.id === 0xae) {
      let tType = 0;
      let tNum = 0;
      let cId = '';
      let cPriv = new Uint8Array(0);
      let dDur = 0;
      let cAlgo = -1;
      let cHdr = new Uint8Array(0);

      let fp = eStart;
      while (fp < eEnd) {
        const fi = readEbmlId(tracksBuf, fp, eEnd);
        if (!fi) break;
        const fs = readEbmlSize(tracksBuf, fi.nextPos, eEnd);
        if (!fs || fs.size < 0) break;
        const vs = fs.nextPos;
        const ve = Math.min(eEnd, vs + fs.size);
        const vl = ve - vs;

        if (fi.id === 0x83) tType = readEbmlUint(tracksBuf, vs, vl);
        else if (fi.id === 0xd7) tNum = readEbmlUint(tracksBuf, vs, vl);
        else if (fi.id === 0x86) cId = readAscii(tracksBuf, vs, vl).replace(/\0+$/, '').trim();
        else if (fi.id === 0x63a2) cPriv = tracksBuf.slice(vs, ve);
        else if (fi.id === 0x23e383) dDur = readEbmlUint(tracksBuf, vs, vl);
        else if (fi.id === 0x6d80) {
          // ContentEncodings -> ContentEncoding -> ContentCompression
          let ep = vs;
          while (ep < ve) {
            const ei = readEbmlId(tracksBuf, ep, ve);
            if (!ei) break;
            const esz = readEbmlSize(tracksBuf, ei.nextPos, ve);
            if (!esz || esz.size < 0) break;
            const evs = esz.nextPos;
            const eve = Math.min(ve, evs + esz.size);
            if (ei.id === 0x6240) {
              let cep = evs;
              while (cep < eve) {
                const cei = readEbmlId(tracksBuf, cep, eve);
                if (!cei) break;
                const cesz = readEbmlSize(tracksBuf, cei.nextPos, eve);
                if (!cesz || cesz.size < 0) break;
                const cevs = cesz.nextPos;
                const ceve = Math.min(eve, cevs + cesz.size);
                if (cei.id === 0x5034) {
                  let cp = cevs;
                  while (cp < ceve) {
                    const ci = readEbmlId(tracksBuf, cp, ceve);
                    if (!ci) break;
                    const csz = readEbmlSize(tracksBuf, ci.nextPos, ceve);
                    if (!csz || csz.size < 0) break;
                    const cvs = csz.nextPos;
                    const cve = Math.min(ceve, cvs + csz.size);
                    if (ci.id === 0x4254) cAlgo = readEbmlUint(tracksBuf, cvs, cve - cvs);
                    else if (ci.id === 0x4255) cHdr = tracksBuf.slice(cvs, cve);
                    cp = cve;
                  }
                }
                cep = ceve;
              }
            }
            ep = eve;
          }
        }
        fp = ve;
      }

      if (tType === 17) {
        currentSubIdx++;
        if (currentSubIdx === subtitleTrackIndex) {
          trackNumber = tNum;
          codecId = cId;
          codecPrivate = cPriv;
          defaultDurationNs = dDur;
          compAlgo = cAlgo;
          compHeader = cHdr;
          break;
        }
      }
    }
    tp = eEnd;
  }

  if (!trackNumber || codecId.indexOf('S_TEXT/') !== 0) {
    return null;
  }

  const assCommaCount = parseAssCommaCount(codecPrivate);
  const controller = new EmbeddedSubtitleController({
    reader,
    segmentEnd,
    timestampScaleNs,
    trackNumber,
    codecId,
    assCommaCount,
    defaultDurationSec: defaultDurationNs > 0 ? defaultDurationNs / 1e9 : 0,
    compAlgo,
    compHeader,
    clusterRefs,
    readClusterHeader,
    findClusterStartOffset,
    onCuesUpdated,
  });

  // For compact MKVs (<= 40 MB), extract all cues eagerly in one pass so .vtt download & sync work immediately
  if (reader.size <= 40 * 1024 * 1024 && firstClusterAbsOffset !== null) {
    await controller.scanAllFrom(firstClusterAbsOffset);
    const fullCues = normalizeAndSortCues(controller.getCues());
    controller.destroy();
    return {
      mode: 'complete',
      cues: fullCues,
      vttText: cuesToWebVtt(fullCues),
    };
  }

  return {
    mode: 'streaming',
    controller,
  };
}

export async function openEmbeddedSubtitleSource(
  sourceInput: { file?: File | null; url?: string | null },
  containerType: 'mp4' | 'mkv' | undefined,
  subtitleTrackIndex: number,
  onCuesUpdated: (cues: ExtractedSubtitleCue[]) => void
): Promise<EmbeddedSubtitleOpenResult | null> {
  let reader: ByteReader | null = null;
  if (sourceInput.file) {
    reader = createFileByteReader(sourceInput.file);
  } else if (sourceInput.url) {
    reader = await createRangeByteReader(sourceInput.url);
  }
  if (!reader) return null;

  if (containerType === 'mp4') {
    return extractMp4Subtitles(reader, subtitleTrackIndex);
  }
  if (containerType === 'mkv') {
    return openMkvSubtitleSource(reader, subtitleTrackIndex, onCuesUpdated);
  }
  return null;
}
