'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, FolderOpen, Subtitles, AlertTriangle } from 'lucide-react';
import { SyncAction, Reaction } from '../lib/types';

interface VideoPlayerProps {
  movieFilename: string | null;
  onSendSyncAction: (action: 'play' | 'pause' | 'seek', time: number) => void;
  onSendHeartbeat: (time: number, isPlaying: boolean, isBuffering: boolean) => void;
  onSendBufferChange: (isBuffering: boolean) => void;
  incomingAction: SyncAction | null;
  externalJumpTime: number | null;
  reactions: Reaction[];
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  movieFilename,
  onSendSyncAction,
  onSendHeartbeat,
  onSendBufferChange,
  incomingAction,
  externalJumpTime,
  reactions,
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

  // Prevent sync echo feedback loops
  const isIncomingUpdateRef = useRef(false);

  // Determine active video source (Local file -> Direct URL -> Server HTTP 206 Stream)
  const videoSrc = localFileUrl || (
    movieFilename ? (
      movieFilename.startsWith('http://') || movieFilename.startsWith('https://')
        ? movieFilename
        : `/api/movies/stream/${encodeURIComponent(movieFilename)}`
    ) : null
  );

  // Handle local file selection (Ultimate Zero Buffering mode)
  const handleLocalFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setLocalFileUrl(url);
      setLocalFileName(file.name);
    }
  };

  // Handle Subtitle file upload (.vtt or .srt)
  const handleSubtitleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.name.endsWith('.vtt')) {
      const url = URL.createObjectURL(file);
      setSubtitleUrl(url);
    } else {
      // Basic SRT to VTT converter in-browser
      const reader = new FileReader();
      reader.onload = () => {
        let text = reader.result as string;
        let vttText = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        const blob = new Blob([vttText], { type: 'text/vtt' });
        setSubtitleUrl(URL.createObjectURL(blob));
      };
      reader.readAsText(file);
    }
  };

  // Play / Pause Toggle
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().catch(() => {});
      onSendSyncAction('play', video.currentTime);
    } else {
      video.pause();
      onSendSyncAction('pause', video.currentTime);
    }
  }, [onSendSyncAction]);

  // Handle Progress Bar Seek
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const target = parseFloat(e.target.value);
    video.currentTime = target;
    setCurrentTime(target);
    onSendSyncAction('seek', target);
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
      video.play().catch(() => {});
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
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const onLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const onPlayHandler = () => {
    setIsPlaying(true);
    if (!isIncomingUpdateRef.current && videoRef.current) {
      onSendSyncAction('play', videoRef.current.currentTime);
    }
  };

  const onPauseHandler = () => {
    setIsPlaying(false);
    if (!isIncomingUpdateRef.current && videoRef.current) {
      onSendSyncAction('pause', videoRef.current.currentTime);
    }
  };

  const onWaitingHandler = () => {
    setIsBuffering(true);
    onSendBufferChange(true);
  };

  const onPlayingHandler = () => {
    setIsBuffering(false);
    onSendBufferChange(false);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Video Container */}
      <div
        ref={containerRef}
        className="relative bg-black rounded-2xl overflow-hidden aspect-video border border-neutral-800 shadow-2xl flex items-center justify-center group select-none"
      >
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onPlay={onPlayHandler}
            onPause={onPauseHandler}
            onWaiting={onWaitingHandler}
            onPlaying={onPlayingHandler}
            playsInline
            className="w-full h-full object-contain"
          >
            {subtitleUrl && (
              <track src={subtitleUrl} kind="subtitles" srcLang="en" label="English" default />
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

        {/* Floating Partner Reaction Emojis */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
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

        {/* Buffering Spinner Overlay */}
        {isBuffering && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <div className="w-10 h-10 border-4 border-rose-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-neutral-300 font-medium">Buffering...</span>
            </div>
          </div>
        )}

        {/* Click overlay for play/pause */}
        {videoSrc && (
          <div
            onClick={togglePlay}
            className="absolute inset-0 cursor-pointer"
          />
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

            {/* Subtitle Selector */}
            <label
              className="flex items-center gap-1 px-2 py-1.5 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-neutral-300 rounded-lg cursor-pointer transition-all border border-neutral-700"
              title="Load Subtitle file (.srt or .vtt)"
            >
              <Subtitles className="w-3.5 h-3.5 text-blue-400" />
              <input
                type="file"
                accept=".srt,.vtt"
                onChange={handleSubtitleSelect}
                className="hidden"
              />
            </label>

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
