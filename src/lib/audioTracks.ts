export interface NativeAudioTrack {
  id: string;
  kind: string;
  label: string;
  language: string;
  enabled: boolean;
}

export interface NativeAudioTrackList extends EventTarget {
  readonly length: number;
  [index: number]: NativeAudioTrack;
  getTrackById?(id: string): NativeAudioTrack | null;
  onchange?: ((ev: Event) => void) | null;
  onaddtrack?: ((ev: Event) => void) | null;
  onremovetrack?: ((ev: Event) => void) | null;
}

export type VideoElementWithAudioTracks = HTMLVideoElement & {
  audioTracks?: NativeAudioTrackList;
};

export interface AudioTrackOption {
  index: number;
  id: string;
  label: string;
  language: string;
  languageCode: string;
  kind: string;
  codec?: string;
  enabled: boolean;
  containerType?: 'mp4' | 'mkv';
  containerTrackNumber?: number;
  mseMime?: string;
  mseSupported?: boolean;
}

const ISO_639_MAP: Record<string, string> = {
  en: 'English',
  eng: 'English',
  hi: 'Hindi',
  hin: 'Hindi',
  ja: 'Japanese',
  jpn: 'Japanese',
  ko: 'Korean',
  kor: 'Korean',
  es: 'Spanish',
  spa: 'Spanish',
  fr: 'French',
  fra: 'French',
  fre: 'French',
  de: 'German',
  deu: 'German',
  ger: 'German',
  it: 'Italian',
  ita: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  ru: 'Russian',
  rus: 'Russian',
  zh: 'Chinese',
  zho: 'Chinese',
  chi: 'Chinese',
  ar: 'Arabic',
  ara: 'Arabic',
  ta: 'Tamil',
  tam: 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  ml: 'Malayalam',
  mal: 'Malayalam',
  kn: 'Kannada',
  kan: 'Kannada',
  bn: 'Bengali',
  ben: 'Bengali',
  mr: 'Marathi',
  mar: 'Marathi',
  pa: 'Punjabi',
  pan: 'Punjabi',
  gu: 'Gujarati',
  guj: 'Gujarati',
  ur: 'Urdu',
  urd: 'Urdu',
  th: 'Thai',
  tha: 'Thai',
  vi: 'Vietnamese',
  vie: 'Vietnamese',
  id: 'Indonesian',
  ind: 'Indonesian',
  ms: 'Malay',
  msa: 'Malay',
  may: 'Malay',
  tl: 'Tagalog',
  tgl: 'Tagalog',
  fil: 'Filipino',
  tr: 'Turkish',
  tur: 'Turkish',
  pl: 'Polish',
  pol: 'Polish',
  nl: 'Dutch',
  nld: 'Dutch',
  dut: 'Dutch',
  sv: 'Swedish',
  swe: 'Swedish',
  no: 'Norwegian',
  nor: 'Norwegian',
  da: 'Danish',
  dan: 'Danish',
  fi: 'Finnish',
  fin: 'Finnish',
  cs: 'Czech',
  ces: 'Czech',
  cze: 'Czech',
  el: 'Greek',
  ell: 'Greek',
  gre: 'Greek',
  he: 'Hebrew',
  heb: 'Hebrew',
  uk: 'Ukrainian',
  ukr: 'Ukrainian',
  fa: 'Persian',
  fas: 'Persian',
  per: 'Persian',
  ro: 'Romanian',
  ron: 'Romanian',
  rum: 'Romanian',
  hu: 'Hungarian',
  hun: 'Hungarian',
  mul: 'Multiple Languages',
};

const GENERIC_HANDLER_NAMES = new Set([
  'soundhandler',
  'core media audio',
  'gpac iso audio handler',
  'iso media file produced by google inc.',
  'handler',
  'audio',
]);

export function formatAudioLanguage(code?: string): string {
  if (!code) return '';
  const cleaned = code.trim().toLowerCase();
  if (!cleaned || cleaned === 'und' || cleaned === 'unk' || cleaned === 'zxx' || cleaned === 'mis') {
    return '';
  }

  const baseCode = cleaned.split(/[-_]/)[0];
  if (ISO_639_MAP[cleaned]) return ISO_639_MAP[cleaned];
  if (ISO_639_MAP[baseCode]) return ISO_639_MAP[baseCode];

  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
      const resolved = displayNames.of(cleaned) || displayNames.of(baseCode);
      if (resolved && resolved.toLowerCase() !== cleaned) {
        return resolved;
      }
    }
  } catch {
    // Fallback to raw uppercase code below
  }

  return baseCode.toUpperCase();
}

export function buildAudioTrackLabel(
  index: number,
  rawLabel?: string,
  languageCode?: string,
  codec?: string
): string {
  const cleanLabel = (rawLabel || '').trim();
  const langName = formatAudioLanguage(languageCode);
  const isGenericLabel =
    !cleanLabel || GENERIC_HANDLER_NAMES.has(cleanLabel.toLowerCase());

  let display = '';
  if (!isGenericLabel && langName) {
    if (cleanLabel.toLowerCase().indexOf(langName.toLowerCase()) !== -1) {
      display = cleanLabel;
    } else {
      display = `${langName} — ${cleanLabel}`;
    }
  } else if (!isGenericLabel) {
    display = cleanLabel;
  } else if (langName) {
    display = langName;
  } else {
    display = `Audio Track ${index + 1}`;
  }

  if (codec) {
    display = `${display} (${codec})`;
  }

  return display;
}

export function extractNativeAudioTracks(video: HTMLVideoElement | null): {
  supported: boolean;
  tracks: AudioTrackOption[];
  selectedIndex: number;
} {
  if (!video) {
    return { supported: false, tracks: [], selectedIndex: 0 };
  }

  const media = video as VideoElementWithAudioTracks;
  const list = media.audioTracks;
  if (!list) {
    return { supported: false, tracks: [], selectedIndex: 0 };
  }

  const tracks: AudioTrackOption[] = [];
  let selectedIndex = -1;

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t) continue;
    const enabled = Boolean(t.enabled);
    if (enabled && selectedIndex === -1) {
      selectedIndex = i;
    }
    tracks.push({
      index: i,
      id: t.id || String(i),
      label: buildAudioTrackLabel(i, t.label, t.language),
      language: formatAudioLanguage(t.language),
      languageCode: (t.language || '').trim().toLowerCase(),
      kind: (t.kind || '').trim(),
      enabled,
    });
  }

  return {
    supported: true,
    tracks,
    selectedIndex: selectedIndex === -1 ? 0 : selectedIndex,
  };
}

// ============================================================================
// Lightweight Binary Container Header Scanners (MP4 / MOV & MKV / WebM)
// Used only to detect embedded audio tracks when browser hides video.audioTracks
// ============================================================================

export type ByteReader = {
  size: number;
  read: (offset: number, length: number) => Promise<Uint8Array>;
};

export function checkMseMimeSupported(mime?: string): boolean {
  if (!mime || typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') {
    return false;
  }
  try {
    return MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

function getMp4MseMime(fourcc: string): string | undefined {
  switch (fourcc) {
    case 'mp4a':
      return 'audio/mp4; codecs="mp4a.40.2"';
    case 'ac-3':
      return 'audio/mp4; codecs="ac-3"';
    case 'ec-3':
      return 'audio/mp4; codecs="ec-3"';
    case 'Opus':
      return 'audio/mp4; codecs="opus"';
    case 'fLaC':
      return 'audio/mp4; codecs="flac"';
    case '.mp3':
    case 'mp3 ':
      return 'audio/mp4; codecs="mp3"';
    default:
      return undefined;
  }
}

function getMkvMseMime(codecId: string): string | undefined {
  const clean = codecId.trim();
  if (clean.indexOf('A_AAC') === 0) {
    if (clean.indexOf('SBR') !== -1) {
      return checkMseMimeSupported('audio/mp4; codecs="mp4a.40.5"')
        ? 'audio/mp4; codecs="mp4a.40.5"'
        : 'audio/mp4; codecs="mp4a.40.2"';
    }
    return 'audio/mp4; codecs="mp4a.40.2"';
  }
  if (clean === 'A_MPEG/L3') return 'audio/mp4; codecs="mp3"';
  if (clean === 'A_OPUS') return 'audio/mp4; codecs="opus"';
  return undefined;
}

export function readAscii(bytes: Uint8Array, start: number, len: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

export function readUtf8(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, Math.min(bytes.length, start + len));
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(slice).replace(/\0+$/g, '').trim();
  }
  return readAscii(slice, 0, slice.length).replace(/\0+$/g, '').trim();
}

function formatMp4Codec(fourcc: string): string {
  switch (fourcc) {
    case 'mp4a':
      return 'AAC';
    case 'ac-3':
      return 'AC-3';
    case 'ec-3':
      return 'E-AC-3';
    case 'Opus':
      return 'Opus';
    case 'fLaC':
      return 'FLAC';
    case 'alac':
      return 'ALAC';
    case '.mp3':
    case 'mp3 ':
      return 'MP3';
    default:
      return fourcc.trim();
  }
}

function formatMkvCodec(codecId: string): string {
  const clean = codecId.trim();
  if (!clean) return '';
  if (clean === 'A_MPEG/L3') return 'MP3';
  if (clean === 'A_MPEG/L2') return 'MP2';
  return clean.replace(/^A_/, '').replace(/\/.*$/, '');
}

async function parseMp4AudioTracks(reader: ByteReader): Promise<AudioTrackOption[]> {
  const totalSize = reader.size;
  let offset = 0;
  let iterations = 0;

  while (offset + 8 <= totalSize && iterations < 64) {
    iterations++;
    const header = await reader.read(offset, Math.min(16, totalSize - offset));
    if (header.length < 8) break;

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const size32 = view.getUint32(0, false);
    const type = readAscii(header, 4, 4);

    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (header.length < 16) break;
      const hi = view.getUint32(8, false);
      const lo = view.getUint32(12, false);
      boxSize = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = totalSize - offset;
    }

    if (boxSize < headerSize || offset + boxSize > totalSize) {
      break;
    }

    if (type === 'moov') {
      const payloadSize = boxSize - headerSize;
      // Guard against corrupted or absurdly large moov boxes (> 32 MB)
      if (payloadSize <= 0 || payloadSize > 32 * 1024 * 1024) {
        return [];
      }
      const moovBytes = await reader.read(offset + headerSize, payloadSize);
      return extractMp4TracksFromMoov(moovBytes);
    }

    offset += boxSize;
  }

  return [];
}

export function iterateMp4Children(
  bytes: Uint8Array,
  start: number,
  end: number,
  visitor: (type: string, payloadStart: number, payloadEnd: number) => void
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = view.getUint32(pos, false);
    const type = readAscii(bytes, pos + 4, 4);
    let headerSize = 8;
    let boxSize = size32;

    if (size32 === 1) {
      if (pos + 16 > end) break;
      const hi = view.getUint32(pos + 8, false);
      const lo = view.getUint32(pos + 12, false);
      boxSize = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = end - pos;
    }

    if (boxSize < headerSize || pos + boxSize > end) break;
    visitor(type, pos + headerSize, pos + boxSize);
    pos += boxSize;
  }
}

function extractMp4TracksFromMoov(bytes: Uint8Array): AudioTrackOption[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks: AudioTrackOption[] = [];

  iterateMp4Children(bytes, 0, bytes.length, (type, trakStart, trakEnd) => {
    if (type !== 'trak') return;

    let handlerType = '';
    let handlerName = '';
    let customName = '';
    let langCode = '';
    let codec = '';
    let fourccRaw = '';
    let isEnabled = true;

    iterateMp4Children(bytes, trakStart, trakEnd, (tType, pStart, pEnd) => {
      if (tType === 'tkhd' && pStart + 4 <= pEnd) {
        isEnabled = (bytes[pStart + 3] & 1) === 1;
      } else if (tType === 'udta') {
        iterateMp4Children(bytes, pStart, pEnd, (uType, uStart, uEnd) => {
          if (uType === 'name' && uEnd > uStart) {
            customName = readUtf8(bytes, uStart, uEnd - uStart);
          }
        });
      } else if (tType === 'mdia') {
        iterateMp4Children(bytes, pStart, pEnd, (mType, mStart, mEnd) => {
          if (mType === 'mdhd' && mStart + 4 <= mEnd) {
            const version = bytes[mStart];
            const langOff = version === 1 ? mStart + 32 : mStart + 20;
            if (langOff + 2 <= mEnd) {
              const packed = view.getUint16(langOff, false);
              if (packed !== 0) {
                const c1 = ((packed >> 10) & 0x1f) + 0x60;
                const c2 = ((packed >> 5) & 0x1f) + 0x60;
                const c3 = (packed & 0x1f) + 0x60;
                if (c1 >= 97 && c1 <= 122 && c2 >= 97 && c2 <= 122 && c3 >= 97 && c3 <= 122) {
                  langCode = String.fromCharCode(c1, c2, c3);
                }
              }
            }
          } else if (mType === 'hdlr' && mStart + 12 <= mEnd) {
            handlerType = readAscii(bytes, mStart + 8, 4);
            if (mStart + 24 < mEnd) {
              let nameStart = mStart + 24;
              const remaining = mEnd - nameStart;
              // QuickTime hdlr uses a 1-byte Pascal string length prefix
              if (bytes[nameStart] > 0 && bytes[nameStart] === remaining - 1) {
                nameStart += 1;
              }
              handlerName = readUtf8(bytes, nameStart, mEnd - nameStart);
            }
          } else if (mType === 'minf') {
            iterateMp4Children(bytes, mStart, mEnd, (minfType, minfStart, minfEnd) => {
              if (minfType !== 'stbl') return;
              iterateMp4Children(bytes, minfStart, minfEnd, (stblType, stblStart, stblEnd) => {
                if (stblType === 'stsd' && stblStart + 16 <= stblEnd) {
                  fourccRaw = readAscii(bytes, stblStart + 12, 4);
                  codec = formatMp4Codec(fourccRaw);
                }
              });
            });
          }
        });
      }
    });

    if (handlerType === 'soun') {
      const idx = tracks.length;
      const rawLabel = customName || handlerName;
      const mseMime = getMp4MseMime(fourccRaw);
      tracks.push({
        index: idx,
        id: String(idx),
        label: buildAudioTrackLabel(idx, rawLabel, langCode, codec),
        language: formatAudioLanguage(langCode),
        languageCode: langCode,
        kind: '',
        codec,
        enabled: isEnabled && !tracks.some((t) => t.enabled),
        containerType: 'mp4',
        mseMime,
        mseSupported: checkMseMimeSupported(mseMime),
      });
    }
  });

  return tracks;
}

export function readEbmlId(bytes: Uint8Array, pos: number, end: number): { id: number; nextPos: number } | null {
  if (pos >= end) return null;
  const b0 = bytes[pos];
  let len = 0;
  if (b0 & 0x80) len = 1;
  else if (b0 & 0x40) len = 2;
  else if (b0 & 0x20) len = 3;
  else if (b0 & 0x10) len = 4;
  else return null;

  if (pos + len > end) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = id * 256 + bytes[pos + i];
  }
  return { id, nextPos: pos + len };
}

export function readEbmlSize(bytes: Uint8Array, pos: number, end: number): { size: number; nextPos: number } | null {
  if (pos >= end) return null;
  const b0 = bytes[pos];
  if (b0 === 0) return null;

  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (b0 & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || pos + len > end) return null;

  const firstMask = mask - 1;
  const firstVal = b0 & firstMask;
  let allOnes = firstVal === firstMask;
  let size = firstVal;

  for (let i = 1; i < len; i++) {
    const b = bytes[pos + i];
    if (b !== 0xff) allOnes = false;
    size = size * 256 + b;
  }

  return { size: allOnes ? -1 : size, nextPos: pos + len };
}

export function readEbmlUint(bytes: Uint8Array, start: number, len: number): number {
  let val = 0;
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) {
    val = val * 256 + bytes[i];
  }
  return val;
}

function extractMkvTracksFromBuffer(bytes: Uint8Array, start: number, end: number): AudioTrackOption[] {
  const tracks: AudioTrackOption[] = [];
  let pos = start;

  while (pos < end) {
    const idInfo = readEbmlId(bytes, pos, end);
    if (!idInfo) break;
    const sizeInfo = readEbmlSize(bytes, idInfo.nextPos, end);
    if (!sizeInfo || sizeInfo.size < 0) break;

    const entryStart = sizeInfo.nextPos;
    const entryEnd = Math.min(end, entryStart + sizeInfo.size);

    if (idInfo.id === 0xae) {
      // TrackEntry
      let trackType = 0;
      let trackNumber = 0;
      let name = '';
      let language = '';
      let languageIetf = '';
      let codecId = '';
      let flagDefault = 1;
      let flagEnabled = 1;

      let tPos = entryStart;
      while (tPos < entryEnd) {
        const fId = readEbmlId(bytes, tPos, entryEnd);
        if (!fId) break;
        const fSize = readEbmlSize(bytes, fId.nextPos, entryEnd);
        if (!fSize || fSize.size < 0) break;

        const valStart = fSize.nextPos;
        const valEnd = Math.min(entryEnd, valStart + fSize.size);
        const valLen = valEnd - valStart;

        if (fId.id === 0x83) trackType = readEbmlUint(bytes, valStart, valLen);
        else if (fId.id === 0xd7) trackNumber = readEbmlUint(bytes, valStart, valLen);
        else if (fId.id === 0x536e) name = readUtf8(bytes, valStart, valLen);
        else if (fId.id === 0x22b59c) language = readUtf8(bytes, valStart, valLen);
        else if (fId.id === 0x22b59d) languageIetf = readUtf8(bytes, valStart, valLen);
        else if (fId.id === 0x86) codecId = readUtf8(bytes, valStart, valLen);
        else if (fId.id === 0x88) flagDefault = readEbmlUint(bytes, valStart, valLen);
        else if (fId.id === 0xb9) flagEnabled = readEbmlUint(bytes, valStart, valLen);

        tPos = valEnd;
      }

      if (trackType === 2) {
        const idx = tracks.length;
        const langCode = (languageIetf || language).trim().toLowerCase();
        const codec = formatMkvCodec(codecId);
        const mseMime = getMkvMseMime(codecId);
        tracks.push({
          index: idx,
          id: String(idx),
          label: buildAudioTrackLabel(idx, name, langCode, codec),
          language: formatAudioLanguage(langCode),
          languageCode: langCode,
          kind: '',
          codec,
          enabled: flagEnabled !== 0 && flagDefault !== 0 && !tracks.some((t) => t.enabled),
          containerType: 'mkv',
          containerTrackNumber: trackNumber,
          mseMime,
          mseSupported: checkMseMimeSupported(mseMime),
        });
      }
    }

    pos = entryEnd;
  }

  return tracks;
}

function findTracksSeekOffset(bytes: Uint8Array, start: number, end: number): number | null {
  let pos = start;
  while (pos < end) {
    const idInfo = readEbmlId(bytes, pos, end);
    if (!idInfo) break;
    const sizeInfo = readEbmlSize(bytes, idInfo.nextPos, end);
    if (!sizeInfo || sizeInfo.size < 0) break;

    const entryStart = sizeInfo.nextPos;
    const entryEnd = Math.min(end, entryStart + sizeInfo.size);

    if (idInfo.id === 0x4dbb) {
      // Seek element
      let seekId = 0;
      let seekPos: number | null = null;
      let sPos = entryStart;

      while (sPos < entryEnd) {
        const fId = readEbmlId(bytes, sPos, entryEnd);
        if (!fId) break;
        const fSize = readEbmlSize(bytes, fId.nextPos, entryEnd);
        if (!fSize || fSize.size < 0) break;
        const valStart = fSize.nextPos;
        const valEnd = Math.min(entryEnd, valStart + fSize.size);
        const valLen = valEnd - valStart;

        if (fId.id === 0x53ab) seekId = readEbmlUint(bytes, valStart, valLen);
        else if (fId.id === 0x53ac) seekPos = readEbmlUint(bytes, valStart, valLen);

        sPos = valEnd;
      }

      if (seekId === 0x1654ae6b && seekPos !== null) {
        return seekPos;
      }
    }

    pos = entryEnd;
  }
  return null;
}

async function parseMkvAudioTracks(reader: ByteReader): Promise<AudioTrackOption[]> {
  const initialLen = Math.min(reader.size, 2 * 1024 * 1024);
  const bytes = await reader.read(0, initialLen);
  if (bytes.length < 16) return [];

  let pos = 0;
  // Skip EBML header (0x1A45DFA3)
  const ebmlId = readEbmlId(bytes, pos, bytes.length);
  if (!ebmlId || ebmlId.id !== 0x1a45dfa3) return [];
  const ebmlSize = readEbmlSize(bytes, ebmlId.nextPos, bytes.length);
  if (!ebmlSize || ebmlSize.size < 0) return [];
  pos = ebmlSize.nextPos + ebmlSize.size;

  // Enter Segment (0x18538067)
  const segId = readEbmlId(bytes, pos, bytes.length);
  if (!segId || segId.id !== 0x18538067) return [];
  const segSize = readEbmlSize(bytes, segId.nextPos, bytes.length);
  if (!segSize) return [];

  const segmentDataStart = segSize.nextPos;
  const segmentScanEnd =
    segSize.size >= 0
      ? Math.min(bytes.length, segmentDataStart + segSize.size)
      : bytes.length;

  pos = segmentDataStart;
  let tracksSeekOffset: number | null = null;
  let iterations = 0;

  while (pos < segmentScanEnd && iterations < 128) {
    iterations++;
    const childId = readEbmlId(bytes, pos, segmentScanEnd);
    if (!childId) break;
    const childSize = readEbmlSize(bytes, childId.nextPos, segmentScanEnd);
    if (!childSize) break;

    const childStart = childSize.nextPos;
    if (childId.id === 0x1f43b675) {
      // Reached Cluster media frames; stop scanning initial buffer
      break;
    }

    if (childSize.size < 0) break;
    const childEnd = childStart + childSize.size;

    if (childId.id === 0x1654ae6b) {
      // Found Tracks element
      if (childEnd <= bytes.length) {
        return extractMkvTracksFromBuffer(bytes, childStart, childEnd);
      }
      if (childSize.size <= 4 * 1024 * 1024 && childEnd <= reader.size) {
        const tracksBytes = await reader.read(childStart, childSize.size);
        return extractMkvTracksFromBuffer(tracksBytes, 0, tracksBytes.length);
      }
      return [];
    }

    if (childId.id === 0x114d9b74 && childEnd <= bytes.length && tracksSeekOffset === null) {
      tracksSeekOffset = findTracksSeekOffset(bytes, childStart, childEnd);
    }

    pos = childEnd;
  }

  // Fallback: Tracks was placed later in the file, jump directly using SeekHead offset
  if (tracksSeekOffset !== null) {
    const absPos = segmentDataStart + tracksSeekOffset;
    if (absPos + 16 < reader.size) {
      const probeLen = Math.min(512 * 1024, reader.size - absPos);
      const targetBytes = await reader.read(absPos, probeLen);
      const tId = readEbmlId(targetBytes, 0, targetBytes.length);
      if (tId && tId.id === 0x1654ae6b) {
        const tSize = readEbmlSize(targetBytes, tId.nextPos, targetBytes.length);
        if (tSize && tSize.size > 0 && tSize.size <= 4 * 1024 * 1024) {
          if (tSize.nextPos + tSize.size <= targetBytes.length) {
            return extractMkvTracksFromBuffer(
              targetBytes,
              tSize.nextPos,
              tSize.nextPos + tSize.size
            );
          }
          const fullTracks = await reader.read(absPos + tSize.nextPos, tSize.size);
          return extractMkvTracksFromBuffer(fullTracks, 0, fullTracks.length);
        }
      }
    }
  }

  return [];
}

async function inspectWithReader(reader: ByteReader): Promise<AudioTrackOption[]> {
  try {
    if (reader.size < 16) return [];
    const probe = await reader.read(0, Math.min(16, reader.size));
    if (probe.length < 12) return [];

    // EBML / MKV / WebM magic: 1A 45 DF A3
    if (
      probe[0] === 0x1a &&
      probe[1] === 0x45 &&
      probe[2] === 0xdf &&
      probe[3] === 0xa3
    ) {
      return await parseMkvAudioTracks(reader);
    }

    // ISO BMFF / MP4 / MOV: box type at bytes 4..8
    const boxType = readAscii(probe, 4, 4);
    if (
      boxType === 'ftyp' ||
      boxType === 'moov' ||
      boxType === 'mdat' ||
      boxType === 'free' ||
      boxType === 'skip' ||
      boxType === 'wide' ||
      boxType === 'pnot'
    ) {
      return await parseMp4AudioTracks(reader);
    }
  } catch {
    return [];
  }
  return [];
}

export function createFileByteReader(file: File): ByteReader {
  return {
    size: file.size,
    read: async (offset: number, length: number) => {
      const end = Math.min(file.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const buf = await file.slice(offset, end).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

export async function createRangeByteReader(url: string): Promise<ByteReader | null> {
  try {
    // Probe 1 byte first to discover exact Content-Length from Content-Range safely
    const headProbe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const contentRange = headProbe.headers.get('Content-Range') || '';
    if (headProbe.body && typeof headProbe.body.cancel === 'function') {
      headProbe.body.cancel().catch(() => {});
    }
    if (headProbe.status !== 206) return null;
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange);
    if (!match) return null;
    const totalSize = parseInt(match[1], 10);
    if (!totalSize || totalSize < 16) return null;

    return {
      size: totalSize,
      read: async (offset: number, length: number) => {
        const end = Math.min(totalSize - 1, offset + length - 1);
        if (offset > end) return new Uint8Array(0);
        const res = await fetch(url, {
          headers: { Range: `bytes=${offset}-${end}` },
        });
        if (!res.ok) return new Uint8Array(0);
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
      },
    };
  } catch {
    return null;
  }
}

export async function inspectLocalVideoAudioTracks(file: File): Promise<AudioTrackOption[]> {
  return inspectWithReader(createFileByteReader(file));
}

export async function inspectStreamAudioTracks(url: string): Promise<AudioTrackOption[]> {
  const reader = await createRangeByteReader(url);
  if (!reader) return [];
  return inspectWithReader(reader);
}