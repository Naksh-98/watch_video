import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { RoomUser, SyncAction, PartnerState, ChatMessage } from '../lib/types';

interface UseSocketProps {
  roomCode: string;
  userName: string;
  onSyncAction?: (action: SyncAction) => void;
  onPartnerHeartbeat?: (partner: PartnerState) => void;
  onBufferChange?: (data: { senderName: string; isBuffering: boolean }) => void;
  onMovieSelected?: (data: { filename: string; senderName: string }) => void;
  onReaction?: (data: { emoji: string; senderName: string }) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onUserJoined?: (user: { id: string; name: string }) => void;
  onUserLeft?: (user: { id: string; name: string }) => void;
}

export function useSocket({
  roomCode,
  userName,
  onSyncAction,
  onPartnerHeartbeat,
  onBufferChange,
  onMovieSelected,
  onReaction,
  onChatMessage,
  onUserJoined,
  onUserLeft,
}: UseSocketProps) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [users, setUsers] = useState<RoomUser[]>([]);

  useEffect(() => {
    if (!roomCode || !userName) return;

    // Connect to current host
    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('join_room', { roomCode, name: userName });
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('room_info', (data: { users: RoomUser[] }) => {
      setUsers(data.users);
    });

    socket.on('user_joined', (data: { id: string; name: string; users: RoomUser[] }) => {
      setUsers(data.users);
      if (onUserJoined) onUserJoined(data);
    });

    socket.on('user_left', (data: { id: string; name: string; users: RoomUser[] }) => {
      setUsers(data.users);
      if (onUserLeft) onUserLeft(data);
    });

    socket.on('sync_action', (data: SyncAction) => {
      if (onSyncAction) onSyncAction(data);
    });

    socket.on('partner_heartbeat', (data: PartnerState) => {
      if (onPartnerHeartbeat) onPartnerHeartbeat(data);
    });

    socket.on('buffer_change', (data: { senderName: string; isBuffering: boolean }) => {
      if (onBufferChange) onBufferChange(data);
    });

    socket.on('movie_selected', (data: { filename: string; senderName: string }) => {
      if (onMovieSelected) onMovieSelected(data);
    });

    socket.on('reaction_received', (data: { emoji: string; senderName: string }) => {
      if (onReaction) onReaction(data);
    });

    socket.on('chat_received', (message: ChatMessage) => {
      if (onChatMessage) onChatMessage(message);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomCode, userName]);

  const sendSyncAction = (action: 'play' | 'pause' | 'seek', time: number) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('sync_action', { action, time });
    }
  };

  const sendHeartbeat = (currentTime: number, isPlaying: boolean, isBuffering: boolean) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('heartbeat', { currentTime, isPlaying, isBuffering });
    }
  };

  const sendBufferChange = (isBuffering: boolean) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('buffer_change', { isBuffering });
    }
  };

  const selectMovie = (filename: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('select_movie', { filename });
    }
  };

  const sendReaction = (emoji: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('send_reaction', { emoji });
    }
  };

  const sendChatMessage = (text: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('send_chat', { text });
    }
  };

  return {
    socket: socketRef.current,
    isConnected,
    users,
    sendSyncAction,
    sendHeartbeat,
    sendBufferChange,
    selectMovie,
    sendReaction,
    sendChatMessage,
  };
}
