import {
  ByteReader,
  checkMseMimeSupported,
  createFileByteReader,
  createRangeByteReader,
  iterateMp4Children,
  readAscii,
  readEbmlId,
  readEbmlSize,
  readEbmlUint,
} from './audioTracks';

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    total += parts[i].length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

function makeBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  let bodyLen = 0;
  for (let i = 0; i < parts.length; i++) {
    bodyLen += parts[i].length;
  }
  const out = new Uint8Array(8 + bodyLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  let offset = 8;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

function makeFullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  const vf = new Uint8Array(4);
  vf[0] = version & 0xff;
  vf[1] = (flags >> 16) & 0xff;
  vf[2] = (flags >> 8) & 0xff;
  vf[3] = flags & 0xff;
  return makeBox(type, vf, ...parts);
}

function writeUint64BE(view: DataView, offset: number, val: number) {
  const hi = Math.floor(val / 4294967296);
  const lo = val >>> 0;
  view.setUint32(offset, hi, false);
  view.setUint32(offset + 4, lo, false);
}

function encodeIsoDescLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  if (len < 16384) return new Uint8Array([0x80 | (len >> 7), len & 0x7f]);
  return new Uint8Array([0x80 | (len >> 14), 0x80 | ((len >> 7) & 0x7f), len & 0x7f]);
}

function makeIsoDescriptor(tag: number, payload: Uint8Array): Uint8Array {
  const lenBytes = encodeIsoDescLength(payload.length);
  const out = new Uint8Array(1 + lenBytes.length + payload.length);
  out[0] = tag & 0xff;
  out.set(lenBytes, 1);
  out.set(payload, 1 + lenBytes.length);
  return out;
}

function buildEsdsBox(asc: Uint8Array, objectTypeIndication = 0x40): Uint8Array {
  const dsi = asc.length > 0 ? makeIsoDescriptor(0x05, asc) : new Uint8Array(0);
  const dcdBody = new Uint8Array(13 + dsi.length);
  const dcdView = new DataView(dcdBody.buffer);
  dcdBody[0] = objectTypeIndication;
  dcdBody[1] = 0x15; // streamType = 5 (Audio), upstream = 0, reserved = 1
  // bufferSizeDB = 0 (3 bytes)
  dcdView.setUint32(5, 128000, false); // maxBitrate
  dcdView.setUint32(9, 128000, false); // avgBitrate
  if (dsi.length > 0) {
    dcdBody.set(dsi, 13);
  }
  const dcd = makeIsoDescriptor(0x04, dcdBody);
  const sl = makeIsoDescriptor(0x06, new Uint8Array([0x02]));

  const esBody = new Uint8Array(3 + dcd.length + sl.length);
  esBody[0] = 0x00;
  esBody[1] = 0x01; // ES_ID = 1
  esBody[2] = 0x00;
  esBody.set(dcd, 3);
  esBody.set(sl, 3 + dcd.length);
  const esDesc = makeIsoDescriptor(0x03, esBody);

  return makeFullBox('esds', 0, 0, esDesc);
}

function buildAudioSampleEntry(
  fourcc: string,
  channels: number,
  sampleRate: number,
  extraBoxes: Uint8Array[]
): Uint8Array {
  const header = new Uint8Array(28);
  const view = new DataView(header.buffer);
  view.setUint16(6, 1, false); // data_reference_index = 1
  view.setUint16(16, channels || 2, false);
  view.setUint16(18, 16, false); // sampleSize = 16
  view.setUint16(24, Math.round(sampleRate) || 48000, false); // 16.16 fixed-point integer part
  return makeBox(fourcc, header, ...extraBoxes);
}

function synthesizeAacAsc(sampleRate: number, channels: number): Uint8Array {
  let freqIdx = AAC_SAMPLE_RATES.indexOf(Math.round(sampleRate));
  if (freqIdx === -1) freqIdx = 3; // 48000 Hz fallback
  const aot = 2; // AAC-LC
  const ch = Math.max(1, Math.min(7, channels || 2));
  const b0 = (aot << 3) | (freqIdx >> 1);
  const b1 = ((freqIdx & 1) << 7) | (ch << 3);
  return new Uint8Array([b0, b1]);
}

function parseAscInfo(asc: Uint8Array): { aot: number; coreSampleRate: number } {
  if (asc.length < 2) return { aot: 2, coreSampleRate: 48000 };
  const aot = asc[0] >> 3;
  const freqIdx = ((asc[0] & 0x07) << 1) | (asc[1] >> 7);
  if (freqIdx === 15 && asc.length >= 5) {
    const rate =
      ((asc[1] & 0x7f) << 17) |
      (asc[2] << 9) |
      (asc[3] << 1) |
      (asc[4] >> 7);
    return { aot, coreSampleRate: rate || 48000 };
  }
  const coreSampleRate =
    freqIdx >= 0 && freqIdx < AAC_SAMPLE_RATES.length
      ? AAC_SAMPLE_RATES[freqIdx]
      : 48000;
  return { aot, coreSampleRate };
}

function readIsoDescLength(bytes: Uint8Array, pos: number, end: number): { length: number; nextPos: number } | null {
  let length = 0;
  let count = 0;
  let p = pos;
  while (p < end && count < 4) {
    const b = bytes[p++];
    length = (length << 7) | (b & 0x7f);
    count++;
    if ((b & 0x80) === 0) {
      return { length, nextPos: p };
    }
  }
  return null;
}

function parseEsdsBox(esdsPayload: Uint8Array): { oti: number; asc: Uint8Array } {
  let oti = 0x40;
  let asc = new Uint8Array(0);
  if (esdsPayload.length < 6) return { oti, asc };

  const scanDescriptor = (start: number, end: number) => {
    let pos = start;
    while (pos + 2 <= end) {
      const tag = esdsPayload[pos++];
      const lenInfo = readIsoDescLength(esdsPayload, pos, end);
      if (!lenInfo) break;
      const bodyStart = lenInfo.nextPos;
      const bodyEnd = Math.min(end, bodyStart + lenInfo.length);

      if (tag === 0x03 && bodyStart + 3 <= bodyEnd) {
        const flags = esdsPayload[bodyStart + 2];
        let subPos = bodyStart + 3;
        if (flags & 0x80) subPos += 2;
        if (flags & 0x40 && subPos < bodyEnd) subPos += 1 + esdsPayload[subPos];
        if (flags & 0x20) subPos += 2;
        scanDescriptor(subPos, bodyEnd);
      } else if (tag === 0x04 && bodyStart + 13 <= bodyEnd) {
        oti = esdsPayload[bodyStart];
        scanDescriptor(bodyStart + 13, bodyEnd);
      } else if (tag === 0x05) {
        asc = esdsPayload.slice(bodyStart, bodyEnd);
      }
      pos = bodyEnd;
    }
  };

  // Skip 4-byte version+flags
  scanDescriptor(4, esdsPayload.length);
  return { oti, asc };
}

function normalizeMp4SampleEntry(rawEntry: Uint8Array): { entry: Uint8Array; mime: string } {
  const fourcc = readAscii(rawEntry, 4, 4);
  const cloned = rawEntry.slice();
  const view = new DataView(cloned.buffer);

  if (fourcc === 'mp4a' && cloned.length >= 36) {
    const version = view.getUint16(16, false);
    const channels = view.getUint16(24, false) || 2;
    const sampleRate = view.getUint16(32, false) || 48000;

    let esdsPayload: Uint8Array | null = null;
    const childStart = version === 1 ? 52 : version === 2 ? 72 : 36;

    const findEsds = (start: number, end: number) => {
      iterateMp4Children(cloned, start, end, (type, pStart, pEnd) => {
        if (type === 'esds') {
          esdsPayload = cloned.slice(pStart, pEnd);
        } else if (type === 'wave' && !esdsPayload) {
          findEsds(pStart, pEnd);
        }
      });
    };

    if (childStart < cloned.length) {
      findEsds(childStart, cloned.length);
    }

    let mime = 'audio/mp4; codecs="mp4a.40.2"';
    if (esdsPayload) {
      const { oti, asc } = parseEsdsBox(esdsPayload);
      if (oti === 0x6b || oti === 0x69) {
        mime = 'audio/mp4; codecs="mp3"';
      } else if (asc.length >= 2) {
        const { aot } = parseAscInfo(asc);
        if (aot === 5 || aot === 29) {
          const heMime = 'audio/mp4; codecs="mp4a.40.5"';
          mime = checkMseMimeSupported(heMime) ? heMime : 'audio/mp4; codecs="mp4a.40.2"';
        }
      }
      if (version !== 0) {
        const rebuiltEsds = buildEsdsBox(asc, oti);
        return {
          entry: buildAudioSampleEntry('mp4a', channels, sampleRate, [rebuiltEsds]),
          mime,
        };
      }
    }

    view.setUint16(14, 1, false); // Ensure data_reference_index = 1
    return { entry: cloned, mime };
  }

  view.setUint16(14, 1, false);
  let mime = 'audio/mp4; codecs="mp4a.40.2"';
  if (fourcc === 'ac-3') mime = 'audio/mp4; codecs="ac-3"';
  else if (fourcc === 'ec-3') mime = 'audio/mp4; codecs="ec-3"';
  else if (fourcc === 'Opus') mime = 'audio/mp4; codecs="opus"';
  else if (fourcc === 'fLaC') mime = 'audio/mp4; codecs="flac"';
  else if (fourcc === '.mp3' || fourcc === 'mp3 ') mime = 'audio/mp4; codecs="mp3"';

  return { entry: cloned, mime };
}

function buildFmp4InitSegment(sampleEntry: Uint8Array, audioTimescale: number): Uint8Array {
  const ftypPayload = new Uint8Array([
    0x69, 0x73, 0x6f, 0x6d, // major_brand: isom
    0x00, 0x00, 0x02, 0x00, // minor_version: 512
    0x69, 0x73, 0x6f, 0x6d, // isom
    0x69, 0x73, 0x6f, 0x36, // iso6
    0x6d, 0x70, 0x34, 0x31, // mp41
  ]);
  const ftyp = makeBox('ftyp', ftypPayload);

  // mvhd (version 0, 96 bytes payload)
  const mvhdBody = new Uint8Array(96);
  const mvhdView = new DataView(mvhdBody.buffer);
  mvhdView.setUint32(8, 1000, false); // timescale = 1000
  mvhdView.setUint32(16, 0x00010000, false); // rate = 1.0
  mvhdView.setUint16(20, 0x0100, false); // volume = 1.0
  mvhdView.setUint32(32, 0x00010000, false);
  mvhdView.setUint32(48, 0x00010000, false);
  mvhdView.setUint32(64, 0x40000000, false);
  mvhdView.setUint32(92, 2, false); // next_track_id = 2
  const mvhd = makeFullBox('mvhd', 0, 0, mvhdBody);

  // tkhd (version 0, flags = 7, 80 bytes payload)
  const tkhdBody = new Uint8Array(80);
  const tkhdView = new DataView(tkhdBody.buffer);
  tkhdView.setUint32(8, 1, false); // track_id = 1
  tkhdView.setUint16(28, 0x0100, false); // audio volume = 1.0
  tkhdView.setUint32(36, 0x00010000, false);
  tkhdView.setUint32(52, 0x00010000, false);
  tkhdView.setUint32(68, 0x40000000, false);
  const tkhd = makeFullBox('tkhd', 0, 0x000007, tkhdBody);

  // mdhd (version 0, 20 bytes payload)
  const mdhdBody = new Uint8Array(20);
  const mdhdView = new DataView(mdhdBody.buffer);
  mdhdView.setUint32(8, audioTimescale, false);
  mdhdView.setUint16(16, 0x55c4, false); // 'und'
  const mdhd = makeFullBox('mdhd', 0, 0, mdhdBody);

  // hdlr
  const hdlrBody = new Uint8Array(21 + 13);
  hdlrBody[4] = 0x73; // 's'
  hdlrBody[5] = 0x6f; // 'o'
  hdlrBody[6] = 0x75; // 'u'
  hdlrBody[7] = 0x6e; // 'n'
  const hdlrName = 'SoundHandler\0';
  for (let i = 0; i < hdlrName.length; i++) {
    hdlrBody[20 + i] = hdlrName.charCodeAt(i);
  }
  const hdlr = makeFullBox('hdlr', 0, 0, hdlrBody);

  const smhd = makeFullBox('smhd', 0, 0, new Uint8Array(4));
  const urlBox = makeFullBox('url ', 0, 1);
  const drefBody = new Uint8Array(4);
  new DataView(drefBody.buffer).setUint32(0, 1, false);
  const dref = makeFullBox('dref', 0, 0, drefBody, urlBox);
  const dinf = makeBox('dinf', dref);

  const stsdCount = new Uint8Array(4);
  new DataView(stsdCount.buffer).setUint32(0, 1, false);
  const stsd = makeFullBox('stsd', 0, 0, stsdCount, sampleEntry);
  const stts = makeFullBox('stts', 0, 0, new Uint8Array(4));
  const stsc = makeFullBox('stsc', 0, 0, new Uint8Array(4));
  const stsz = makeFullBox('stsz', 0, 0, new Uint8Array(8));
  const stco = makeFullBox('stco', 0, 0, new Uint8Array(4));
  const stbl = makeBox('stbl', stsd, stts, stsc, stsz, stco);

  const minf = makeBox('minf', smhd, dinf, stbl);
  const mdia = makeBox('mdia', mdhd, hdlr, minf);
  const trak = makeBox('trak', tkhd, mdia);

  // mvex -> trex
  const trexBody = new Uint8Array(20);
  const trexView = new DataView(trexBody.buffer);
  trexView.setUint32(0, 1, false); // track_id = 1
  trexView.setUint32(4, 1, false); // default_sample_description_index = 1
  const trex = makeFullBox('trex', 0, 0, trexBody);
  const mvex = makeBox('mvex', trex);

  const moov = makeBox('moov', mvhd, trak, mvex);
  return concatBytes([ftyp, moov]);
}

interface MediaSample {
  duration: number;
  data: Uint8Array;
}

function buildFmp4MediaSegment(
  seqNumber: number,
  baseDecodeTime: number,
  samples: MediaSample[]
): Uint8Array {
  const mfhdBody = new Uint8Array(4);
  new DataView(mfhdBody.buffer).setUint32(0, seqNumber, false);
  const mfhd = makeFullBox('mfhd', 0, 0, mfhdBody);

  // tfhd: flags 0x020020 = default-base-is-moof | default-sample-flags-present
  const tfhdBody = new Uint8Array(8);
  const tfhdView = new DataView(tfhdBody.buffer);
  tfhdView.setUint32(0, 1, false); // track_id = 1
  tfhdView.setUint32(4, 0x02000000, false); // depends_on=2 (sync sample)
  const tfhd = makeFullBox('tfhd', 0, 0x020020, tfhdBody);

  // tfdt: version 1 (64-bit baseMediaDecodeTime)
  const tfdtBody = new Uint8Array(8);
  writeUint64BE(new DataView(tfdtBody.buffer), 0, Math.max(0, Math.round(baseDecodeTime)));
  const tfdt = makeFullBox('tfdt', 1, 0, tfdtBody);

  // trun: flags 0x000301 = data-offset-present | sample-duration-present | sample-size-present
  const trunBody = new Uint8Array(8 + samples.length * 8);
  const trunView = new DataView(trunBody.buffer);
  trunView.setUint32(0, samples.length, false);
  let totalDataBytes = 0;
  for (let i = 0; i < samples.length; i++) {
    const off = 8 + i * 8;
    trunView.setUint32(off, samples[i].duration, false);
    trunView.setUint32(off + 4, samples[i].data.length, false);
    totalDataBytes += samples[i].data.length;
  }
  const trun = makeFullBox('trun', 0, 0x000301, trunBody);

  const traf = makeBox('traf', tfhd, tfdt, trun);
  const moof = makeBox('moof', mfhd, traf);

  // Compute exact data_offset inside moof -> trun (moof[8] + mfhd[16] + traf[8] + tfhd[20] + tfdt[20] + trunHeader[16] = 88)
  const trunDataOffsetPos =
    8 + mfhd.length + 8 + tfhd.length + tfdt.length + 16;
  new DataView(moof.buffer).setInt32(trunDataOffsetPos, moof.length + 8, false);

  const mdatHeader = new Uint8Array(8);
  const mdatView = new DataView(mdatHeader.buffer);
  mdatView.setUint32(0, 8 + totalDataBytes, false);
  mdatHeader[4] = 0x6d; // m
  mdatHeader[5] = 0x64; // d
  mdatHeader[6] = 0x61; // a
  mdatHeader[7] = 0x74; // t

  const parts: Uint8Array[] = [moof, mdatHeader];
  for (let i = 0; i < samples.length; i++) {
    parts.push(samples[i].data);
  }
  return concatBytes(parts);
}

// ============================================================================
// Audio Chunk Provider Interface & MP4 / MKV Implementations
// ============================================================================

export interface ExtractedAudioBatch {
  baseDecodeTime: number;
  endTimeSec: number;
  samples: MediaSample[];
  atEnd: boolean;
}

export interface AudioTrackSource {
  mime: string;
  timescale: number;
  initSegment: Uint8Array;
  readBatchAt(startTimeSec: number, minDurationSec: number): Promise<ExtractedAudioBatch | null>;
}

export interface Mp4SampleTable {
  offsets: Float64Array;
  sizes: Uint32Array;
  dts: Float64Array;
  durations: Uint32Array;
}

export function buildMp4SampleTable(
  sttsBytes: Uint8Array | null,
  stscBytes: Uint8Array | null,
  stszBytes: Uint8Array | null,
  stcoBytes: Uint8Array | null,
  isCo64: boolean,
  initialDtsTicks: number,
  defaultDelta = 1024
): Mp4SampleTable | null {
  if (!sttsBytes || !stscBytes || !stszBytes || !stcoBytes) return null;

  const szView = new DataView(stszBytes.buffer, stszBytes.byteOffset, stszBytes.byteLength);
  if (stszBytes.length < 12) return null;
  const fixedSize = szView.getUint32(4, false);
  const sampleCount = szView.getUint32(8, false);
  if (sampleCount === 0) return null;

  const sizes = new Uint32Array(sampleCount);
  if (fixedSize > 0) {
    for (let i = 0; i < sampleCount; i++) sizes[i] = fixedSize;
  } else {
    if (stszBytes.length < 12 + sampleCount * 4) return null;
    for (let i = 0; i < sampleCount; i++) {
      sizes[i] = szView.getUint32(12 + i * 4, false);
    }
  }

  // stts -> dts & durations
  const durations = new Uint32Array(sampleCount);
  const dts = new Float64Array(sampleCount);
  const tsView = new DataView(sttsBytes.buffer, sttsBytes.byteOffset, sttsBytes.byteLength);
  const tsEntries = tsView.getUint32(4, false);
  let sIdx = 0;
  let runningDts = initialDtsTicks;
  for (let e = 0; e < tsEntries && 8 + e * 8 + 8 <= sttsBytes.length; e++) {
    const count = tsView.getUint32(8 + e * 8, false);
    const delta = tsView.getUint32(12 + e * 8, false);
    const effectiveDelta = delta || defaultDelta;
    for (let k = 0; k < count && sIdx < sampleCount; k++) {
      dts[sIdx] = runningDts;
      durations[sIdx] = effectiveDelta;
      runningDts += effectiveDelta;
      sIdx++;
    }
  }
  while (sIdx < sampleCount) {
    dts[sIdx] = runningDts;
    durations[sIdx] = defaultDelta;
    runningDts += defaultDelta;
    sIdx++;
  }

  // stco / co64 -> chunkOffsets
  const coView = new DataView(stcoBytes.buffer, stcoBytes.byteOffset, stcoBytes.byteLength);
  const chunkCount = coView.getUint32(4, false);
  const chunkOffsets = new Float64Array(chunkCount);
  if (isCo64) {
    for (let c = 0; c < chunkCount && 8 + c * 8 + 8 <= stcoBytes.length; c++) {
      const hi = coView.getUint32(8 + c * 8, false);
      const lo = coView.getUint32(12 + c * 8, false);
      chunkOffsets[c] = hi * 4294967296 + lo;
    }
  } else {
    for (let c = 0; c < chunkCount && 8 + c * 4 + 4 <= stcoBytes.length; c++) {
      chunkOffsets[c] = coView.getUint32(8 + c * 4, false);
    }
  }

  // stsc -> per-sample byte offsets
  const scView = new DataView(stscBytes.buffer, stscBytes.byteOffset, stscBytes.byteLength);
  const scCount = scView.getUint32(4, false);
  const offsets = new Float64Array(sampleCount);

  let sampleIdx = 0;
  for (let entryIdx = 0; entryIdx < scCount && sampleIdx < sampleCount; entryIdx++) {
    const firstChunk = scView.getUint32(8 + entryIdx * 12, false) - 1;
    const samplesPerChunk = scView.getUint32(12 + entryIdx * 12, false);
    const nextFirstChunk =
      entryIdx + 1 < scCount
        ? scView.getUint32(8 + (entryIdx + 1) * 12, false) - 1
        : chunkCount;

    for (let chunk = firstChunk; chunk < nextFirstChunk && chunk < chunkCount && sampleIdx < sampleCount; chunk++) {
      let bytePos = chunkOffsets[chunk];
      for (let k = 0; k < samplesPerChunk && sampleIdx < sampleCount; k++) {
        offsets[sampleIdx] = bytePos;
        bytePos += sizes[sampleIdx];
        sampleIdx++;
      }
    }
  }

  return { offsets, sizes, dts, durations };
}

export function binarySearchDts(dts: Float64Array, targetTicks: number): number {
  let lo = 0;
  let hi = dts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dts[mid] <= targetTicks) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export async function readMp4MoovBox(reader: ByteReader): Promise<Uint8Array | null> {
  let offset = 0;
  let iterations = 0;

  while (offset + 8 <= reader.size && iterations < 64) {
    iterations++;
    const header = await reader.read(offset, Math.min(16, reader.size - offset));
    if (header.length < 8) break;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const size32 = view.getUint32(0, false);
    const type = readAscii(header, 4, 4);
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (header.length < 16) break;
      boxSize = view.getUint32(8, false) * 4294967296 + view.getUint32(12, false);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = reader.size - offset;
    }
    if (boxSize < headerSize || offset + boxSize > reader.size) break;
    if (type === 'moov') {
      const payloadSize = boxSize - headerSize;
      if (payloadSize <= 0 || payloadSize > 64 * 1024 * 1024) return null;
      return reader.read(offset + headerSize, payloadSize);
    }
    offset += boxSize;
  }

  return null;
}

async function openMp4AudioSource(
  reader: ByteReader,
  audioTrackIndex: number
): Promise<AudioTrackSource | null> {
  const moovBytes = await readMp4MoovBox(reader);
  if (!moovBytes) return null;

  let mvhdTimescale = 1000;
  let currentAudioIdx = -1;
  let targetTimescale = 48000;
  let targetSampleEntryRaw: Uint8Array | null = null;
  let sttsBytes: Uint8Array | null = null;
  let stscBytes: Uint8Array | null = null;
  let stszBytes: Uint8Array | null = null;
  let stcoBytes: Uint8Array | null = null;
  let isCo64 = false;
  let emptyEditDelayMvhd = 0;

  iterateMp4Children(moovBytes, 0, moovBytes.length, (type, pStart, pEnd) => {
    if (type === 'mvhd' && pStart + 20 <= pEnd) {
      const v = moovBytes![pStart];
      const dv = new DataView(moovBytes!.buffer, moovBytes!.byteOffset + pStart, pEnd - pStart);
      mvhdTimescale = dv.getUint32(v === 1 ? 20 : 12, false) || 1000;
    } else if (type === 'trak') {
      let handler = '';
      let mdhdTs = 48000;
      let sEntry: Uint8Array | null = null;
      let tsB: Uint8Array | null = null;
      let scB: Uint8Array | null = null;
      let szB: Uint8Array | null = null;
      let coB: Uint8Array | null = null;
      let co64 = false;
      let emptyDelay = 0;

      iterateMp4Children(moovBytes!, pStart, pEnd, (tType, tStart, tEnd) => {
        if (tType === 'edts') {
          iterateMp4Children(moovBytes!, tStart, tEnd, (eType, eStart, eEnd) => {
            if (eType === 'elst' && eStart + 8 <= eEnd) {
              const ev = moovBytes![eStart];
              const dv = new DataView(moovBytes!.buffer, moovBytes!.byteOffset + eStart, eEnd - eStart);
              const count = dv.getUint32(4, false);
              if (count >= 1) {
                if (ev === 0 && eStart + 20 <= eEnd) {
                  const segDur = dv.getUint32(8, false);
                  const mediaTime = dv.getInt32(12, false);
                  if (mediaTime === -1) emptyDelay = segDur;
                } else if (ev === 1 && eStart + 28 <= eEnd) {
                  const segDur = dv.getUint32(8, false) * 4294967296 + dv.getUint32(12, false);
                  const mediaTime = dv.getInt32(16, false);
                  if (mediaTime === -1) emptyDelay = segDur;
                }
              }
            }
          });
        } else if (tType === 'mdia') {
          iterateMp4Children(moovBytes!, tStart, tEnd, (mType, mStart, mEnd) => {
            if (mType === 'mdhd' && mStart + 20 <= mEnd) {
              const mv = moovBytes![mStart];
              const dv = new DataView(moovBytes!.buffer, moovBytes!.byteOffset + mStart, mEnd - mStart);
              mdhdTs = dv.getUint32(mv === 1 ? 20 : 12, false) || 48000;
            } else if (mType === 'hdlr' && mStart + 12 <= mEnd) {
              handler = readAscii(moovBytes!, mStart + 8, 4);
            } else if (mType === 'minf') {
              iterateMp4Children(moovBytes!, mStart, mEnd, (miType, miStart, miEnd) => {
                if (miType !== 'stbl') return;
                iterateMp4Children(moovBytes!, miStart, miEnd, (sbType, sbStart, sbEnd) => {
                  if (sbType === 'stsd' && sbStart + 16 <= sbEnd) {
                    const entrySize = new DataView(
                      moovBytes!.buffer,
                      moovBytes!.byteOffset + sbStart + 8,
                      4
                    ).getUint32(0, false);
                    if (sbStart + 8 + entrySize <= sbEnd) {
                      sEntry = moovBytes!.slice(sbStart + 8, sbStart + 8 + entrySize);
                    }
                  } else if (sbType === 'stts') {
                    tsB = moovBytes!.subarray(sbStart, sbEnd);
                  } else if (sbType === 'stsc') {
                    scB = moovBytes!.subarray(sbStart, sbEnd);
                  } else if (sbType === 'stsz') {
                    szB = moovBytes!.subarray(sbStart, sbEnd);
                  } else if (sbType === 'stco') {
                    coB = moovBytes!.subarray(sbStart, sbEnd);
                    co64 = false;
                  } else if (sbType === 'co64') {
                    coB = moovBytes!.subarray(sbStart, sbEnd);
                    co64 = true;
                  }
                });
              });
            }
          });
        }
      });

      if (handler === 'soun') {
        currentAudioIdx++;
        if (currentAudioIdx === audioTrackIndex) {
          targetTimescale = mdhdTs;
          targetSampleEntryRaw = sEntry;
          sttsBytes = tsB;
          stscBytes = scB;
          stszBytes = szB;
          stcoBytes = coB;
          isCo64 = co64;
          emptyEditDelayMvhd = emptyDelay;
        }
      }
    }
  });

  if (!targetSampleEntryRaw) return null;
  const { entry, mime } = normalizeMp4SampleEntry(targetSampleEntryRaw);
  if (!checkMseMimeSupported(mime)) return null;

  const initialDtsTicks = Math.round((emptyEditDelayMvhd / mvhdTimescale) * targetTimescale);
  const table = buildMp4SampleTable(
    sttsBytes,
    stscBytes,
    stszBytes,
    stcoBytes,
    isCo64,
    initialDtsTicks
  );
  if (!table) return null;

  const initSegment = buildFmp4InitSegment(entry, targetTimescale);
  const totalSamples = table.sizes.length;

  return {
    mime,
    timescale: targetTimescale,
    initSegment,
    async readBatchAt(startTimeSec: number, minDurationSec: number): Promise<ExtractedAudioBatch | null> {
      const targetTicks = Math.max(0, startTimeSec * targetTimescale);
      let startIdx = binarySearchDts(table.dts, targetTicks);
      if (startIdx > 0 && table.dts[startIdx] > targetTicks) {
        startIdx = Math.max(0, startIdx - 1);
      }
      if (startIdx >= totalSamples) return null;

      const endTicks = table.dts[startIdx] + minDurationSec * targetTimescale;
      let endIdx = startIdx;
      while (endIdx < totalSamples && table.dts[endIdx] < endTicks) {
        endIdx++;
      }
      if (endIdx === startIdx) endIdx = Math.min(totalSamples, startIdx + 1);

      // Coalesce byte reads when gaps between audio chunks are <= 64 KB (max 2 MB read)
      const samples: MediaSample[] = [];
      let i = startIdx;
      while (i < endIdx) {
        const spanStart = table.offsets[i];
        let spanEnd = spanStart + table.sizes[i];
        let j = i + 1;
        while (j < endIdx) {
          const nextStart = table.offsets[j];
          const nextEnd = nextStart + table.sizes[j];
          if (nextStart >= spanStart && nextStart - spanEnd <= 65536 && nextEnd - spanStart <= 2 * 1024 * 1024) {
            if (nextEnd > spanEnd) spanEnd = nextEnd;
            j++;
          } else {
            break;
          }
        }

        const chunkBuf = await reader.read(spanStart, spanEnd - spanStart);
        for (let k = i; k < j; k++) {
          const rel = table.offsets[k] - spanStart;
          const sz = table.sizes[k];
          if (rel >= 0 && rel + sz <= chunkBuf.length) {
            samples.push({
              duration: table.durations[k],
              data: chunkBuf.subarray(rel, rel + sz),
            });
          }
        }
        i = j;
      }

      if (samples.length === 0) return null;
      const lastSample = endIdx - 1;
      const endTimeSec = (table.dts[lastSample] + table.durations[lastSample]) / targetTimescale;

      return {
        baseDecodeTime: table.dts[startIdx],
        endTimeSec,
        samples,
        atEnd: endIdx >= totalSamples,
      };
    },
  };
}

// ============================================================================
// MKV Audio Source (Cues + Cluster Scanner + Xiph/Fixed/EBML Lacing)
// ============================================================================

function readEbmlFloat(bytes: Uint8Array, start: number, len: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, len);
  if (len === 4) return view.getFloat32(0, false);
  if (len === 8) return view.getFloat64(0, false);
  return 0;
}

function buildOpusSampleEntry(channels: number, opusHead: Uint8Array): Uint8Array {
  let dOpsPayload: Uint8Array;
  if (opusHead.length >= 19) {
    dOpsPayload = new Uint8Array(11);
    const dv = new DataView(dOpsPayload.buffer);
    const hv = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
    dOpsPayload[0] = 0; // Version = 0
    dOpsPayload[1] = opusHead[9]; // OutputChannelCount
    dv.setUint16(2, hv.getUint16(10, true), false); // PreSkip LE -> BE
    dv.setUint32(4, hv.getUint32(12, true), false); // InputSampleRate LE -> BE
    dv.setInt16(8, hv.getInt16(16, true), false); // OutputGain LE -> BE
    dOpsPayload[10] = opusHead[18]; // ChannelMappingFamily
  } else {
    dOpsPayload = new Uint8Array([0, channels || 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0]);
  }
  const dOps = makeBox('dOps', dOpsPayload);
  return buildAudioSampleEntry('Opus', channels, 48000, [dOps]);
}

export function unpackMkvBlockFrames(
  bytes: Uint8Array,
  start: number,
  end: number,
  expectedTrackNumber: number
): { relTimeMs: number; frames: Uint8Array[] } | null {
  const trackVint = readEbmlSize(bytes, start, end);
  if (!trackVint || trackVint.size !== expectedTrackNumber) return null;

  const p = trackVint.nextPos;
  if (p + 3 > end) return null;

  const relTimeMs = new DataView(bytes.buffer, bytes.byteOffset + p, 2).getInt16(0, false);
  const flags = bytes[p + 2];
  const lacing = (flags >> 1) & 0x03;

  if (lacing === 0) {
    return { relTimeMs, frames: [bytes.subarray(p + 3, end)] };
  }

  if (p + 4 > end) return null;
  const numFrames = bytes[p + 3] + 1;
  let cursor = p + 4;
  const frameSizes: number[] = [];

  if (lacing === 1) {
    // Xiph lacing
    for (let i = 0; i < numFrames - 1; i++) {
      let sz = 0;
      while (cursor < end) {
        const b = bytes[cursor++];
        sz += b;
        if (b !== 255) break;
      }
      frameSizes.push(sz);
    }
  } else if (lacing === 2) {
    // Fixed-size lacing
    const equalSize = Math.floor((end - cursor) / numFrames);
    for (let i = 0; i < numFrames - 1; i++) {
      frameSizes.push(equalSize);
    }
  } else if (lacing === 3) {
    // EBML lacing
    const first = readEbmlSize(bytes, cursor, end);
    if (!first || first.size < 0) return null;
    let prevSize = first.size;
    frameSizes.push(prevSize);
    cursor = first.nextPos;

    for (let i = 1; i < numFrames - 1; i++) {
      const deltaInfo = readEbmlSize(bytes, cursor, end);
      if (!deltaInfo || deltaInfo.size < 0) return null;
      const byteLen = deltaInfo.nextPos - cursor;
      const bias = Math.pow(2, 7 * byteLen - 1) - 1;
      prevSize = prevSize + (deltaInfo.size - bias);
      if (prevSize < 0) return null;
      frameSizes.push(prevSize);
      cursor = deltaInfo.nextPos;
    }
  }

  let consumed = 0;
  for (let i = 0; i < frameSizes.length; i++) {
    consumed += frameSizes[i];
  }
  const lastSize = end - cursor - consumed;
  if (lastSize < 0) return null;
  frameSizes.push(lastSize);

  const frames: Uint8Array[] = [];
  let framePos = cursor;
  for (let i = 0; i < frameSizes.length; i++) {
    const fSz = frameSizes[i];
    if (framePos + fSz > end) break;
    frames.push(bytes.subarray(framePos, framePos + fSz));
    framePos += fSz;
  }
  return { relTimeMs, frames };
}

export interface MkvClusterRef {
  timeSec: number;
  absOffset: number;
}

export interface MkvClusterHeader {
  dataStart: number;
  endOffset: number;
  timeSec: number;
}

export interface MkvContainerContext {
  segmentDataStart: number;
  segmentEnd: number;
  timestampScaleNs: number;
  tracksBuf: Uint8Array;
  cuesBuf: Uint8Array | null;
  clusterRefs: MkvClusterRef[];
  firstClusterAbsOffset: number | null;
  readClusterHeader: (absOffset: number) => Promise<MkvClusterHeader | null>;
  findClusterStartOffset: (targetTimeSec: number) => Promise<number | null>;
}

export async function openMkvContainerContext(
  reader: ByteReader
): Promise<MkvContainerContext | null> {
  const initialLen = Math.min(reader.size, 2 * 1024 * 1024);
  const headBuf = await reader.read(0, initialLen);
  if (headBuf.length < 16) return null;

  let pos = 0;
  const ebmlId = readEbmlId(headBuf, pos, headBuf.length);
  if (!ebmlId || ebmlId.id !== 0x1a45dfa3) return null;
  const ebmlSize = readEbmlSize(headBuf, ebmlId.nextPos, headBuf.length);
  if (!ebmlSize || ebmlSize.size < 0) return null;
  pos = ebmlSize.nextPos + ebmlSize.size;

  const segId = readEbmlId(headBuf, pos, headBuf.length);
  if (!segId || segId.id !== 0x18538067) return null;
  const segSize = readEbmlSize(headBuf, segId.nextPos, headBuf.length);
  if (!segSize) return null;

  const segmentDataStart = segSize.nextPos;
  const segmentEnd =
    segSize.size >= 0 ? Math.min(reader.size, segmentDataStart + segSize.size) : reader.size;
  const scanEnd = Math.min(headBuf.length, segmentEnd);

  let timestampScaleNs = 1000000;
  let tracksSeekRel: number | null = null;
  let cuesSeekRel: number | null = null;
  let tracksBuf: Uint8Array | null = null;
  let cuesBuf: Uint8Array | null = null;
  let firstClusterAbsOffset: number | null = null;

  const parseSeekHead = (buf: Uint8Array, start: number, end: number) => {
    let p = start;
    while (p < end) {
      const id = readEbmlId(buf, p, end);
      if (!id) break;
      const sz = readEbmlSize(buf, id.nextPos, end);
      if (!sz || sz.size < 0) break;
      const eStart = sz.nextPos;
      const eEnd = Math.min(end, eStart + sz.size);
      if (id.id === 0x4dbb) {
        let sId = 0;
        let sPos: number | null = null;
        let sp = eStart;
        while (sp < eEnd) {
          const fi = readEbmlId(buf, sp, eEnd);
          if (!fi) break;
          const fs = readEbmlSize(buf, fi.nextPos, eEnd);
          if (!fs || fs.size < 0) break;
          const vs = fs.nextPos;
          const ve = Math.min(eEnd, vs + fs.size);
          if (fi.id === 0x53ab) sId = readEbmlUint(buf, vs, ve - vs);
          else if (fi.id === 0x53ac) sPos = readEbmlUint(buf, vs, ve - vs);
          sp = ve;
        }
        if (sId === 0x1654ae6b && sPos !== null && tracksSeekRel === null) tracksSeekRel = sPos;
        if (sId === 0x1c53bb6b && sPos !== null && cuesSeekRel === null) cuesSeekRel = sPos;
      }
      p = eEnd;
    }
  };

  pos = segmentDataStart;
  let iters = 0;
  while (pos < scanEnd && iters < 256) {
    iters++;
    const cid = readEbmlId(headBuf, pos, scanEnd);
    if (!cid) break;
    const csz = readEbmlSize(headBuf, cid.nextPos, scanEnd);
    if (!csz) break;
    const cStart = csz.nextPos;
    if (cid.id === 0x1f43b675) {
      firstClusterAbsOffset = pos;
      break;
    }
    if (csz.size < 0) break;
    const cEnd = cStart + csz.size;

    if (cid.id === 0x1549a966 && cEnd <= headBuf.length) {
      let ip = cStart;
      while (ip < cEnd) {
        const fi = readEbmlId(headBuf, ip, cEnd);
        if (!fi) break;
        const fs = readEbmlSize(headBuf, fi.nextPos, cEnd);
        if (!fs || fs.size < 0) break;
        const vs = fs.nextPos;
        const ve = Math.min(cEnd, vs + fs.size);
        if (fi.id === 0x2ad7b1) {
          timestampScaleNs = readEbmlUint(headBuf, vs, ve - vs) || 1000000;
        }
        ip = ve;
      }
    } else if (cid.id === 0x114d9b74 && cEnd <= headBuf.length) {
      parseSeekHead(headBuf, cStart, cEnd);
    } else if (cid.id === 0x1654ae6b) {
      tracksBuf =
        cEnd <= headBuf.length
          ? headBuf.subarray(cStart, cEnd)
          : csz.size <= 4 * 1024 * 1024
            ? await reader.read(cStart, csz.size)
            : null;
    } else if (cid.id === 0x1c53bb6b) {
      cuesBuf =
        cEnd <= headBuf.length
          ? headBuf.subarray(cStart, cEnd)
          : csz.size <= 8 * 1024 * 1024
            ? await reader.read(cStart, csz.size)
            : null;
    }

    pos = cEnd;
  }

  const readSeekedElement = async (
    relOffset: number,
    expectedId: number,
    maxLen: number
  ): Promise<Uint8Array | null> => {
    const abs = segmentDataStart + relOffset;
    if (abs + 16 >= reader.size) return null;
    const probe = await reader.read(abs, Math.min(64 * 1024, reader.size - abs));
    const eid = readEbmlId(probe, 0, probe.length);
    if (!eid || eid.id !== expectedId) return null;
    const esz = readEbmlSize(probe, eid.nextPos, probe.length);
    if (!esz || esz.size <= 0 || esz.size > maxLen) return null;
    if (esz.nextPos + esz.size <= probe.length) {
      return probe.subarray(esz.nextPos, esz.nextPos + esz.size);
    }
    return reader.read(abs + esz.nextPos, esz.size);
  };

  if (!tracksBuf && tracksSeekRel !== null) {
    tracksBuf = await readSeekedElement(tracksSeekRel, 0x1654ae6b, 4 * 1024 * 1024);
  }
  if (!tracksBuf) return null;

  if (!cuesBuf && cuesSeekRel !== null) {
    cuesBuf = await readSeekedElement(cuesSeekRel, 0x1c53bb6b, 8 * 1024 * 1024);
  }

  const tickToSec = timestampScaleNs / 1000000000;
  const clusterRefs: MkvClusterRef[] = [];
  if (cuesBuf) {
    const seenOffsets = new Set<number>();
    let cp = 0;
    while (cp < cuesBuf.length) {
      const ci = readEbmlId(cuesBuf, cp, cuesBuf.length);
      if (!ci) break;
      const csz = readEbmlSize(cuesBuf, ci.nextPos, cuesBuf.length);
      if (!csz || csz.size < 0) break;
      const eStart = csz.nextPos;
      const eEnd = Math.min(cuesBuf.length, eStart + csz.size);
      if (ci.id === 0xbb) {
        let cueTimeTicks = -1;
        let clusterRelPos = -1;
        let fp = eStart;
        while (fp < eEnd) {
          const fi = readEbmlId(cuesBuf, fp, eEnd);
          if (!fi) break;
          const fs = readEbmlSize(cuesBuf, fi.nextPos, eEnd);
          if (!fs || fs.size < 0) break;
          const vs = fs.nextPos;
          const ve = Math.min(eEnd, vs + fs.size);
          if (fi.id === 0xb3) {
            cueTimeTicks = readEbmlUint(cuesBuf, vs, ve - vs);
          } else if (fi.id === 0xb7) {
            let pp = vs;
            while (pp < ve) {
              const pi = readEbmlId(cuesBuf, pp, ve);
              if (!pi) break;
              const psz = readEbmlSize(cuesBuf, pi.nextPos, ve);
              if (!psz || psz.size < 0) break;
              const pvs = psz.nextPos;
              const pve = Math.min(ve, pvs + psz.size);
              if (pi.id === 0xf1 && clusterRelPos === -1) {
                clusterRelPos = readEbmlUint(cuesBuf, pvs, pve - pvs);
              }
              pp = pve;
            }
          }
          fp = ve;
        }
        if (cueTimeTicks >= 0 && clusterRelPos >= 0) {
          const absOff = segmentDataStart + clusterRelPos;
          if (!seenOffsets.has(absOff)) {
            seenOffsets.add(absOff);
            clusterRefs.push({ timeSec: cueTimeTicks * tickToSec, absOffset: absOff });
          }
        }
      }
      cp = eEnd;
    }
    clusterRefs.sort((a, b) => a.timeSec - b.timeSec);
  }

  const readClusterHeader = async (absOffset: number): Promise<MkvClusterHeader | null> => {
    if (absOffset + 8 >= segmentEnd) return null;
    const probe = await reader.read(absOffset, Math.min(64, segmentEnd - absOffset));
    const cid = readEbmlId(probe, 0, probe.length);
    if (!cid || cid.id !== 0x1f43b675) return null;
    const csz = readEbmlSize(probe, cid.nextPos, probe.length);
    if (!csz) return null;
    const dataStart = absOffset + csz.nextPos;
    const endOffset = csz.size >= 0 ? Math.min(segmentEnd, dataStart + csz.size) : segmentEnd;

    let timeSec = 0;
    const ti = readEbmlId(probe, csz.nextPos, probe.length);
    if (ti && ti.id === 0xe7) {
      const tsz = readEbmlSize(probe, ti.nextPos, probe.length);
      if (tsz && tsz.size >= 0 && tsz.nextPos + tsz.size <= probe.length) {
        timeSec = readEbmlUint(probe, tsz.nextPos, tsz.size) * tickToSec;
      }
    }
    return { dataStart, endOffset, timeSec };
  };

  if (firstClusterAbsOffset === null) {
    let scanPos = segmentDataStart;
    let guard = 0;
    while (scanPos + 12 < segmentEnd && guard < 256) {
      guard++;
      const p = await reader.read(scanPos, Math.min(32, segmentEnd - scanPos));
      const eid = readEbmlId(p, 0, p.length);
      if (!eid) break;
      const esz = readEbmlSize(p, eid.nextPos, p.length);
      if (!esz) break;
      if (eid.id === 0x1f43b675) {
        firstClusterAbsOffset = scanPos;
        break;
      }
      if (esz.size < 0) break;
      scanPos += esz.nextPos + esz.size;
    }
  }

  const findClusterStartOffset = async (targetTimeSec: number): Promise<number | null> => {
    if (clusterRefs.length > 0) {
      let best = clusterRefs[0].absOffset;
      for (let i = 0; i < clusterRefs.length; i++) {
        if (clusterRefs[i].timeSec <= targetTimeSec) {
          best = clusterRefs[i].absOffset;
        } else {
          break;
        }
      }
      return best;
    }
    if (firstClusterAbsOffset === null) return null;

    let cur = firstClusterAbsOffset;
    let best = firstClusterAbsOffset;
    let guard = 0;
    while (cur < segmentEnd && guard < 10000) {
      guard++;
      const hdr = await readClusterHeader(cur);
      if (!hdr || hdr.endOffset <= cur) break;
      if (hdr.timeSec <= targetTimeSec) {
        best = cur;
        cur = hdr.endOffset;
      } else {
        break;
      }
    }
    return best;
  };

  return {
    segmentDataStart,
    segmentEnd,
    timestampScaleNs,
    tracksBuf,
    cuesBuf,
    clusterRefs,
    firstClusterAbsOffset,
    readClusterHeader,
    findClusterStartOffset,
  };
}

async function openMkvAudioSource(
  reader: ByteReader,
  audioTrackIndex: number
): Promise<AudioTrackSource | null> {
  const ctx = await openMkvContainerContext(reader);
  if (!ctx) return null;
  const { segmentEnd, timestampScaleNs, tracksBuf, readClusterHeader, findClusterStartOffset } = ctx;

  // Extract target audio track entry details
  let currentAudioIdx = -1;
  let targetTrackNumber = 0;
  let codecId = '';
  let codecPrivate = new Uint8Array(0);
  let codecDelayNs = 0;
  let sampleRate = 48000;
  let channels = 2;

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
      let cDelay = 0;
      let sRate = 48000;
      let ch = 2;

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
        else if (fi.id === 0x56aa) cDelay = readEbmlUint(tracksBuf, vs, vl);
        else if (fi.id === 0xe1) {
          let ap = vs;
          while (ap < ve) {
            const ai = readEbmlId(tracksBuf, ap, ve);
            if (!ai) break;
            const asz = readEbmlSize(tracksBuf, ai.nextPos, ve);
            if (!asz || asz.size < 0) break;
            const avs = asz.nextPos;
            const ave = Math.min(ve, avs + asz.size);
            if (ai.id === 0xb5) {
              const r = readEbmlFloat(tracksBuf, avs, ave - avs);
              if (r > 0) sRate = r;
            } else if (ai.id === 0x9f) {
              ch = readEbmlUint(tracksBuf, avs, ave - avs) || 2;
            }
            ap = ave;
          }
        }
        fp = ve;
      }

      if (tType === 2) {
        currentAudioIdx++;
        if (currentAudioIdx === audioTrackIndex) {
          targetTrackNumber = tNum;
          codecId = cId;
          codecPrivate = cPriv;
          codecDelayNs = cDelay;
          sampleRate = sRate;
          channels = ch;
          break;
        }
      }
    }
    tp = eEnd;
  }

  if (!targetTrackNumber || !codecId) return null;

  let audioTimescale = Math.round(sampleRate) || 48000;
  let samplesPerFrame = 1024;
  let sampleEntry: Uint8Array;
  let mime = 'audio/mp4; codecs="mp4a.40.2"';

  if (codecId.indexOf('A_AAC') === 0) {
    const asc =
      codecPrivate.length >= 2 ? codecPrivate : synthesizeAacAsc(sampleRate, channels);
    const ascInfo = parseAscInfo(asc);
    audioTimescale = ascInfo.coreSampleRate;
    samplesPerFrame = 1024;
    if (codecId.indexOf('SBR') !== -1 || ascInfo.aot === 5 || ascInfo.aot === 29) {
      const heMime = 'audio/mp4; codecs="mp4a.40.5"';
      mime = checkMseMimeSupported(heMime) ? heMime : 'audio/mp4; codecs="mp4a.40.2"';
    }
    sampleEntry = buildAudioSampleEntry('mp4a', channels, audioTimescale, [buildEsdsBox(asc, 0x40)]);
  } else if (codecId === 'A_MPEG/L3') {
    audioTimescale = Math.round(sampleRate) || 48000;
    samplesPerFrame = audioTimescale >= 32000 ? 1152 : 576;
    mime = 'audio/mp4; codecs="mp3"';
    sampleEntry = buildAudioSampleEntry('mp4a', channels, audioTimescale, [
      buildEsdsBox(new Uint8Array(0), 0x6b),
    ]);
  } else if (codecId === 'A_OPUS') {
    audioTimescale = 48000;
    samplesPerFrame = 960;
    mime = 'audio/mp4; codecs="opus"';
    sampleEntry = buildOpusSampleEntry(channels, codecPrivate);
  } else {
    return null;
  }

  if (!checkMseMimeSupported(mime)) return null;

  const initSegment = buildFmp4InitSegment(sampleEntry, audioTimescale);
  const codecDelayMs = codecDelayNs / 1000000;

  return {
    mime,
    timescale: audioTimescale,
    initSegment,
    async readBatchAt(startTimeSec: number, minDurationSec: number): Promise<ExtractedAudioBatch | null> {
      let clusterOff = await findClusterStartOffset(startTimeSec);
      if (clusterOff === null) return null;

      const samples: MediaSample[] = [];
      let baseDecodeTime: number | null = null;
      let expectedNextDts = 0;
      let batchEndSec = startTimeSec;
      let atEnd = false;
      let clustersRead = 0;
      const targetEndSec = startTimeSec + minDurationSec;

      while (clusterOff < segmentEnd && clustersRead < 64) {
        clustersRead++;
        const hdr = await readClusterHeader(clusterOff);
        if (!hdr || hdr.endOffset <= clusterOff) {
          atEnd = true;
          break;
        }

        const clusterSize = hdr.endOffset - hdr.dataStart;
        if (clusterSize > 32 * 1024 * 1024) break;
        const cBuf = await reader.read(hdr.dataStart, clusterSize);
        let clusterTimeMs = hdr.timeSec * 1000;

        let cp = 0;
        while (cp < cBuf.length) {
          const eid = readEbmlId(cBuf, cp, cBuf.length);
          if (!eid) break;
          const esz = readEbmlSize(cBuf, eid.nextPos, cBuf.length);
          if (!esz || esz.size < 0) break;
          const bStart = esz.nextPos;
          const bEnd = Math.min(cBuf.length, bStart + esz.size);

          let blockSlice: { relTimeMs: number; frames: Uint8Array[] } | null = null;
          if (eid.id === 0xe7) {
            clusterTimeMs = readEbmlUint(cBuf, bStart, bEnd - bStart) * (timestampScaleNs / 1000000);
          } else if (eid.id === 0xa3) {
            blockSlice = unpackMkvBlockFrames(cBuf, bStart, bEnd, targetTrackNumber);
          } else if (eid.id === 0xa0) {
            let bp = bStart;
            while (bp < bEnd) {
              const bid = readEbmlId(cBuf, bp, bEnd);
              if (!bid) break;
              const bsz = readEbmlSize(cBuf, bid.nextPos, bEnd);
              if (!bsz || bsz.size < 0) break;
              const bvStart = bsz.nextPos;
              const bvEnd = Math.min(bEnd, bvStart + bsz.size);
              if (bid.id === 0xa1) {
                blockSlice = unpackMkvBlockFrames(cBuf, bvStart, bvEnd, targetTrackNumber);
              }
              bp = bvEnd;
            }
          }

          if (blockSlice && blockSlice.frames.length > 0) {
            const blockTimeSec = Math.max(
              0,
              (clusterTimeMs + blockSlice.relTimeMs - codecDelayMs) / 1000
            );
            const blockEndSec =
              blockTimeSec + (blockSlice.frames.length * samplesPerFrame) / audioTimescale;

            if (blockEndSec >= startTimeSec) {
              if (baseDecodeTime === null) {
                baseDecodeTime = Math.round(blockTimeSec * audioTimescale);
                expectedNextDts = baseDecodeTime;
              } else {
                const containerDts = Math.round(blockTimeSec * audioTimescale);
                // Snap only on significant discontinuity (> 40ms); keep sample-accurate otherwise
                if (Math.abs(containerDts - expectedNextDts) > audioTimescale * 0.04) {
                  expectedNextDts = containerDts;
                }
              }

              for (let fi = 0; fi < blockSlice.frames.length; fi++) {
                samples.push({
                  duration: samplesPerFrame,
                  data: blockSlice.frames[fi],
                });
                expectedNextDts += samplesPerFrame;
              }
              batchEndSec = expectedNextDts / audioTimescale;
            }
          }

          cp = bEnd;
        }

        clusterOff = hdr.endOffset;
        if (clusterOff >= segmentEnd) {
          atEnd = true;
          break;
        }
        if (samples.length > 0 && batchEndSec >= targetEndSec) {
          break;
        }
      }

      if (samples.length === 0 || baseDecodeTime === null) return null;
      return {
        baseDecodeTime,
        endTimeSec: batchEndSec,
        samples,
        atEnd,
      };
    },
  };
}

export async function openAudioTrackSource(
  sourceInput: { file?: File | null; url?: string | null },
  containerType: 'mp4' | 'mkv' | undefined,
  trackIndex: number
): Promise<AudioTrackSource | null> {
  let reader: ByteReader | null = null;
  if (sourceInput.file) {
    reader = createFileByteReader(sourceInput.file);
  } else if (sourceInput.url) {
    reader = await createRangeByteReader(sourceInput.url);
  }
  if (!reader) return null;

  if (containerType === 'mkv') {
    return openMkvAudioSource(reader, trackIndex);
  }
  if (containerType === 'mp4') {
    return openMp4AudioSource(reader, trackIndex);
  }
  return null;
}

// ============================================================================
// MSE Audio Track Controller (Drives <audio> seamlessly with <video>)
// ============================================================================

export function isTimeBufferedOnAudio(audio: HTMLAudioElement, timeSec: number): boolean {
  const b = audio.buffered;
  for (let i = 0; i < b.length; i++) {
    if (timeSec >= b.start(i) - 0.12 && timeSec <= b.end(i)) {
      return true;
    }
  }
  return false;
}

export class MseAudioTrackController {
  private audioEl: HTMLAudioElement;
  private source: AudioTrackSource;
  private mediaSource: MediaSource;
  private mediaSourceUrl: string;
  private sourceBuffer: SourceBuffer | null = null;
  private destroyed = false;
  private seqNumber = 1;
  private lastAppendedEndSec = -1;
  private atEnd = false;
  private generation = 0;
  private busy = false;
  private pendingStartSec: number | null = null;
  private onReadyCb?: () => void;
  private onErrorCb?: (msg: string) => void;
  private readyFired = false;

  constructor(
    audioEl: HTMLAudioElement,
    source: AudioTrackSource,
    initialTimeSec: number,
    onReady?: () => void,
    onError?: (msg: string) => void
  ) {
    this.audioEl = audioEl;
    this.source = source;
    this.onReadyCb = onReady;
    this.onErrorCb = onError;
    this.pendingStartSec = initialTimeSec;

    this.mediaSource = new MediaSource();
    this.mediaSourceUrl = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', this.handleSourceOpen);
    this.audioEl.src = this.mediaSourceUrl;
  }

  private handleSourceOpen = () => {
    if (this.destroyed) return;
    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(this.source.mime);
      this.appendBytes(this.source.initSegment)
        .then(() => {
          if (!this.destroyed && this.pendingStartSec !== null) {
            const target = this.pendingStartSec;
            this.pendingStartSec = null;
            return this.seekTo(target);
          }
        })
        .catch(() => {
          if (!this.destroyed && this.onErrorCb) {
            this.onErrorCb('Failed to initialize audio stream');
          }
        });
    } catch {
      if (this.onErrorCb) {
        this.onErrorCb('Unsupported audio codec for in-browser switching');
      }
    }
  };

  private appendBytes(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const sb = this.sourceBuffer;
      if (this.destroyed || !sb) {
        resolve();
        return;
      }
      const waitReady = () => {
        if (this.destroyed) {
          resolve();
          return;
        }
        if (sb.updating) {
          sb.addEventListener('updateend', waitReady, { once: true });
          return;
        }
        const onEnd = () => {
          sb.removeEventListener('error', onErr);
          resolve();
        };
        const onErr = () => {
          sb.removeEventListener('updateend', onEnd);
          reject(new Error('SourceBuffer append error'));
        };
        sb.addEventListener('updateend', onEnd, { once: true });
        sb.addEventListener('error', onErr, { once: true });
        try {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          sb.appendBuffer(copy.buffer);
        } catch (err) {
          sb.removeEventListener('updateend', onEnd);
          sb.removeEventListener('error', onErr);
          reject(err);
        }
      };
      waitReady();
    });
  }

  private removeRange(start: number, end: number): Promise<void> {
    return new Promise((resolve) => {
      const sb = this.sourceBuffer;
      if (this.destroyed || !sb || start >= end) {
        resolve();
        return;
      }
      const runRemove = () => {
        if (this.destroyed) {
          resolve();
          return;
        }
        if (sb.updating) {
          sb.addEventListener('updateend', runRemove, { once: true });
          return;
        }
        sb.addEventListener('updateend', () => resolve(), { once: true });
        try {
          sb.remove(start, end);
        } catch {
          resolve();
        }
      };
      runRemove();
    });
  }

  private getBufferedEndAt(timeSec: number): number | null {
    const b = this.audioEl.buffered;
    for (let i = 0; i < b.length; i++) {
      if (timeSec >= b.start(i) - 0.15 && timeSec <= b.end(i) + 0.1) {
        return b.end(i);
      }
    }
    return null;
  }

  public async seekTo(timeSec: number): Promise<void> {
    if (this.destroyed) return;
    if (!this.sourceBuffer) {
      this.pendingStartSec = timeSec;
      return;
    }

    const myGen = ++this.generation;
    while (this.busy) {
      await new Promise((r) => setTimeout(r, 20));
      if (this.destroyed || myGen !== this.generation) return;
    }

    const alreadyEnd = this.getBufferedEndAt(timeSec);
    if (alreadyEnd !== null && alreadyEnd - timeSec > 2) {
      this.lastAppendedEndSec = alreadyEnd;
      if (!this.readyFired) {
        this.readyFired = true;
        if (this.onReadyCb) this.onReadyCb();
      }
      return;
    }

    this.busy = true;
    try {
      this.atEnd = false;
      const b = this.audioEl.buffered;
      if (b.length > 0) {
        const bStart = b.start(0);
        const bEnd = b.end(b.length - 1);
        if (bEnd > bStart) {
          await this.removeRange(0, bEnd + 1);
        }
      }
      if (this.destroyed || myGen !== this.generation) return;

      const batch = await this.source.readBatchAt(Math.max(0, timeSec - 0.08), 12);
      if (this.destroyed || myGen !== this.generation || !batch) return;

      const seg = buildFmp4MediaSegment(this.seqNumber++, batch.baseDecodeTime, batch.samples);
      await this.appendBytes(seg);
      if (this.destroyed || myGen !== this.generation) return;

      this.lastAppendedEndSec = batch.endTimeSec;
      this.atEnd = batch.atEnd;

      if (!this.readyFired) {
        this.readyFired = true;
        if (this.onReadyCb) this.onReadyCb();
      }
    } catch {
      if (!this.destroyed && this.onErrorCb) {
        this.onErrorCb('Audio seek failed');
      }
    } finally {
      this.busy = false;
    }
  }

  public async ensureBufferedAt(timeSec: number): Promise<void> {
    if (this.destroyed || !this.sourceBuffer || this.busy) return;

    const bufferedEnd = this.getBufferedEndAt(timeSec);
    if (bufferedEnd === null) {
      await this.seekTo(timeSec);
      return;
    }

    if (this.atEnd || bufferedEnd - timeSec >= 12) return;

    const myGen = this.generation;
    this.busy = true;
    try {
      // Evict stale buffer older than 45 seconds behind current time
      const b = this.audioEl.buffered;
      if (b.length > 0 && timeSec - b.start(0) > 60) {
        await this.removeRange(0, timeSec - 45);
      }
      if (this.destroyed || myGen !== this.generation) return;

      const nextFrom = Math.max(timeSec, this.lastAppendedEndSec, bufferedEnd);
      const batch = await this.source.readBatchAt(nextFrom, 12);
      if (this.destroyed || myGen !== this.generation) return;
      if (!batch) {
        this.atEnd = true;
        return;
      }

      const seg = buildFmp4MediaSegment(this.seqNumber++, batch.baseDecodeTime, batch.samples);
      await this.appendBytes(seg);
      this.lastAppendedEndSec = batch.endTimeSec;
      this.atEnd = batch.atEnd;
    } catch {
      // Ignore transient buffer append error during seek race
    } finally {
      this.busy = false;
    }
  }

  public destroy() {
    this.destroyed = true;
    this.generation++;
    this.mediaSource.removeEventListener('sourceopen', this.handleSourceOpen);
    try {
      if (this.mediaSource.readyState === 'open' && !this.sourceBuffer?.updating) {
        this.mediaSource.endOfStream();
      }
    } catch {
      // Ignore endOfStream errors during teardown
    }
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    URL.revokeObjectURL(this.mediaSourceUrl);
  }
}

