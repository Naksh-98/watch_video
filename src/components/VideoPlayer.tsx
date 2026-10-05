'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, FolderOpen, Subtitles, AlertTriangle, Rewind, FastForward, Settings, RefreshCw } from 'lucide-react';
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
  
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showQualityMsg, setShowQualityMsg] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Prevent sync echo feedback loops
  const isIncomingUpdateRef = useRef(false);

  // Determine active video source
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
    };
  }, []);

  const handleLocalFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setLocalFileUrl(url);
      setLocalFileName(file.name);
    }
  };

  const handleSubtitleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.name.endsWith('.vtt')) {
      const url = URL.createObjectURL(file);
      setSubtitleUrl(url);
    } else {
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

  const togglePlay = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
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

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const target = parseFloat(e.target.value);
    video.currentTime = target;
    setCurrentTime(target);
    onSendSyncAction('seek', target);
    handleUserActivity();
  };

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

  useEffect(() => {
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (video) {
        onSendHeartbeat(video.currentTime, !video.paused, isBuffering);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [onSendHeartbeat, isBuffering]);

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
    setShowControls(true); // Always show controls when paused
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
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const toggleMute = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const showQualityNotice = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowQualityMsg(true);
    setTimeout(() => setShowQualityMsg(false), 3000);
  };

  return (
    <div className="w-full flex flex-col items-center">
      <div
        ref={containerRef}
        className="relative w-full bg-black rounded-2xl overflow-hidden aspect-video border border-neutral-800 shadow-2xl flex items-center justify-center group select-none"
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
            className="w-full h-full object-contain"
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
              className="absolute bottom-20 right-10 animate-bounce text-4xl sm:text-5xl"
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
            className={`absolute inset-0 flex flex-col justify-between z-20 transition-opacity duration-300 pointer-events-none ${
              showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
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

            {/* Center Play/Pause & Skip */}
            <div className="flex justify-center items-center gap-4 sm:gap-8 pointer-events-auto">
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

            {/* Bottom Bar (Progress, Volume, etc) */}
            <div className="p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent pointer-events-auto flex flex-col gap-3">
              
              {/* Progress Bar Slider */}
              <div className="flex items-center gap-2 group/slider cursor-pointer" onClick={(e) => e.stopPropagation()}>
                <input
                  type="range"
                  min="0"
                  max={duration || 100}
                  step="0.1"
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-1.5 sm:h-1 bg-neutral-600 rounded-lg appearance-none cursor-pointer accent-rose-500 group-hover/slider:h-2 transition-all"
                />
              </div>

              <div className="flex items-center justify-between gap-3 text-xs" onClick={(e) => e.stopPropagation()}>
                {/* Left Controls: Volume */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={toggleMute}
                    className="text-white hover:text-rose-400 transition-colors p-1"
                  >
                    {isMuted || volume === 0 ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5" />}
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
                        videoRef.current.muted = val === 0;
                        setIsMuted(val === 0);
                      }
                    }}
                    className="w-16 sm:w-20 h-1.5 bg-neutral-600 rounded-lg appearance-none cursor-pointer accent-white hidden sm:block"
                  />
                  <span className="text-white font-mono text-[11px] sm:text-xs font-medium ml-1">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>

                {/* Right Controls: Local File, Subtitles, Fullscreen */}
                <div className="flex items-center gap-2 sm:gap-3">
                  <label
                    className="flex items-center gap-1.5 px-2 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg cursor-pointer transition-colors backdrop-blur-sm"
                    title="Pick local video file"
                  >
                    <FolderOpen className="w-4 h-4 text-emerald-400" />
                    <span className="hidden md:inline font-medium">
                      {localFileName ? 'Local Loaded' : 'Local File'}
                    </span>
                    <input
                      type="file"
                      accept="video/*,.mkv,.mp4,.webm"
                      onChange={handleLocalFileSelect}
                      className="hidden"
                    />
                  </label>

                  <label
                    className="flex items-center gap-1 px-2 py-1.5 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-lg cursor-pointer transition-colors backdrop-blur-sm"
                    title="Load Subtitle (.srt or .vtt)"
                  >
                    <Subtitles className="w-4 h-4 text-blue-400" />
                    <input
                      type="file"
                      accept=".srt,.vtt"
                      onChange={handleSubtitleSelect}
                      className="hidden"
                    />
                  </label>

                  <button
                    onClick={toggleFullscreen}
                    className="p-1.5 text-white hover:text-rose-400 transition-colors ml-1"
                    title="Toggle Fullscreen"
                  >
                    {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
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
