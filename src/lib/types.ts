export interface RoomUser {
  id: string;
  name: string;
  currentTime: number;
  isPlaying: boolean;
  isBuffering: boolean;
}

export interface SyncAction {
  action: 'play' | 'pause' | 'seek';
  time: number;
  senderId?: string;
  senderName?: string;
}

export interface PartnerState {
  id: string;
  name: string;
  currentTime: number;
  isPlaying: boolean;
  isBuffering: boolean;
}

export interface MovieItem {
  filename: string;
  size: number;
  formattedSize: string;
  modifiedAt: string;
  url?: string;
  isCloud?: boolean;
}

export interface Reaction {
  id: string;
  emoji: string;
  senderName: string;
}
