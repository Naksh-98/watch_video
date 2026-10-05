import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface UseWebRTCProps {
  socket: Socket | null;
  partnerId: string | null;
}

export function useWebRTC({ socket, partnerId }: UseWebRTCProps) {
  const [isInCall, setIsInCall] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected' | 'error'>('idle');
  const [partnerVolume, setPartnerVolume] = useState(1.0);

  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize remote audio element
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const audio = new Audio();
      audio.autoplay = true;
      remoteAudioRef.current = audio;
    }
  }, []);

  // Update remote audio volume
  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = partnerVolume;
    }
  }, [partnerVolume]);

  const startCall = async () => {
    if (!socket || !partnerId) return;

    try {
      setCallStatus('calling');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection(ICE_SERVERS);
      peerConnectionRef.current = pc;

      // Add local audio tracks
      stream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Handle remote audio stream
      pc.ontrack = (event) => {
        if (remoteAudioRef.current && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
          setCallStatus('connected');
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('webrtc_ice', {
            targetId: partnerId,
            candidate: event.candidate,
          });
        }
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('webrtc_offer', {
        targetId: partnerId,
        offer,
      });

      setIsInCall(true);
    } catch (err) {
      console.error('Failed to start voice call:', err);
      setCallStatus('error');
    }
  };

  const endCall = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    setIsInCall(false);
    setCallStatus('idle');
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  // Socket signaling listeners
  useEffect(() => {
    if (!socket) return;

    // Handle incoming offer
    const handleOffer = async (data: { senderId: string; offer: RTCSessionDescriptionInit }) => {
      try {
        setCallStatus('calling');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        localStreamRef.current = stream;

        const pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnectionRef.current = pc;

        stream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, stream);
        });

        pc.ontrack = (event) => {
          if (remoteAudioRef.current && event.streams[0]) {
            remoteAudioRef.current.srcObject = event.streams[0];
            setCallStatus('connected');
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate && socket) {
            socket.emit('webrtc_ice', {
              targetId: data.senderId,
              candidate: event.candidate,
            });
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('webrtc_answer', {
          targetId: data.senderId,
          answer,
        });

        setIsInCall(true);
      } catch (err) {
        console.error('Failed to answer call:', err);
        setCallStatus('error');
      }
    };

    // Handle incoming answer
    const handleAnswer = async (data: { senderId: string; answer: RTCSessionDescriptionInit }) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        setCallStatus('connected');
      }
    };

    // Handle incoming ICE candidate
    const handleIceCandidate = async (data: { senderId: string; candidate: RTCIceCandidateInit }) => {
      if (peerConnectionRef.current && data.candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error('Error adding ICE candidate', e);
        }
      }
    };

    socket.on('webrtc_offer', handleOffer);
    socket.on('webrtc_answer', handleAnswer);
    socket.on('webrtc_ice', handleIceCandidate);

    return () => {
      socket.off('webrtc_offer', handleOffer);
      socket.off('webrtc_answer', handleAnswer);
      socket.off('webrtc_ice', handleIceCandidate);
    };
  }, [socket]);

  return {
    isInCall,
    isMuted,
    callStatus,
    partnerVolume,
    startCall,
    endCall,
    toggleMute,
    setPartnerVolume,
  };
}
