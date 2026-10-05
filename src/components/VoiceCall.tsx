'use client';

import React from 'react';
import { Mic, MicOff, Phone, PhoneOff, Volume2 } from 'lucide-react';

interface VoiceCallProps {
  isInCall: boolean;
  isMuted: boolean;
  callStatus: 'idle' | 'calling' | 'connected' | 'error';
  partnerVolume: number;
  partnerName: string | null;
  onStartCall: () => void;
  onEndCall: () => void;
  onToggleMute: () => void;
  onVolumeChange: (vol: number) => void;
}

export const VoiceCall: React.FC<VoiceCallProps> = ({
  isInCall,
  isMuted,
  callStatus,
  partnerVolume,
  partnerName,
  onStartCall,
  onEndCall,
  onToggleMute,
  onVolumeChange,
}) => {
  return (
    <div className="bg-neutral-900/90 border border-neutral-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
      {/* Call Status & Partner Info */}
      <div className="flex items-center gap-2.5">
        <div className="relative flex items-center justify-center">
          {callStatus === 'connected' ? (
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
          ) : callStatus === 'calling' ? (
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
            </span>
          ) : (
            <span className="h-2.5 w-2.5 rounded-full bg-neutral-600"></span>
          )}
        </div>

        <div>
          <span className="font-semibold text-white">Voice Call</span>
          <p className="text-xs text-neutral-400">
            {callStatus === 'connected' && `Connected with ${partnerName || 'Partner'}`}
            {callStatus === 'calling' && 'Connecting audio...'}
            {callStatus === 'idle' && (partnerName ? `Ready to call ${partnerName}` : 'Waiting for partner')}
            {callStatus === 'error' && 'Mic permission denied or error'}
          </p>
        </div>
      </div>

      {/* Call Controls */}
      <div className="flex items-center gap-2">
        {!isInCall ? (
          <button
            onClick={onStartCall}
            disabled={!partnerName}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              partnerName
                ? 'bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white shadow-lg shadow-emerald-900/40'
                : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>Start Voice</span>
          </button>
        ) : (
          <>
            {/* Mute Button */}
            <button
              onClick={onToggleMute}
              className={`p-2 rounded-lg text-xs font-medium transition-all ${
                isMuted
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
              }`}
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4 text-emerald-400" />}
            </button>

            {/* Volume Slider for Partner Voice */}
            <div className="hidden sm:flex items-center gap-1.5 bg-neutral-800 px-2.5 py-1 rounded-lg border border-neutral-700">
              <Volume2 className="w-3.5 h-3.5 text-neutral-400" />
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={partnerVolume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                className="w-16 h-1 bg-neutral-600 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                title="Partner Voice Volume"
              />
            </div>

            {/* End Call Button */}
            <button
              onClick={onEndCall}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-500 active:scale-95 text-white transition-all shadow-lg shadow-red-900/40"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>End Call</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};
