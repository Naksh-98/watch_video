'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, FolderOpen, Subtitles, AlertTriangle, Rewind, FastForward, Settings, RefreshCw, MessageSquare, X, Download, Check, Sliders, Palette, RotateCcw, Type, AudioLines, Copy, Info, Upload } from 'lucide-react';
import { SyncAction, Reaction, ChatMessage, SubtitleSyncData } from '../lib/types';
import {
  AudioTrackOption,
  VideoElementWithAudioTracks,
  extractNativeAudioTracks,
  inspectLocalVideoAudioTracks,
  inspectStreamAudioTracks,
} from '../lib/audioTracks';
import {
  MseAudioTrackController,
  isTimeBufferedOnAudio,
  openAudioTrackSource,
} from '../lib/mseAudioPlayer';
import { ChatBox } from './ChatBox';

export interface SubtitleStyle {
  fontSize: number; // in px
  bgColor: string; // hex
  bgOpacity: number; // 0 to 100
  textColor: string; // hex
  textShadow: boolean;
  bottomOffset: number; // px from bottom
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 18,
  bgColor: '#000000',
  bgOpacity: 85,
  textColor: '#ffffff',
  textShadow: true,
  bottomOffset: 32,
};

const SUBTITLE_STORAGE_KEY = 'sync_cinema_subtitle_style_v1';

export function hexToRgba(hex: string, opacity: number): string {
  if (!hex) return `rgba(0, 0, 0, ${opacity / 100})`;
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const intVal = parseInt(clean, 16);
  if (isNaN(intVal)) return `rgba(0, 0, 0, ${opacity / 100})`;
  const r = (intVal >> 16) & 255;
  const g = (intVal >> 8) & 255;
  const b = intVal & 255;
  const alpha = Math.max(0, Math.min(100, opacity)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function parseVTT(vttText: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  if (!vttText) return cues;
  const blocks = vttText.replace(/\r\n/g, '\n').split(/\n\n+/);
  const timeRegex = /(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})[.,](\d{3})/;

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = timeRegex.exec(lines[i]);
      if (match) {
        const startH = match[1] ? parseInt(match[1], 10) : 0;
        const startM = parseInt(match[2], 10);
        const startS = parseInt(match[3], 10);
        const startMs = parseInt(match[4], 10);
        const start = startH * 3600 + startM * 60 + startS + startMs / 1000;

        const endH = match[5] ? parseInt(match[5], 10) : 0;
        const endM = parseInt(match[6], 10);
        const endS = parseInt(match[7], 10);
        const endMs = parseInt(match[8], 10);
        const end = endH * 3600 + endM * 60 + endS + endMs / 1000;

        const text = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
        if (text) {
          cues.push({ start, end, text });
        }
        break;
      }
    }
  }
  return cues;
}

interface VideoPlayerProps {
  roomCode?: string;
  movieFilename: string | null;
  onSendSyncAction: (action: 'play' | 'pause' | 'seek', time: number) => void;
  onSendHeartbeat: (time: number, isPlaying: boolean, isBuffering: boolean) => void;
  onSendBufferChange: (isBuffering: boolean) => void;
  incomingAction: SyncAction | null;
  externalJumpTime: number | null;
  reactions: Reaction[];
  chatMessages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onOpenChatTab: () => void;
  userName: string;
  syncedSubtitle?: SubtitleSyncData | null;
  onSendSubtitle?: (vttText: string, filename: string) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  roomCode,
  movieFilename,
  onSendSyncAction,
  onSendHeartbeat,
  onSendBufferChange,
  incomingAction,
  externalJumpTime,
  reactions,
  chatMessages,
  onSendMessage,
  onOpenChatTab,
  userName,
  syncedSubtitle,
  onSendSubtitle,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
  const [localFileName, setLocalFileName] = useState<string | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [subtitleName, setSubtitleName] = useState<string | null>(null);
  const [subtitleSyncNotice, setSubtitleSyncNotice] = useState<string | null>(null);
  const [subCues, setSubCues] = useState<SubtitleCue[]>([]);
  const [activeCueText, setActiveCueText] = useState<string | null>(null);

  // Subtitle Style Customization State (with localStorage persistence)
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);
  const [showSubStyleModal, setShowSubStyleModal] = useState(false);

  // Audio Track Selection State (Native dual-audio + container inspection + MSE switcher + external audio fallback)
  const auxAudioRef = useRef<HTMLAudioElement | null>(null);
  const localVideoFileRef = useRef<File | null>(null);
  const mseControllerRef = useRef<MseAudioTrackController | null>(null);
  const mseSwitchIdRef = useRef(0);
  const mseActiveTrackIndexRef = useRef<number | null>(null);
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const [audioTracks, setAudioTracks] = useState<AudioTrackOption[]>([]);
  const [detectedContainerTracks, setDetectedContainerTracks] = useState<AudioTrackOption[]>([]);
  const [selectedAudioTrackIndex, setSelectedAudioTrackIndex] = useState<number>(0);
  const [audioTracksSupported, setAudioTracksSupported] = useState<boolean | null>(null);
  const [mseActiveTrackIndex, setMseActiveTrackIndex] = useState<number | null>(null);
  const [mseLoadingTrackIndex, setMseLoadingTrackIndex] = useState<number | null>(null);
  const [mseErrorMsg, setMseErrorMsg] = useState<string | null>(null);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [copiedFlagNotice, setCopiedFlagNotice] = useState(false);
  const [externalAudioUrl, setExternalAudioUrl] = useState<string | null>(null);
  const [externalAudioName, setExternalAudioName] = useState<string | null>(null);
  const audioNoticeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showQualityMsg, setShowQualityMsg] = useState(false);
  const [showChatOverlay, setShowChatOverlay] = useState(false);
  const [latestPopupMsg, setLatestPopupMsg] = useState<ChatMessage | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const popupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Prevent sync echo feedback loops
  const isIncomingUpdateRef = useRef(false);

  // Load subtitle style preference from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SUBTITLE_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setSubStyle((prev) => ({ ...prev, ...parsed }));
      }
    } catch (e) {
      console.warn('Could not read subtitle style from localStorage', e);
    }
  }, []);

  const updateSubStyle = (updates: Partial<SubtitleStyle>) => {
    setSubStyle((prev) => {
      const next = { ...prev, ...updates };
      try {
        localStorage.setItem(SUBTITLE_STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.warn('Could not save subtitle style to localStorage', e);
      }
      return next;
    });
  };

  const resetSubStyle = () => {
    setSubStyle(DEFAULT_SUBTITLE_STYLE);
    try {
      localStorage.removeItem(SUBTITLE_STORAGE_KEY);
    } catch (e) { }
  };

  // Auto-load partner or room synced subtitles
  useEffect(() => {
    if (!syncedSubtitle || !syncedSubtitle.vttText) return;

    try {
      const cues = parseVTT(syncedSubtitle.vttText);
      setSubCues(cues);

      // Prefer real HTTP URL from server (essential for iOS Safari), fallback to Blob
      const url = syncedSubtitle.url || URL.createObjectURL(new Blob([syncedSubtitle.vttText], { type: 'text/vtt' }));
      setSubtitleUrl(url);
      setSubtitleName(syncedSubtitle.filename || 'synced_subtitles.vtt');

      if (syncedSubtitle.senderName && syncedSubtitle.senderName !== userName) {
        setSubtitleSyncNotice(`✨ Subtitles synced by ${syncedSubtitle.senderName}`);
        setTimeout(() => setSubtitleSyncNotice(null), 4000);
      }
    } catch (err) {
      console.error('Failed to parse synced subtitle:', err);
    }
  }, [syncedSubtitle, userName]);

  // Initial fetch for existing room subtitles if partner joined after upload
  useEffect(() => {
    if (!roomCode || subtitleUrl) return;

    fetch(`/api/room/subtitle?room=${encodeURIComponent(roomCode.trim().toLowerCase())}`)
      .then((res) => {
        if (res.ok) return res.text();
        throw new Error('No room subtitles');
      })
      .then((vttText) => {
        if (vttText) {
          const cues = parseVTT(vttText);
          setSubCues(cues);
          setSubtitleUrl(`/api/room/subtitle?room=${encodeURIComponent(roomCode.trim().toLowerCase())}`);
          setSubtitleName('Room Subtitles.vtt');
        }
      })
      .catch(() => { });
  }, [roomCode, subtitleUrl]);

  // Keep native track in 'hidden' mode so browser does not draw duplicate captions behind custom overlay
  useEffect(() => {
    if (videoRef.current && subtitleUrl) {
      const video = videoRef.current;
      const timer = setTimeout(() => {
        if (video.textTracks && video.textTracks.length > 0) {
          for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = 'hidden';
          }
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [subtitleUrl]);

  // Determine active video source (Local file -> Direct URL -> Server HTTP 206 Stream)
  const videoSrc = localFileUrl || (
    movieFilename ? (
      movieFilename.startsWith('http://') || movieFilename.startsWith('https://')
        ? movieFilename
        : `/api/movies/stream/${encodeURIComponent(movieFilename)}`
    ) : null
  );

  const showAudioToast = useCallback((msg: string) => {
    setAudioNotice(msg);
    if (audioNoticeTimeoutRef.current) {
      clearTimeout(audioNoticeTimeoutRef.current);
    }
    audioNoticeTimeoutRef.current = setTimeout(() => {
      setAudioNotice(null);
    }, 3000);
  }, []);

  const destroyMseController = useCallback(() => {
    mseSwitchIdRef.current += 1;
    if (mseControllerRef.current) {
      mseControllerRef.current.destroy();
      mseControllerRef.current = null;
    }
    mseActiveTrackIndexRef.current = null;
    setMseActiveTrackIndex(null);
    setMseLoadingTrackIndex(null);
    setMseErrorMsg(null);
  }, []);

  const refreshNativeAudioTracks = useCallback(() => {
    const result = extractNativeAudioTracks(videoRef.current);
    setAudioTracksSupported(result.supported);
    setAudioTracks(result.tracks);
    if (result.supported) {
      setSelectedAudioTrackIndex(result.selectedIndex);
    }
  }, []);

  const externalAudioUrlRef = useRef<string | null>(null);
  useEffect(() => {
    externalAudioUrlRef.current = externalAudioUrl;
  }, [externalAudioUrl]);

  useEffect(() => {
    volumeRef.current = volume;
    isMutedRef.current = isMuted;
  }, [volume, isMuted]);

  // Reset & inspect audio tracks whenever videoSrc changes
  useEffect(() => {
    setAudioTracks([]);
    setDetectedContainerTracks([]);
    setSelectedAudioTrackIndex(0);
    setAudioTracksSupported(null);
    destroyMseController();

    if (externalAudioUrlRef.current) {
      if (externalAudioUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(externalAudioUrlRef.current);
      }
      setExternalAudioUrl(null);
      setExternalAudioName(null);
    }

    if (!videoSrc) return;

    let cancelled = false;
    const video = videoRef.current as VideoElementWithAudioTracks | null;
    const trackList = video?.audioTracks;

    const onTracksChanged = () => {
      if (!cancelled) {
        refreshNativeAudioTracks();
      }
    };

    if (trackList && typeof trackList.addEventListener === 'function') {
      trackList.addEventListener('addtrack', onTracksChanged);
      trackList.addEventListener('removetrack', onTracksChanged);
      trackList.addEventListener('change', onTracksChanged);
    }

    // Also inspect local or same-origin stream container headers as a reliable detector
    // when the browser hides video.audioTracks (e.g. default Chrome/Edge).
    const applyDetectedTracks = (found: AudioTrackOption[]) => {
      if (cancelled) return;
      setDetectedContainerTracks(found);
      if (found.length > 0 && mseActiveTrackIndexRef.current === null) {
        const defIdx = Math.max(0, found.findIndex((t) => t.enabled));
        setSelectedAudioTrackIndex(defIdx);
      }
    };

    if (localFileUrl && videoSrc === localFileUrl && localVideoFileRef.current) {
      inspectLocalVideoAudioTracks(localVideoFileRef.current).then(applyDetectedTracks);
    } else if (videoSrc.startsWith('/api/movies/stream/')) {
      inspectStreamAudioTracks(videoSrc).then(applyDetectedTracks);
    }

    return () => {
      cancelled = true;
      if (trackList && typeof trackList.removeEventListener === 'function') {
        trackList.removeEventListener('addtrack', onTracksChanged);
        trackList.removeEventListener('removetrack', onTracksChanged);
        trackList.removeEventListener('change', onTracksChanged);
      }
    };
  }, [videoSrc, localFileUrl, refreshNativeAudioTracks, destroyMseController]);

  // Manage <audio> src imperatively for external audio so it never overwrites MediaSource blob URLs
  useEffect(() => {
    const auxAudio = auxAudioRef.current;
    if (!auxAudio) return;
    if (externalAudioUrl) {
      auxAudio.src = externalAudioUrl;
      auxAudio.load();
    } else if (mseActiveTrackIndexRef.current === null && !mseControllerRef.current) {
      auxAudio.pause();
      auxAudio.removeAttribute('src');
      auxAudio.load();
    }
  }, [externalAudioUrl]);

  // Keep native video muted when external or MSE audio is active, and sync volume/mute
  useEffect(() => {
    const video = videoRef.current;
    const auxAudio = auxAudioRef.current;
    const hasAuxAudio = Boolean(externalAudioUrl) || mseActiveTrackIndex !== null;
    if (video) {
      video.volume = volume;
      video.muted = hasAuxAudio ? true : isMuted;
    }
    if (auxAudio) {
      auxAudio.volume = volume;
      auxAudio.muted = isMuted;
    }
  }, [externalAudioUrl, mseActiveTrackIndex, isMuted, volume]);

  const handleUserActivity = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying && !showSubStyleModal && !showAudioModal) {
        setShowControls(false);
      }
    }, 3500);
  }, [isPlaying, showSubStyleModal, showAudioModal]);

useEffect(() => {
  const handleFullscreenChange = () => {
    setIsFullscreen(!!document.fullscreenElement);
  };
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  return () => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (popupTimeoutRef.current) clearTimeout(popupTimeoutRef.current);
    if (audioNoticeTimeoutRef.current) clearTimeout(audioNoticeTimeoutRef.current);
    if (mseControllerRef.current) {
      mseControllerRef.current.destroy();
      mseControllerRef.current = null;
    }
    if (externalAudioUrlRef.current && externalAudioUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(externalAudioUrlRef.current);
    }
  };
}, []);

// Show subtitle popup when a new message arrives
useEffect(() => {
  if (chatMessages.length === 0) return;
  const latest = chatMessages[chatMessages.length - 1];

  // Don't show popup if chat is already open, or if the current user sent the message
  if (showChatOverlay || latest.senderName === userName) return;

  setLatestPopupMsg(latest);
  if (popupTimeoutRef.current) clearTimeout(popupTimeoutRef.current);
  popupTimeoutRef.current = setTimeout(() => {
    setLatestPopupMsg(null);
  }, 4000);
}, [chatMessages, showChatOverlay, userName]);

// Handle local file selection (Ultimate Zero Buffering mode)
const handleLocalFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (file) {
    if (localFileUrl && localFileUrl.startsWith('blob:')) {
      URL.revokeObjectURL(localFileUrl);
    }
    localVideoFileRef.current = file;
    const url = URL.createObjectURL(file);
    setLocalFileUrl(url);
    setLocalFileName(file.name);
  }
  e.target.value = '';
};

const defaultContainerTrackIndex = Math.max(
  0,
  detectedContainerTracks.findIndex((t) => t.enabled)
);

// Switch embedded audio track (Safari & Chromium with experimental flag)
const handleSelectEmbeddedTrack = (trackIndex: number) => {
  destroyMseController();
  if (externalAudioUrl) {
    if (auxAudioRef.current) auxAudioRef.current.pause();
    if (externalAudioUrl.startsWith('blob:')) {
      URL.revokeObjectURL(externalAudioUrl);
    }
    setExternalAudioUrl(null);
    setExternalAudioName(null);
  }

  const media = videoRef.current as VideoElementWithAudioTracks | null;
  if (!media || !media.audioTracks || media.audioTracks.length === 0) return;

  media.muted = isMuted;
  for (let i = 0; i < media.audioTracks.length; i++) {
    media.audioTracks[i].enabled = i === trackIndex;
  }

  // Flush buffered audio pipeline cleanly without emitting a partner seek
  if (media.readyState >= 2 && !media.seeking && !Number.isNaN(media.currentTime)) {
    const wasPlaying = !media.paused;
    const t = media.currentTime;
    media.currentTime = t;
    if (wasPlaying && media.paused) {
      media.play().catch(() => { });
    }
  }

  setSelectedAudioTrackIndex(trackIndex);
  refreshNativeAudioTracks();
  const chosen = audioTracks.find((t) => t.index === trackIndex);
  showAudioToast(`Audio: ${chosen ? chosen.label : `Track ${trackIndex + 1}`}`);
};

// Switch embedded audio track in standard Chrome/Edge via in-browser MSE remuxing
const handleSelectMseTrack = async (track: AudioTrackOption) => {
  if (externalAudioUrl) {
    if (auxAudioRef.current) auxAudioRef.current.pause();
    if (externalAudioUrl.startsWith('blob:')) {
      URL.revokeObjectURL(externalAudioUrl);
    }
    setExternalAudioUrl(null);
    setExternalAudioName(null);
  }

  // Returning to the container's default track plays directly via native <video>
  if (track.index === defaultContainerTrackIndex) {
    destroyMseController();
    if (auxAudioRef.current) {
      auxAudioRef.current.pause();
      auxAudioRef.current.removeAttribute('src');
      auxAudioRef.current.load();
    }
    setSelectedAudioTrackIndex(track.index);
    if (videoRef.current) {
      videoRef.current.muted = isMutedRef.current;
    }
    showAudioToast(`Audio: ${track.label}`);
    return;
  }

  if (mseActiveTrackIndex === track.index && mseControllerRef.current) {
    return;
  }

  if (!track.mseSupported) {
    setMseErrorMsg(`${track.label} codec is not supported by this browser's MediaSource.`);
    return;
  }

  const auxAudio = auxAudioRef.current;
  const video = videoRef.current;
  if (!auxAudio || !video || !videoSrc) return;

  destroyMseController();
  const switchId = mseSwitchIdRef.current;
  setMseLoadingTrackIndex(track.index);
  setMseErrorMsg(null);

  const localFile =
    localFileUrl && videoSrc === localFileUrl ? localVideoFileRef.current : null;
  const streamUrl =
    videoSrc.startsWith('/api/movies/stream/') ? videoSrc : null;

  try {
    const source = await openAudioTrackSource(
      { file: localFile, url: streamUrl },
      track.containerType,
      track.index
    );

    if (switchId !== mseSwitchIdRef.current) return;

    if (!source) {
      setMseLoadingTrackIndex(null);
      setMseErrorMsg(
        `Could not prepare "${track.label}" for in-browser switching. Try loading an External Audio file.`
      );
      return;
    }

    const controller = new MseAudioTrackController(
      auxAudio,
      source,
      video.currentTime || 0,
      () => {
        if (switchId !== mseSwitchIdRef.current) {
          controller.destroy();
          return;
        }
        mseActiveTrackIndexRef.current = track.index;
        setMseActiveTrackIndex(track.index);
        setMseLoadingTrackIndex(null);
        setSelectedAudioTrackIndex(track.index);

        const v = videoRef.current;
        const a = auxAudioRef.current;
        if (v && a) {
          a.volume = volumeRef.current;
          a.muted = isMutedRef.current;
          v.muted = true;
          if (
            Math.abs(a.currentTime - v.currentTime) > 0.25 &&
            isTimeBufferedOnAudio(a, v.currentTime)
          ) {
            a.currentTime = v.currentTime;
          }
          if (!v.paused) {
            a.play().catch(() => { });
          }
        }
        showAudioToast(`Audio: ${track.label}`);
      },
      (errMsg) => {
        if (switchId !== mseSwitchIdRef.current) return;
        controller.destroy();
        if (mseControllerRef.current === controller) {
          mseControllerRef.current = null;
        }
        mseActiveTrackIndexRef.current = null;
        setMseActiveTrackIndex(null);
        setMseLoadingTrackIndex(null);
        setMseErrorMsg(errMsg || `Failed to switch to ${track.label}`);
        if (videoRef.current && !externalAudioUrlRef.current) {
          videoRef.current.muted = isMutedRef.current;
        }
      }
    );

    if (switchId !== mseSwitchIdRef.current) {
      controller.destroy();
      return;
    }
    mseControllerRef.current = controller;
  } catch (err) {
    if (switchId !== mseSwitchIdRef.current) return;
    setMseLoadingTrackIndex(null);
    setMseErrorMsg(
      err instanceof Error ? err.message : `Failed to initialize ${track.label}`
    );
  }
};

// Load separate external audio file synced to the video
const handleExternalAudioSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  destroyMseController();
  if (externalAudioUrl && externalAudioUrl.startsWith('blob:')) {
    URL.revokeObjectURL(externalAudioUrl);
  }
  const url = URL.createObjectURL(file);
  setExternalAudioUrl(url);
  setExternalAudioName(file.name);
  showAudioToast(`External Audio: ${file.name}`);
};

const handleRemoveExternalAudio = () => {
  destroyMseController();
  if (auxAudioRef.current) {
    auxAudioRef.current.pause();
  }
  if (externalAudioUrl && externalAudioUrl.startsWith('blob:')) {
    URL.revokeObjectURL(externalAudioUrl);
  }
  setExternalAudioUrl(null);
  setExternalAudioName(null);
  if (!audioTracksSupported) {
    setSelectedAudioTrackIndex(defaultContainerTrackIndex);
  }
  if (videoRef.current) {
    videoRef.current.muted = isMuted;
  }
  showAudioToast('Switched back to video audio');
};

// Handle Subtitle file upload (.vtt or .srt) & broadcast to partner
const handleSubtitleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    let text = reader.result as string;
    let vttText = text;
    if (!file.name.endsWith('.vtt')) {
      // Standard SRT to VTT converter in-browser
      vttText = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }
    const cues = parseVTT(vttText);
    setSubCues(cues);

    const blob = new Blob([vttText], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    setSubtitleUrl(url);
    setSubtitleName(file.name);

    // Broadcast subtitle directly to partner so she doesn't need to do anything!
    if (onSendSubtitle) {
      onSendSubtitle(vttText, file.name);
    }
  };
  reader.readAsText(file);
};

// Download the currently active subtitle file
const handleDownloadSubtitle = (e: React.MouseEvent) => {
  e.stopPropagation();
  if (!subtitleUrl) return;
  const a = document.createElement('a');
  a.href = subtitleUrl;
  a.download = subtitleName || 'subtitles.vtt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

// Play / Pause Toggle
const togglePlay = useCallback((e?: React.MouseEvent) => {
  e?.stopPropagation();
  const video = videoRef.current;
  if (!video) return;

  if (video.paused) {
    video.play().catch(() => { });
    onSendSyncAction('play', video.currentTime);
  } else {
    video.pause();
    onSendSyncAction('pause', video.currentTime);
  }
}, [onSendSyncAction]);

const skip = (seconds: number, e?: React.MouseEvent) => {
  e?.stopPropagation();
  const video = videoRef.current;
  if (!video) return;
  const newTime = Math.max(0, Math.min(video.currentTime + seconds, duration));
  video.currentTime = newTime;
  setCurrentTime(newTime);
  onSendSyncAction('seek', newTime);
  handleUserActivity();
};

const handleForceSync = (e?: React.MouseEvent) => {
  e?.stopPropagation();
  const video = videoRef.current;
  if (!video) return;
  onSendSyncAction('seek', video.currentTime);
  if (!video.paused) {
    onSendSyncAction('play', video.currentTime);
  }
};

// Handle Progress Bar Seek
const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
  const video = videoRef.current;
  if (!video) return;
  const target = parseFloat(e.target.value);
  video.currentTime = target;
  setCurrentTime(target);
  onSendSyncAction('seek', target);
  handleUserActivity();
};

// Handle Incoming Remote Sync Action from Partner
useEffect(() => {
  const video = videoRef.current;
  if (!video || !incomingAction) return;

  isIncomingUpdateRef.current = true;

  if (incomingAction.action === 'seek') {
    video.currentTime = incomingAction.time;
    setCurrentTime(incomingAction.time);
  } else if (incomingAction.action === 'play') {
    if (Math.abs(video.currentTime - incomingAction.time) > 1) {
      video.currentTime = incomingAction.time;
    }
    video.play().catch(() => { });
    setIsPlaying(true);
  } else if (incomingAction.action === 'pause') {
    if (Math.abs(video.currentTime - incomingAction.time) > 1) {
      video.currentTime = incomingAction.time;
    }
    video.pause();
    setIsPlaying(false);
  }

  setTimeout(() => {
    isIncomingUpdateRef.current = false;
  }, 250);
}, [incomingAction]);

// Handle "Jump to Partner" External Button Click
useEffect(() => {
  const video = videoRef.current;
  if (!video || externalJumpTime === null) return;

  isIncomingUpdateRef.current = true;
  video.currentTime = externalJumpTime;
  setCurrentTime(externalJumpTime);

  setTimeout(() => {
    isIncomingUpdateRef.current = false;
  }, 250);
}, [externalJumpTime]);

// Heartbeat loop every 1 second
useEffect(() => {
  const interval = setInterval(() => {
    const video = videoRef.current;
    if (video) {
      onSendHeartbeat(video.currentTime, !video.paused, isBuffering);
    }
  }, 1000);
  return () => clearInterval(interval);
}, [onSendHeartbeat, isBuffering]);

// Video Native Event Handlers
const onTimeUpdate = () => {
  if (videoRef.current) {
    const time = videoRef.current.currentTime;
    setCurrentTime(time);
    if (subCues.length > 0) {
      const cue = subCues.find((c) => time >= c.start && time <= c.end);
      setActiveCueText(cue ? cue.text : null);
    } else if (activeCueText) {
      setActiveCueText(null);
    }

    // Keep external or MSE audio locked in sync with video
    const auxAudio = auxAudioRef.current;
    const mseActive = mseActiveTrackIndexRef.current !== null;
    if (mseControllerRef.current && mseActive) {
      mseControllerRef.current.ensureBufferedAt(time);
    }
    if (auxAudio && (externalAudioUrl || mseActive) && !videoRef.current.paused) {
      if (Math.abs(auxAudio.currentTime - time) > 0.3) {
        if (!mseActive || isTimeBufferedOnAudio(auxAudio, time)) {
          auxAudio.currentTime = time;
        }
      }
      if (mseActive && auxAudio.paused && isTimeBufferedOnAudio(auxAudio, time)) {
        auxAudio.play().catch(() => { });
      }
    }
  }
};

const onLoadedMetadata = () => {
  if (videoRef.current) {
    const hasAuxAudio = Boolean(externalAudioUrl) || mseActiveTrackIndexRef.current !== null;
    setDuration(videoRef.current.duration);
    videoRef.current.volume = volume;
    videoRef.current.muted = hasAuxAudio ? true : isMuted;
    refreshNativeAudioTracks();
  }
};

const onSeekedHandler = () => {
  const video = videoRef.current;
  const auxAudio = auxAudioRef.current;
  if (!video) return;
  const mseActive = mseActiveTrackIndexRef.current !== null;
  if (mseControllerRef.current && mseActive) {
    mseControllerRef.current.seekTo(video.currentTime);
  } else if (auxAudio && externalAudioUrl) {
    auxAudio.currentTime = video.currentTime;
  }
};

const onPlayHandler = () => {
  setIsPlaying(true);
  const video = videoRef.current;
  const auxAudio = auxAudioRef.current;
  const mseActive = mseActiveTrackIndexRef.current !== null;
  if (video && auxAudio && (externalAudioUrl || mseActive)) {
    if (!mseActive || isTimeBufferedOnAudio(auxAudio, video.currentTime)) {
      auxAudio.currentTime = video.currentTime;
      auxAudio.play().catch(() => { });
    } else if (mseControllerRef.current) {
      mseControllerRef.current.seekTo(video.currentTime);
    }
  }
};

const onPauseHandler = () => {
  setIsPlaying(false);
  setShowControls(true);
  if (auxAudioRef.current) {
    auxAudioRef.current.pause();
  }
};

const onWaitingHandler = () => {
  setIsBuffering(true);
  onSendBufferChange(true);
  if (auxAudioRef.current) {
    auxAudioRef.current.pause();
  }
};

const onPlayingHandler = () => {
  setIsBuffering(false);
  onSendBufferChange(false);
  const video = videoRef.current;
  const auxAudio = auxAudioRef.current;
  const mseActive = mseActiveTrackIndexRef.current !== null;
  if (video && auxAudio && (externalAudioUrl || mseActive) && !video.paused) {
    if (!mseActive || isTimeBufferedOnAudio(auxAudio, video.currentTime)) {
      auxAudio.currentTime = video.currentTime;
      auxAudio.play().catch(() => { });
    }
  }
};

const toggleFullscreen = (e?: React.MouseEvent) => {
  e?.stopPropagation();
  if (!containerRef.current) return;
  if (!document.fullscreenElement) {
    containerRef.current.requestFullscreen().catch(() => { });
  } else {
    document.exitFullscreen().catch(() => { });
  }
};

const showQualityNotice = (e?: React.MouseEvent) => {
  e?.stopPropagation();
  setShowQualityMsg(true);
  setTimeout(() => setShowQualityMsg(false), 3000);
};

const toggleMute = () => {
  const nextMuted = !isMuted;
  setIsMuted(nextMuted);
  const auxActive = Boolean(externalAudioUrl) || mseActiveTrackIndexRef.current !== null;
  if (auxActive) {
    if (videoRef.current) videoRef.current.muted = true;
    if (auxAudioRef.current) auxAudioRef.current.muted = nextMuted;
  } else if (videoRef.current) {
    videoRef.current.muted = nextMuted;
  }
};

const effectiveEmbeddedTracks =
  audioTracks.length > 0 ? audioTracks : detectedContainerTracks;
const hasMultipleAudio = effectiveEmbeddedTracks.length > 1;
const displayedAudioTrackIndex =
  mseActiveTrackIndex !== null ? mseActiveTrackIndex : selectedAudioTrackIndex;
const activeEmbeddedTrack =
  audioTracks.find((t) => t.index === displayedAudioTrackIndex) ||
  effectiveEmbeddedTracks.find((t) => t.index === displayedAudioTrackIndex) ||
  effectiveEmbeddedTracks[displayedAudioTrackIndex] ||
  effectiveEmbeddedTracks[0];
const activeAudioBadgeText = externalAudioUrl
  ? 'EXT'
  : hasMultipleAudio && activeEmbeddedTrack?.languageCode
    ? activeEmbeddedTrack.languageCode.slice(0, 2).toUpperCase()
    : hasMultipleAudio
      ? String(effectiveEmbeddedTracks.length)
      : null;

return (
  <div className="flex flex-col gap-2">
    {/* Video Container */}
    <div
      ref={containerRef}
      className="relative bg-black rounded-2xl overflow-hidden aspect-video border border-neutral-800 shadow-2xl flex items-center justify-center group select-none"
      onMouseMove={handleUserActivity}
      onTouchStart={handleUserActivity}
      onClick={handleUserActivity}
      onMouseLeave={() => { if (isPlaying && !showSubStyleModal && !showAudioModal) setShowControls(false); }}
    >
      {videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onLoadedData={refreshNativeAudioTracks}
          onCanPlay={refreshNativeAudioTracks}
          onSeeked={onSeekedHandler}
          onPlay={onPlayHandler}
          onPause={onPauseHandler}
          onWaiting={onWaitingHandler}
          onPlaying={onPlayingHandler}
          playsInline
          className="w-full h-full object-contain cursor-pointer"
          onClick={togglePlay}
        >
          {subtitleUrl && (
            <track key={subtitleUrl} src={subtitleUrl} kind="subtitles" srcLang="en" label="English" default />
          )}
        </video>
      ) : (
        <div className="flex flex-col items-center justify-center p-6 text-center text-neutral-500">
          <AlertTriangle className="w-12 h-12 text-rose-500/40 mb-3" />
          <p className="text-white font-medium text-sm">No Video Selected</p>
          <p className="text-xs text-neutral-400 mt-1 max-w-sm">
            Choose a movie from the Movie Library below, or pick a local file from your device for 100% zero-buffering!
          </p>
        </div>
      )}

      {/* Synced Auxiliary Audio Element (MSE switched embedded track or external audio file) */}
      <audio
        ref={auxAudioRef}
        className="hidden"
        onLoadedMetadata={() => {
          if (!externalAudioUrlRef.current) return;
          const video = videoRef.current;
          const auxAudio = auxAudioRef.current;
          if (!auxAudio) return;
          auxAudio.volume = volumeRef.current;
          auxAudio.muted = isMutedRef.current;
          if (video) {
            auxAudio.currentTime = video.currentTime;
            if (!video.paused) {
              auxAudio.play().catch(() => { });
            }
          }
        }}
      />

      {/* Floating Audio Track Switched Notification */}
      {audioNotice && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 flex justify-center pointer-events-none z-30 animate-in fade-in slide-in-from-top-3 duration-300">
          <div className="bg-amber-600/95 text-white font-semibold text-xs sm:text-sm px-4 py-2 rounded-full shadow-2xl backdrop-blur-md border border-amber-400/40 flex items-center gap-2">
            <AudioLines className="w-4 h-4 text-amber-100" />
            <span className="truncate max-w-[260px] sm:max-w-md">{audioNotice}</span>
          </div>
        </div>
      )}

      {/* Floating Partner Reaction Emojis */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
        {reactions.map((reaction) => (
          <div
            key={reaction.id}
            className="absolute bottom-10 right-10 animate-bounce text-4xl sm:text-5xl"
            style={{
              animationDuration: '1.8s',
              right: `${20 + (Math.random() * 40)}%`,
            }}
          >
            {reaction.emoji}
          </div>
        ))}
      </div>

      {/* Floating Subtitle Synced Notification */}
      {subtitleSyncNotice && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 flex justify-center pointer-events-none z-30 animate-in fade-in slide-in-from-top-3 duration-300">
          <div className="bg-blue-600/95 text-white font-semibold text-xs sm:text-sm px-4 py-2 rounded-full shadow-2xl backdrop-blur-md border border-blue-400/40 flex items-center gap-2">
            <Subtitles className="w-4 h-4 text-blue-200" />
            <span>{subtitleSyncNotice}</span>
          </div>
        </div>
      )}

      {/* Universal React Subtitle Overlay (100% reliable on iPhone & all browsers) */}
      {activeCueText && (
        <div
          className="absolute inset-x-4 sm:inset-x-12 flex justify-center pointer-events-none z-20"
          style={{ bottom: `${subStyle.bottomOffset || 32}px` }}
        >
          <span
            className="font-semibold px-4 py-1.5 rounded-xl border border-white/10 text-center max-w-2xl leading-relaxed whitespace-pre-line tracking-wide transition-all select-none"
            style={{
              backgroundColor: hexToRgba(subStyle.bgColor, subStyle.bgOpacity),
              color: subStyle.textColor,
              fontSize: `${subStyle.fontSize}px`,
              textShadow: subStyle.textShadow
                ? '0 2px 4px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.95)'
                : 'none',
              boxShadow: subStyle.bgOpacity > 0 ? '0 10px 25px -5px rgba(0, 0, 0, 0.5)' : 'none',
            }}
          >
            {activeCueText}
          </span>
        </div>
      )}

      {/* Subtitle CSS & Styling Modal (Accessible in Full-Screen and Windowed Mode) */}
      {showSubStyleModal && (
        <div
          className="absolute inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-200 pointer-events-auto"
          onClick={(e) => {
            e.stopPropagation();
            setShowSubStyleModal(false);
          }}
        >
          <div
            className="bg-neutral-900/95 border border-neutral-700/80 rounded-2xl p-4 sm:p-6 w-full max-w-md max-h-[92vh] overflow-y-auto shadow-2xl text-white flex flex-col gap-4 text-xs sm:text-sm select-none"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center gap-2">
                <Palette className="w-5 h-5 text-rose-500" />
                <div>
                  <h3 className="font-bold text-base sm:text-lg text-white leading-tight">Subtitle Style</h3>
                  <p className="text-[11px] text-neutral-400">Customize appearance & font size</p>
                </div>
              </div>
              <button
                onClick={() => setShowSubStyleModal(false)}
                className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Live Preview Box */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Live Preview</span>
                <span className="text-[10px] text-neutral-500">Updates in real time</span>
              </div>
              <div className="relative h-20 sm:h-24 rounded-xl overflow-hidden border border-neutral-800 bg-neutral-950 flex items-center justify-center p-3 shadow-inner">
                {/* Subtle cinema backdrop simulation */}
                <div className="absolute inset-0 bg-gradient-to-r from-blue-950/20 via-neutral-950 to-purple-950/20 opacity-80 pointer-events-none" />

                <span
                  className="font-semibold px-3 py-1.5 rounded-xl border border-white/10 text-center max-w-full truncate z-10 transition-all leading-normal"
                  style={{
                    backgroundColor: hexToRgba(subStyle.bgColor, subStyle.bgOpacity),
                    color: subStyle.textColor,
                    fontSize: `${Math.min(subStyle.fontSize, 22)}px`,
                    textShadow: subStyle.textShadow
                      ? '0 2px 4px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.95)'
                      : 'none',
                  }}
                >
                  {activeCueText || 'Synchronized Subtitles Preview'}
                </span>
              </div>
            </div>

            {/* Font Size Selector */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="font-medium text-neutral-300 flex items-center gap-1.5">
                  <Type className="w-4 h-4 text-neutral-400" />
                  Font Size
                </span>
                <span className="text-neutral-400 text-xs font-mono font-semibold">{subStyle.fontSize}px</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { label: 'Small', size: 14 },
                  { label: 'Medium', size: 18 },
                  { label: 'Large', size: 22 },
                  { label: 'Huge', size: 28 },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => updateSubStyle({ fontSize: item.size })}
                    className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${subStyle.fontSize === item.size
                      ? 'bg-rose-600 text-white border-rose-500 shadow-md shadow-rose-950'
                      : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'
                      }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <input
                type="range"
                min="12"
                max="36"
                step="1"
                value={subStyle.fontSize}
                onChange={(e) => updateSubStyle({ fontSize: parseInt(e.target.value, 10) })}
                className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
              />
            </div>

            {/* Background Opacity / Transparency */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="font-medium text-neutral-300">Background Transparency</span>
                <span className="text-neutral-400 text-xs font-mono font-semibold">{subStyle.bgOpacity}%</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { label: '0% (Clear)', val: 0 },
                  { label: '50%', val: 50 },
                  { label: '85%', val: 85 },
                  { label: '100% (Solid)', val: 100 },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => updateSubStyle({ bgOpacity: item.val })}
                    className={`py-1.5 rounded-lg text-xs font-medium border transition-colors ${subStyle.bgOpacity === item.val
                      ? 'bg-rose-600 text-white border-rose-500 shadow-md shadow-rose-950'
                      : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'
                      }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={subStyle.bgOpacity}
                onChange={(e) => updateSubStyle({ bgOpacity: parseInt(e.target.value, 10) })}
                className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
              />
            </div>

            {/* Background Color Swatches + Custom Picker */}
            <div className="flex flex-col gap-2">
              <span className="font-medium text-neutral-300">Background Color</span>
              <div className="flex items-center gap-2.5 flex-wrap">
                {[
                  { label: 'Black', hex: '#000000' },
                  { label: 'Slate', hex: '#0f172a' },
                  { label: 'Charcoal', hex: '#18181b' },
                  { label: 'Navy', hex: '#1e3a8a' },
                  { label: 'Wine', hex: '#4c0519' },
                  { label: 'Emerald', hex: '#064e3b' },
                ].map((color) => (
                  <button
                    key={color.hex}
                    onClick={() => updateSubStyle({ bgColor: color.hex })}
                    style={{ backgroundColor: color.hex }}
                    className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center shadow-md ${subStyle.bgColor.toLowerCase() === color.hex.toLowerCase()
                      ? 'border-white scale-110 ring-2 ring-rose-500'
                      : 'border-neutral-600'
                      }`}
                    title={color.label}
                  >
                    {subStyle.bgColor.toLowerCase() === color.hex.toLowerCase() && (
                      <Check className="w-3.5 h-3.5 text-white drop-shadow" />
                    )}
                  </button>
                ))}

                {/* Custom Color Input */}
                <label
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg cursor-pointer text-xs transition-colors"
                  title="Custom background color"
                >
                  <input
                    type="color"
                    value={subStyle.bgColor}
                    onChange={(e) => updateSubStyle({ bgColor: e.target.value })}
                    className="w-4 h-4 rounded cursor-pointer border-0 bg-transparent p-0"
                  />
                  <span className="text-[11px] text-neutral-300">Custom</span>
                </label>
              </div>
            </div>

            {/* Text Color Swatches + Custom Picker */}
            <div className="flex flex-col gap-2">
              <span className="font-medium text-neutral-300">Text Color</span>
              <div className="flex items-center gap-2.5 flex-wrap">
                {[
                  { label: 'White', hex: '#ffffff' },
                  { label: 'Cinema Yellow', hex: '#facc15' },
                  { label: 'Cyan', hex: '#38bdf8' },
                  { label: 'Mint Green', hex: '#4ade80' },
                ].map((color) => (
                  <button
                    key={color.hex}
                    onClick={() => updateSubStyle({ textColor: color.hex })}
                    style={{ backgroundColor: color.hex }}
                    className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center shadow-md ${subStyle.textColor.toLowerCase() === color.hex.toLowerCase()
                      ? 'border-neutral-900 scale-110 ring-2 ring-rose-500'
                      : 'border-neutral-600'
                      }`}
                    title={color.label}
                  >
                    {subStyle.textColor.toLowerCase() === color.hex.toLowerCase() && (
                      <Check className="w-3.5 h-3.5 text-black drop-shadow" />
                    )}
                  </button>
                ))}

                {/* Custom Text Color Input */}
                <label
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg cursor-pointer text-xs transition-colors"
                  title="Custom text color"
                >
                  <input
                    type="color"
                    value={subStyle.textColor}
                    onChange={(e) => updateSubStyle({ textColor: e.target.value })}
                    className="w-4 h-4 rounded cursor-pointer border-0 bg-transparent p-0"
                  />
                  <span className="text-[11px] text-neutral-300">Custom</span>
                </label>
              </div>
            </div>

            {/* Footer Info & Reset */}
            <div className="flex items-center justify-between pt-3 border-t border-neutral-800 text-xs">
              <button
                onClick={resetSubStyle}
                className="flex items-center gap-1.5 text-neutral-400 hover:text-rose-400 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Default</span>
              </button>
              <button
                onClick={() => setShowSubStyleModal(false)}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-medium rounded-lg shadow-md transition-colors"
              >
                Done
              </button>
            </div>

            <div className="flex items-center justify-center gap-1.5 text-[11px] text-emerald-400/90 -mt-2">
              <Check className="w-3 h-3" />
              <span>Preferences automatically saved to local storage</span>
            </div>
          </div>
        </div>
      )}

      {/* Audio Track Selection Modal (Accessible in Full-Screen and Windowed Mode) */}
      {showAudioModal && (
        <div
          className="absolute inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-200 pointer-events-auto"
          onClick={(e) => {
            e.stopPropagation();
            setShowAudioModal(false);
          }}
        >
          <div
            className="bg-neutral-900/95 border border-neutral-700/80 rounded-2xl p-4 sm:p-6 w-full max-w-md max-h-[92vh] overflow-y-auto shadow-2xl text-white flex flex-col gap-4 text-xs sm:text-sm select-none"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center gap-2">
                <AudioLines className="w-5 h-5 text-amber-400" />
                <div>
                  <h3 className="font-bold text-base sm:text-lg text-white leading-tight">Audio Track</h3>
                  <p className="text-[11px] text-neutral-400">Choose dual-audio language or external audio</p>
                </div>
              </div>
              <button
                onClick={() => setShowAudioModal(false)}
                className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Embedded Video Audio Tracks */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Embedded Video Tracks
                </span>
                {effectiveEmbeddedTracks.length > 0 && (
                  <span className="text-[11px] text-amber-400 font-medium">
                    {effectiveEmbeddedTracks.length} {effectiveEmbeddedTracks.length === 1 ? 'track' : 'tracks'} found
                  </span>
                )}
              </div>

              {audioTracksSupported && audioTracks.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {audioTracks.map((track) => {
                    const isActive = !externalAudioUrl && selectedAudioTrackIndex === track.index;
                    return (
                      <button
                        key={track.id}
                        onClick={() => handleSelectEmbeddedTrack(track.index)}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-left transition-all ${isActive
                          ? 'bg-amber-500/15 border-amber-500/70 text-white shadow-md shadow-amber-950/30'
                          : 'bg-neutral-800/70 hover:bg-neutral-800 border-neutral-700/70 text-neutral-300'
                          }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${isActive
                              ? 'bg-amber-500 text-black'
                              : 'bg-neutral-700 text-neutral-300'
                              }`}
                          >
                            {track.index + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="font-semibold text-xs sm:text-sm truncate">{track.label}</p>
                            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
                              {track.languageCode && (
                                <span className="uppercase font-mono">{track.languageCode}</span>
                              )}
                              {track.kind && <span>• {track.kind}</span>}
                            </div>
                          </div>
                        </div>
                        {isActive && <Check className="w-4 h-4 text-amber-400 shrink-0" />}
                      </button>
                    );
                  })}
                  {audioTracks.length === 1 && (
                    <p className="text-[11px] text-neutral-500 px-1 pt-0.5">
                      Only 1 embedded audio track was found in this video.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {detectedContainerTracks.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      {detectedContainerTracks.map((track) => {
                        const isDefault = track.index === defaultContainerTrackIndex;
                        const isActive =
                          !externalAudioUrl &&
                          (mseActiveTrackIndex !== null
                            ? mseActiveTrackIndex === track.index
                            : isDefault);
                        const isLoading = mseLoadingTrackIndex === track.index;
                        const canSwitch = isDefault || Boolean(track.mseSupported);
                        return (
                          <button
                            key={track.id}
                            onClick={() => handleSelectMseTrack(track)}
                            disabled={!canSwitch || isLoading}
                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-left transition-all ${isActive
                              ? 'bg-amber-500/15 border-amber-500/70 text-white shadow-md shadow-amber-950/30'
                              : canSwitch
                                ? 'bg-neutral-800/70 hover:bg-neutral-800 border-neutral-700/70 text-neutral-300 cursor-pointer'
                                : 'bg-neutral-800/40 border-neutral-800 text-neutral-400 cursor-not-allowed'
                              }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span
                                className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${isActive
                                  ? 'bg-amber-500 text-black'
                                  : 'bg-neutral-700 text-neutral-300'
                                  }`}
                              >
                                {track.index + 1}
                              </span>
                              <div className="min-w-0">
                                <p className="font-semibold text-xs sm:text-sm truncate">{track.label}</p>
                                {(track.languageCode || track.codec) && (
                                  <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
                                    {track.languageCode && (
                                      <span className="uppercase font-mono">{track.languageCode}</span>
                                    )}
                                    {track.codec && <span>• {track.codec}</span>}
                                  </div>
                                )}
                              </div>
                            </div>
                            {isLoading ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 shrink-0 animate-pulse">
                                Switching...
                              </span>
                            ) : isActive ? (
                              <Check className="w-4 h-4 text-amber-400 shrink-0" />
                            ) : !canSwitch ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-700/80 text-neutral-300 shrink-0">
                                Locked by Browser
                              </span>
                            ) : isDefault ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-700/80 text-neutral-300 shrink-0">
                                Default
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                      {detectedContainerTracks.length === 1 && (
                        <p className="text-[11px] text-neutral-500 px-1 pt-0.5">
                          Only 1 embedded audio track was found in this video.
                        </p>
                      )}
                    </div>
                  )}

                  {mseErrorMsg && (
                    <div className="bg-rose-950/40 border border-rose-500/40 rounded-xl p-2.5 text-[11px] text-rose-200 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{mseErrorMsg}</span>
                    </div>
                  )}

                  {(detectedContainerTracks.length === 0 ||
                    detectedContainerTracks.some(
                      (t) => t.index !== defaultContainerTrackIndex && !t.mseSupported
                    )) && (
                    <div className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 flex flex-col gap-2 text-[11px] text-amber-200/90">
                      <div className="flex items-start gap-2">
                        <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <p className="leading-relaxed">
                          {detectedContainerTracks.length > 1
                            ? 'One or more detected audio codecs cannot be switched via in-browser remuxing.'
                            : 'This browser does not expose embedded video audio tracks by default.'}
                        </p>
                      </div>
                      <div className="pl-6 flex flex-col gap-1.5 text-neutral-300">
                        <p>
                          <strong className="text-white">Chrome / Edge:</strong> Enable{' '}
                          <code className="bg-black/50 px-1.5 py-0.5 rounded text-amber-300 text-[10px] break-all">
                            chrome://flags/#enable-experimental-web-platform-features
                          </code>{' '}
                          and relaunch, or use <strong className="text-white">Safari</strong>.
                        </p>
                        <button
                          onClick={() => {
                            if (typeof navigator !== 'undefined' && navigator.clipboard) {
                              navigator.clipboard
                                .writeText('chrome://flags/#enable-experimental-web-platform-features')
                                .then(() => {
                                  setCopiedFlagNotice(true);
                                  setTimeout(() => setCopiedFlagNotice(false), 2500);
                                })
                                .catch(() => { });
                            }
                          }}
                          className="self-start flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded-lg text-[11px] font-medium text-white transition-colors"
                        >
                          {copiedFlagNotice ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span>Copied Flag URL!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 text-amber-400" />
                              <span>Copy Chrome Flag URL</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* External Audio Track Fallback (Works on every browser) */}
            <div className="flex flex-col gap-2 pt-2 border-t border-neutral-800">
              <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
                External Audio File (All Browsers)
              </span>
              {externalAudioUrl ? (
                <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-emerald-950/40 border border-emerald-500/40 rounded-xl">
                  <div className="flex items-center gap-2 min-w-0">
                    <AudioLines className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-emerald-200 truncate">
                        {externalAudioName || 'External Audio'}
                      </p>
                      <p className="text-[10px] text-emerald-400/80">Synced with video playback</p>
                    </div>
                  </div>
                  <button
                    onClick={handleRemoveExternalAudio}
                    className="px-2.5 py-1 bg-neutral-800 hover:bg-rose-600 text-neutral-200 hover:text-white rounded-lg text-[11px] font-medium transition-colors shrink-0"
                  >
                    Use Video Audio
                  </button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 px-3 py-2.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-xl cursor-pointer text-xs font-medium text-neutral-200 transition-colors">
                  <Upload className="w-4 h-4 text-amber-400" />
                  <span>Load External Audio (.mp3, .m4a, .aac, .wav)</span>
                  <input
                    type="file"
                    accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
                    onChange={handleExternalAudioSelect}
                    className="hidden"
                  />
                </label>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end pt-2 border-t border-neutral-800">
              <button
                onClick={() => setShowAudioModal(false)}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-medium rounded-lg shadow-md transition-colors text-xs"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subtitle-like Chat Popup */}
      {latestPopupMsg && !showChatOverlay && (
        <div className="absolute top-6 left-6 flex justify-start pointer-events-none z-30">
          <div className="bg-black/80 backdrop-blur-md px-4 py-2 rounded-xl border border-white/10 shadow-2xl flex flex-col items-start max-w-lg text-left animate-in fade-in slide-in-from-top-4 duration-300">
            <span className="text-[10px] text-rose-400 font-bold uppercase tracking-wider mb-0.5">{latestPopupMsg.senderName} says:</span>
            <span className="text-white text-sm sm:text-base font-medium">{latestPopupMsg.text}</span>
          </div>
        </div>
      )}

      {/* Chat Overlay */}
      {showChatOverlay && (
        <div className="absolute inset-y-0 right-0 w-full max-w-sm z-40 animate-in slide-in-from-right-8 duration-300">
          <ChatBox
            messages={chatMessages}
            onSendMessage={onSendMessage}
            isOverlay={true}
            onClose={() => setShowChatOverlay(false)}
          />
        </div>
      )}

      {/* Buffering Spinner Overlay */}
      {isBuffering && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center pointer-events-none z-10">
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 border-4 border-rose-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-neutral-300 font-medium">Buffering...</span>
          </div>
        </div>
      )}

      {/* Overlay Controls */}
      {videoSrc && (
        <div
          className={`absolute inset-0 flex flex-col justify-between z-20 transition-opacity duration-300 pointer-events-none ${showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
            }`}
        >
          {/* Top Bar (Sync, Quality, Exit Fullscreen) */}
          <div className="flex justify-between items-start p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent pointer-events-auto">
            <div className="flex items-center gap-3">
              <button
                onClick={handleForceSync}
                className="bg-black/50 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-full backdrop-blur-md flex items-center gap-2 text-xs sm:text-sm font-medium transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                <span className="hidden sm:inline">Force Sync Partner</span>
              </button>

              <div className="relative">
                <button
                  onClick={showQualityNotice}
                  className="bg-black/50 hover:bg-neutral-700 text-white px-3 py-1.5 rounded-full backdrop-blur-md flex items-center gap-2 text-xs sm:text-sm font-medium transition-colors"
                >
                  <Settings className="w-4 h-4" />
                  <span className="hidden sm:inline">Quality</span>
                </button>
                {showQualityMsg && (
                  <div className="absolute top-full left-0 mt-2 bg-black/80 text-white text-xs px-3 py-2 rounded-lg whitespace-nowrap backdrop-blur-md border border-neutral-700">
                    Original Source (No transcoding)
                  </div>
                )}
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAudioModal(false);
                  setShowSubStyleModal((prev) => !prev);
                }}
                className={`px-3 py-1.5 rounded-full backdrop-blur-md flex items-center gap-1.5 text-xs sm:text-sm font-medium transition-colors ${showSubStyleModal
                  ? 'bg-rose-600 text-white shadow-lg shadow-rose-900/50'
                  : 'bg-black/50 hover:bg-neutral-700 text-white'
                  }`}
                title="Subtitle Style & Appearance (Font size, background color, opacity)"
              >
                <Sliders className="w-3.5 h-3.5 text-rose-300" />
                <span className="hidden sm:inline">Sub Style</span>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSubStyleModal(false);
                  setShowAudioModal((prev) => !prev);
                }}
                className={`px-3 py-1.5 rounded-full backdrop-blur-md flex items-center gap-1.5 text-xs sm:text-sm font-medium transition-colors ${showAudioModal
                  ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/50'
                  : hasMultipleAudio || externalAudioUrl
                    ? 'bg-amber-950/80 hover:bg-amber-800/80 text-amber-200 border border-amber-500/40'
                    : 'bg-black/50 hover:bg-neutral-700 text-white'
                  }`}
                title="Choose Audio Track (Dual Audio / External Audio)"
              >
                <AudioLines className="w-3.5 h-3.5 text-amber-300" />
                <span className="hidden sm:inline">Audio</span>
                {activeAudioBadgeText && (
                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-amber-500/30 text-amber-200 border border-amber-400/30">
                    {activeAudioBadgeText}
                  </span>
                )}
              </button>
            </div>

            {isFullscreen && (
              <button
                onClick={toggleFullscreen}
                className="bg-black/50 hover:bg-neutral-700 text-white p-2 rounded-full backdrop-blur-md transition-colors"
                title="Exit Fullscreen"
              >
                <Minimize className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Right Side Chat Toggle (Absolute to not disrupt center controls) */}
          <div className="absolute top-1/2 right-4 -translate-y-1/2 pointer-events-auto">
            {!showChatOverlay && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowChatOverlay(true); }}
                className="relative p-3 sm:p-4 bg-black/40 hover:bg-black/60 rounded-full text-white backdrop-blur-sm transition-transform active:scale-95 group"
                title="Open Chat Overlay"
              >
                <MessageSquare className="w-5 h-5 sm:w-6 sm:h-6" />
                {latestPopupMsg && (
                  <span className="absolute top-0 right-0 w-3 h-3 bg-rose-500 rounded-full border-2 border-black animate-pulse" />
                )}
              </button>
            )}
          </div>

          {/* Center Play/Pause & Skip */}
          <div className="flex justify-center items-center gap-4 sm:gap-8 pointer-events-auto flex-1">
            <button
              onClick={(e) => skip(-10, e)}
              className="p-3 sm:p-4 bg-black/40 hover:bg-black/60 rounded-full text-white backdrop-blur-sm transition-transform active:scale-95"
            >
              <Rewind className="w-6 h-6 sm:w-8 sm:h-8" />
            </button>

            <button
              onClick={togglePlay}
              className="p-4 sm:p-6 bg-rose-600/90 hover:bg-rose-500 rounded-full text-white backdrop-blur-sm transition-transform active:scale-95 shadow-lg shadow-rose-900/50"
            >
              {isPlaying ? <Pause className="w-8 h-8 sm:w-10 sm:h-10" /> : <Play className="w-8 h-8 sm:w-10 sm:h-10 ml-1" />}
            </button>

            <button
              onClick={(e) => skip(10, e)}
              className="p-3 sm:p-4 bg-black/40 hover:bg-black/60 rounded-full text-white backdrop-blur-sm transition-transform active:scale-95"
            >
              <FastForward className="w-6 h-6 sm:w-8 sm:h-8" />
            </button>
          </div>

          {/* Empty placeholder for Bottom area, since we moved the control bar below the video */}
          <div className="p-4 bg-gradient-to-t from-black/60 to-transparent pointer-events-none h-16 sm:h-24" />
        </div>
      )}
    </div>

    {/* Primary Video Controls & Secondary Toolbars */}
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3 flex flex-col gap-2.5 shadow-lg">
      {/* Progress Bar Slider */}
      <div className="flex items-center gap-2">
        <input
          type="range"
          min="0"
          max={duration || 100}
          step="0.1"
          value={currentTime}
          onChange={handleSeek}
          disabled={!videoSrc}
          className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-rose-500 hover:h-2 transition-all"
        />
      </div>

      <div className="flex items-center justify-between gap-3 text-xs">
        {/* Left Controls: Play/Pause, Mute, Volume */}
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            disabled={!videoSrc}
            className="p-2 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-md shadow-rose-950"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>

          <button
            onClick={toggleMute}
            className="text-neutral-400 hover:text-white transition-colors"
          >
            {isMuted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setVolume(val);
              if (videoRef.current) {
                videoRef.current.volume = val;
              }
              if (auxAudioRef.current) {
                auxAudioRef.current.volume = val;
              }
            }}
            className="w-16 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-neutral-300 hidden sm:block"
          />

          <span className="text-neutral-400 font-mono text-[11px]">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        {/* Right Controls: Local File, Subtitles, Fullscreen */}
        <div className="flex items-center gap-2">
          {/* Zero-Buffering Local File Picker */}
          <label
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-neutral-300 rounded-lg cursor-pointer transition-all border border-neutral-700"
            title="Pick local downloaded video file for 100% Zero Buffering"
          >
            <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden md:inline">
              {localFileName ? 'Local Loaded' : 'Local File (Zero Buffering)'}
            </span>
            <input
              type="file"
              accept="video/*,.mkv,.mp4,.webm"
              onChange={handleLocalFileSelect}
              className="hidden"
            />
          </label>

          {/* Subtitle Selector / Status & Download */}
          {subtitleUrl ? (
            <div className="flex items-center gap-1.5 bg-blue-950/60 border border-blue-500/40 rounded-lg px-2 py-1 text-blue-300 text-xs shadow-sm">
              <Subtitles className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="max-w-[60px] sm:max-w-[120px] truncate text-[11px] font-semibold text-blue-200" title={subtitleName || 'Subtitles active'}>
                {subtitleName || 'CC On'}
              </span>
              <a
                href={subtitleUrl}
                download={subtitleName || 'subtitles.vtt'}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 hover:text-white transition-colors"
                title="Download subtitle file (.vtt)"
              >
                <Download className="w-3.5 h-3.5 text-blue-400 hover:text-blue-100" />
              </a>
              <button
                onClick={(e) => { e.stopPropagation(); setSubtitleUrl(null); setSubtitleName(null); setSubCues([]); setActiveCueText(null); }}
                className="p-1 hover:text-rose-400 transition-colors"
                title="Turn off subtitles"
              >
                <X className="w-3.5 h-3.5 text-neutral-400 hover:text-rose-400" />
              </button>
            </div>
          ) : (
            <label
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-neutral-300 rounded-lg cursor-pointer transition-all border border-neutral-700"
              title="Add Subtitle (.srt or .vtt) - Automatically syncs to partner!"
            >
              <Subtitles className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="text-[11px] font-medium">Sub</span>
              <input
                type="file"
                accept=".srt,.vtt"
                onChange={handleSubtitleSelect}
                className="hidden"
              />
            </label>
          )}

          {/* Audio Track Selector Button */}
          <button
            onClick={() => {
              setShowSubStyleModal(false);
              setShowAudioModal((prev) => !prev);
            }}
            disabled={!videoSrc}
            className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg transition-all border disabled:opacity-40 disabled:cursor-not-allowed ${showAudioModal
              ? 'bg-amber-600 text-white border-amber-500 shadow-md shadow-amber-950'
              : hasMultipleAudio || externalAudioUrl
                ? 'bg-amber-950/60 hover:bg-amber-900/60 border-amber-500/40 text-amber-200'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-300'
              }`}
            title={
              hasMultipleAudio
                ? `Choose Audio Track (${effectiveEmbeddedTracks.length} tracks detected)`
                : 'Audio Track Settings'
            }
          >
            <AudioLines className={`w-3.5 h-3.5 shrink-0 ${showAudioModal ? 'text-white' : 'text-amber-400'}`} />
            <span className="hidden sm:inline text-[11px] font-medium">Audio</span>
            {activeAudioBadgeText && (
              <span className="text-[10px] font-bold px-1 py-0.2 rounded bg-amber-500/25 text-amber-200 border border-amber-400/30">
                {activeAudioBadgeText}
              </span>
            )}
          </button>

          {/* Subtitle Style Settings Button */}
          <button
            onClick={() => {
              setShowAudioModal(false);
              setShowSubStyleModal((prev) => !prev);
            }}
            className={`p-1.5 rounded-lg transition-colors ${showSubStyleModal
              ? 'bg-rose-600 text-white shadow-md shadow-rose-950'
              : 'hover:bg-neutral-800 text-neutral-400 hover:text-white'
              }`}
            title="Subtitle Style & Appearance (Font size, background color, opacity)"
          >
            <Sliders className="w-4 h-4" />
          </button>

          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 hover:bg-neutral-800 text-neutral-400 hover:text-white rounded-lg transition-colors"
            title="Toggle Fullscreen"
          >
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
);
};

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const mStr = m.toString().padStart(2, '0');
  const sStr = s.toString().padStart(2, '0');

  if (h > 0) {
    return `${h}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
}
