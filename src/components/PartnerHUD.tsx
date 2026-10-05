'use client';

import React from 'react';
import { FastForward, CheckCircle2, AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import { PartnerState } from '../lib/types';

interface PartnerHUDProps {
  myTime: number;
  myIsPlaying: boolean;
  partner: PartnerState | null;
  onJumpToPartner: (targetTime: number) => void;
  onRequestPartnerJump: () => void;
}

export function formatTime(seconds: number): string {
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

export const PartnerHUD: React.FC<PartnerHUDProps> = ({
  myTime,
  myIsPlaying,
  partner,
  onJumpToPartner,
  onRequestPartnerJump,
}) => {
  if (!partner) {
    return (
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-3 flex items-center justify-between text-xs text-neutral-400">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-neutral-600 animate-pulse" />
          <span>Waiting for your partner to join this room...</span>
        </div>
        <span className="text-neutral-500">Your Time: {formatTime(myTime)}</span>
      </div>
    );
  }

  const diff = partner.currentTime - myTime;
  const isFarApart = Math.abs(diff) > 2; // more than 2 seconds apart

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3 sm:p-4 shadow-xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Timestamps Side by Side */}
        <div className="flex items-center gap-4 text-xs sm:text-sm">
          {/* My Time */}
          <div className="flex flex-col">
            <span className="text-neutral-400 text-[11px] uppercase tracking-wider font-semibold">
              You
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="font-mono text-base font-bold text-white">
                {formatTime(myTime)}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  myIsPlaying ? 'bg-emerald-500/20 text-emerald-400' : 'bg-neutral-800 text-neutral-400'
                }`}
              >
                {myIsPlaying ? 'PLAYING' : 'PAUSED'}
              </span>
            </div>
          </div>

          <div className="h-7 w-[1px] bg-neutral-800" />

          {/* Partner Time */}
          <div className="flex flex-col">
            <span className="text-neutral-400 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1">
              <span>{partner.name || 'Partner'}</span>
              {partner.isBuffering && (
                <span className="text-amber-400 flex items-center gap-1 text-[10px]">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" /> Buffering
                </span>
              )}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="font-mono text-base font-bold text-rose-400">
                {formatTime(partner.currentTime)}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  partner.isPlaying
                    ? 'bg-rose-500/20 text-rose-400'
                    : 'bg-neutral-800 text-neutral-400'
                }`}
              >
                {partner.isPlaying ? 'PLAYING' : 'PAUSED'}
              </span>
            </div>
          </div>

          {/* Drift Status Indicator */}
          <div className="hidden md:flex items-center">
            {isFarApart ? (
              <span className="flex items-center gap-1 text-[11px] text-amber-400 bg-amber-500/10 px-2 py-1 rounded-md border border-amber-500/20">
                <AlertCircle className="w-3.5 h-3.5" />
                {diff > 0 ? `${formatTime(diff)} behind` : `${formatTime(Math.abs(diff))} ahead`}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded-md border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" />
                In Sync (±{Math.abs(diff).toFixed(1)}s)
              </span>
            )}
          </div>
        </div>

        {/* Sync / Jump Action Buttons */}
        <div className="flex items-center gap-2">
          {/* THE CORE REQUESTED BUTTON: Jump to Partner */}
          <button
            onClick={() => onJumpToPartner(partner.currentTime)}
            className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all shadow-md active:scale-95 ${
              isFarApart
                ? 'bg-rose-600 hover:bg-rose-500 text-white animate-pulse shadow-rose-900/40'
                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
            }`}
            title={`Jump your video immediately to ${formatTime(partner.currentTime)}`}
          >
            <FastForward className="w-4 h-4 text-white" />
            <span>Jump to {partner.name || 'Partner'} ({formatTime(partner.currentTime)})</span>
          </button>

          {/* Invite Partner to Jump to My Time */}
          <button
            onClick={onRequestPartnerJump}
            className="p-2 bg-neutral-800 hover:bg-neutral-700 active:scale-95 text-neutral-300 rounded-lg text-xs transition-colors"
            title="Ask partner to sync to your timestamp"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Buffering Banner */}
      {partner.isBuffering && (
        <div className="mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 flex items-center gap-2 text-xs text-amber-300">
          <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
          <span>
            {partner.name || 'Your partner'} is currently buffering due to slower internet. The player will automatically pause to let them catch up!
          </span>
        </div>
      )}
    </div>
  );
};
