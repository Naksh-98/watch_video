'use client';

import React, { useState } from 'react';
import { Copy, Check, Users, Heart, Smile, Popcorn, Flame, ThumbsUp } from 'lucide-react';
import { RoomUser } from '../lib/types';

interface RoomHeaderProps {
  roomCode: string;
  userName: string;
  isConnected: boolean;
  users: RoomUser[];
  onSendReaction: (emoji: string) => void;
}

export const RoomHeader: React.FC<RoomHeaderProps> = ({
  roomCode,
  userName,
  isConnected,
  users,
  onSendReaction,
}) => {
  const [copied, setCopied] = useState(false);

  const copyRoomLink = () => {
    if (typeof window !== 'undefined') {
      const url = `${window.location.origin}/?room=${encodeURIComponent(roomCode)}`;
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const emojis = ['❤️', '😂', '🍿', '🔥', '👏', '😱'];

  return (
    <header className="bg-neutral-900 border-b border-neutral-800 px-4 py-3">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* App Title & Room Code */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold bg-gradient-to-r from-red-500 to-rose-400 bg-clip-text text-transparent">
              SyncCinema
            </span>
          </div>
          <div className="flex items-center gap-2 bg-neutral-800/80 px-3 py-1 rounded-full text-xs font-mono text-neutral-300 border border-neutral-700">
            <span>Room:</span>
            <span className="font-bold text-white">{roomCode}</span>
            <button
              onClick={copyRoomLink}
              title="Copy share link for your partner"
              className="hover:text-red-400 transition-colors ml-1 p-0.5"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Reaction Bar */}
        <div className="flex items-center gap-1.5 bg-neutral-800/60 px-2 py-1 rounded-full border border-neutral-800">
          {emojis.map((emoji) => (
            <button
              key={emoji}
              onClick={() => onSendReaction(emoji)}
              className="text-base sm:text-lg hover:scale-125 active:scale-95 transition-transform px-1"
              title={`Send ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* User Presence & Connection Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-neutral-400">
            <Users className="w-4 h-4 text-neutral-400" />
            <span className="font-medium text-white">{users.length} in room</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500'
              }`}
            />
            <span className="text-neutral-400 hidden sm:inline">
              {isConnected ? 'Online' : 'Reconnecting...'}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};
