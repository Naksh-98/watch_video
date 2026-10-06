'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, FolderOpen, Subtitles, AlertTriangle, Rewind, FastForward, Settings, RefreshCw, MessageSquare, X } from 'lucide-react';
import { SyncAction, Reaction, ChatMessage } from '../lib/types';
import { ChatBox } from './ChatBox';

interface VideoPlayerProps {
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
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
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

  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showQualityMsg, setShowQualityMsg] = useState(false);
  const [showChatOverlay, setShowChatOverlay] = useState(false);
  const [latestPopupMsg, setLatestPopupMsg] = useState<ChatMessage | null>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const popupTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  const handleUserActivity = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3500);
  }, [isPlaying]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      if (popupTimeoutRef.current) clearTimeout(popupTimeoutRef.current);
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
  };

  const onPauseHandler = () => {
    setIsPlaying(false);
    setShowControls(true);
  };

  const onWaitingHandler = () => {
    setIsBuffering(true);
    onSendBufferChange(true);
  };

  const onPlayingHandler = () => {
    setIsBuffering(false);
    onSendBufferChange(false);
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
        onMouseMove={handleUserActivity}
        onTouchStart={handleUserActivity}
        onClick={handleUserActivity}
        onMouseLeave={() => { if (isPlaying) setShowControls(false); }}
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
            className="w-full h-full object-contain cursor-pointer"
            onClick={togglePlay}
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
