'use client';

import React, { useState, useEffect } from 'react';
import { useSocket } from '../hooks/useSocket';
import { useWebRTC } from '../hooks/useWebRTC';
import { RoomHeader } from '../components/RoomHeader';
import { VoiceCall } from '../components/VoiceCall';
import { PartnerHUD } from '../components/PartnerHUD';
import { VideoPlayer } from '../components/VideoPlayer';
import { MovieLibrary } from '../components/MovieLibrary';
import { ChatBox } from '../components/ChatBox';
import { SyncAction, PartnerState, Reaction, ChatMessage } from '../lib/types';
import { Tv, Sparkles, HeartHandshake, ShieldCheck, WifiOff, FolderOpen, MessageSquare } from 'lucide-react';

export default function Home() {
  const [roomCode, setRoomCode] = useState('');
  const [userName, setUserName] = useState('');
  const [hasJoined, setHasJoined] = useState(false);

  // Video and Sync States
  const [selectedMovie, setSelectedMovie] = useState<string | null>(null);
  const [myCurrentTime, setMyCurrentTime] = useState(0);
  const [myIsPlaying, setMyIsPlaying] = useState(false);
  const [incomingAction, setIncomingAction] = useState<SyncAction | null>(null);
  const [partnerState, setPartnerState] = useState<PartnerState | null>(null);
  const [externalJumpTime, setExternalJumpTime] = useState<number | null>(null);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeBottomTab, setActiveBottomTab] = useState<'library' | 'chat'>('library');

  // Pre-fill room code from URL query param if present
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room');
      if (roomParam) {
        setRoomCode(roomParam.trim());
      }
    }
  }, []);

  // Socket Hook
  const {
    socket,
    isConnected,
    users,
    sendSyncAction,
    sendHeartbeat,
    sendBufferChange,
    selectMovie,
    sendReaction,
    sendChatMessage,
  } = useSocket({
    roomCode: hasJoined ? roomCode : '',
    userName: hasJoined ? userName : '',
    onSyncAction: (action) => {
      setIncomingAction(action);
    },
    onPartnerHeartbeat: (partner) => {
      setPartnerState(partner);
    },
    onBufferChange: (data) => {
      setPartnerState((prev) => (prev ? { ...prev, isBuffering: data.isBuffering } : null));
    },
    onMovieSelected: (data) => {
      setSelectedMovie(data.filename);
    },
    onReaction: (data) => {
      const newReaction: Reaction = {
        id: Math.random().toString(),
        emoji: data.emoji,
        senderName: data.senderName,
      };
      setReactions((prev) => [...prev, newReaction]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== newReaction.id));
      }, 2500);
    },
    onChatMessage: (message) => {
      setChatMessages((prev) => [...prev, message]);
    },
  });

  // Identify partner (the other person in the room)
  const partnerUser = users.find((u) => u.name !== userName) || null;
  const partnerId = partnerUser ? partnerUser.id : null;

  // WebRTC Voice Call Hook
  const {
    isInCall,
    isMuted,
    callStatus,
    partnerVolume,
    startCall,
    endCall,
    toggleMute,
    setPartnerVolume,
  } = useWebRTC({
    socket,
    partnerId,
  });

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode.trim() || !userName.trim()) return;
    setHasJoined(true);
  };

  // The requested Jump to Partner sync action
  const handleJumpToPartner = (targetTime: number) => {
    setExternalJumpTime(targetTime);
  };

  // Ask partner to jump to my timestamp
  const handleRequestPartnerJump = () => {
    sendSyncAction('seek', myCurrentTime);
  };

  const handleSelectMovie = (filename: string) => {
    setSelectedMovie(filename);
    selectMovie(filename);
  };

  if (!hasJoined) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-neutral-950 via-neutral-900 to-black">
        <div className="w-full max-w-md bg-neutral-900/90 border border-neutral-800 p-6 sm:p-8 rounded-2xl shadow-2xl backdrop-blur-sm">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-500 mb-3 shadow-lg shadow-rose-950">
              <Tv className="w-7 h-7" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">SyncCinema</h1>
            <p className="text-xs text-neutral-400 mt-1">
              Watch movies together with zero buffering & built-in voice call
            </p>
          </div>

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-1.5">
                Your Name
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Nakshatra"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-neutral-800 border border-neutral-700 rounded-xl text-white placeholder-neutral-500 text-sm focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-1.5">
                Room Code
              </label>
              <input
                type="text"
                required
                placeholder="e.g. movie-night-2"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-neutral-800 border border-neutral-700 rounded-xl text-white placeholder-neutral-500 text-sm focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-all font-mono"
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 px-4 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 active:scale-[0.98] text-white font-semibold rounded-xl text-sm transition-all shadow-lg shadow-rose-950/50 flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              <span>Enter Watch Room</span>
            </button>
          </form>

          {/* Feature Highlights */}
          <div className="mt-6 pt-5 border-t border-neutral-800 grid grid-cols-2 gap-3 text-[11px] text-neutral-400">
            <div className="flex items-center gap-1.5">
              <WifiOff className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Zero-buffering sync</span>
            </div>
            <div className="flex items-center gap-1.5">
              <HeartHandshake className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span>Jump-to-partner</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>Built-in voice call</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Tv className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>100% Free Forever</span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0c]">
      {/* Top Header */}
      <RoomHeader
        roomCode={roomCode}
        userName={userName}
        isConnected={isConnected}
        users={users}
        onSendReaction={sendReaction}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-3 sm:p-5 flex flex-col gap-4">
        {/* Voice Call Bar */}
        <VoiceCall
          isInCall={isInCall}
          isMuted={isMuted}
          callStatus={callStatus}
          partnerVolume={partnerVolume}
          partnerName={partnerUser ? partnerUser.name : null}
          onStartCall={startCall}
          onEndCall={endCall}
          onToggleMute={toggleMute}
          onVolumeChange={setPartnerVolume}
        />

        {/* Video Player */}
        <VideoPlayer
          movieFilename={selectedMovie}
          onSendSyncAction={sendSyncAction}
          onSendHeartbeat={(time, playing, buffering) => {
            setMyCurrentTime(time);
            setMyIsPlaying(playing);
            sendHeartbeat(time, playing, buffering);
          }}
          onSendBufferChange={sendBufferChange}
          incomingAction={incomingAction}
          externalJumpTime={externalJumpTime}
          reactions={reactions}
          chatMessages={chatMessages}
          onSendMessage={sendChatMessage}
          onOpenChatTab={() => setActiveBottomTab('chat')}
          userName={userName}
        />

        {/* The Requested Jump-To-Partner HUD */}
        <PartnerHUD
          myTime={myCurrentTime}
          myIsPlaying={myIsPlaying}
          partner={partnerState}
          partnerName={partnerUser ? partnerUser.name : null}
          onJumpToPartner={handleJumpToPartner}
          onRequestPartnerJump={handleRequestPartnerJump}
        />

        {/* Bottom Tabbed Area (Library / Chat) */}
        <div className="flex flex-col bg-neutral-900/40 border border-neutral-800 rounded-2xl overflow-hidden mt-4">
          <div className="flex bg-neutral-900 border-b border-neutral-800 p-2 gap-2">
            <button
              onClick={() => setActiveBottomTab('library')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeBottomTab === 'library'
                  ? 'bg-neutral-800 text-white shadow-sm'
                  : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
              }`}
            >
              <FolderOpen className="w-4 h-4" />
              Movie Library
            </button>
            <button
              onClick={() => setActiveBottomTab('chat')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeBottomTab === 'chat'
                  ? 'bg-neutral-800 text-white shadow-sm'
                  : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              Room Chat
            </button>
          </div>

          <div className="p-0">
            <div className={activeBottomTab === 'library' ? 'block' : 'hidden'}>
              <MovieLibrary currentMovie={selectedMovie} onSelectMovie={handleSelectMovie} />
            </div>
            <div className={activeBottomTab === 'chat' ? 'block' : 'hidden'}>
              <ChatBox messages={chatMessages} onSendMessage={sendChatMessage} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
