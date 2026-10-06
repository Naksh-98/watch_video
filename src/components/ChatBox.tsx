import React, { useState, useRef, useEffect } from 'react';
import { Send, MessageSquare, X } from 'lucide-react';
import { ChatMessage } from '../lib/types';

interface ChatBoxProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isOverlay?: boolean;
  onClose?: () => void;
}

export const ChatBox: React.FC<ChatBoxProps> = ({ messages, onSendMessage, isOverlay = false, onClose }) => {
  const [inputText, setInputText] = useState('');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const containerClasses = isOverlay
    ? 'flex flex-col h-full w-full max-w-sm ml-auto bg-black/40 backdrop-blur-md border-l border-white/10 rounded-r-2xl pointer-events-auto'
    : 'flex flex-col h-96 w-full bg-neutral-900/90 border border-neutral-800 rounded-xl overflow-hidden';

  return (
    <div className={containerClasses}>
      {/* Header */}
      <div className={`flex items-center gap-2 p-3 ${isOverlay ? 'bg-black/20' : 'bg-neutral-900 border-b border-neutral-800'}`}>
        {onClose && (
          <button 
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
            onTouchStart={(e) => { e.stopPropagation(); }}
            className="p-1.5 mr-1 bg-black/40 hover:bg-rose-600 active:scale-95 text-white rounded-full transition-all cursor-pointer pointer-events-auto"
            title="Close Chat"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <MessageSquare className="w-4 h-4 text-rose-500" />
        <h3 className="font-semibold text-white text-sm flex-1">Room Chat</h3>
      </div>

      {/* Messages Area */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-neutral-700"
      >
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-neutral-500 italic">
            No messages yet. Say hi!
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="flex flex-col gap-0.5">
              <span className="text-[10px] text-neutral-400 font-medium px-1">{msg.senderName}</span>
              <div className="bg-neutral-800/80 w-fit max-w-[90%] px-3 py-2 rounded-2xl rounded-tl-sm text-sm text-white shadow-sm">
                {msg.text}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Input Area */}
      <div className="p-3 bg-black/20">
        <form onSubmit={handleSend} className="flex items-center gap-2 relative">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type a message..."
            className="w-full bg-neutral-800/80 border border-neutral-700 rounded-full pl-4 pr-10 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-all"
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            className="absolute right-1.5 p-1.5 bg-rose-600 hover:bg-rose-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-full transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
