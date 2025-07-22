import { useEffect, useRef, useState } from "react";
import { socket } from "./socket";

const App = () => {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState("Initializing...");
  const [callStatus, setCallStatus] = useState("Waiting for call...");
  const [isCallActive, setIsCallActive] = useState(false);

  useEffect(() => {
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        localStreamRef.current = stream;
        setStatus("Microphone access granted");
        console.log("Mic access granted");
      } catch (err) {
        console.error("Mic access denied", err);
        setStatus("Microphone access denied");
      }
    };

    init();

    socket.on("connect", () => {
      const deviceId = "dashcam-001";
      socket.emit("dashcam-join", deviceId);
      setStatus(`Connected as ${deviceId}`);
    });

    socket.on("incoming-call", async ({ adminSocketId }: { adminSocketId: string }) => {
      setCallStatus("Incoming call - Setting up connection...");
      setIsCallActive(true);

      if (!localStreamRef.current) {
        setCallStatus("Error: No microphone access");
        return;
      }

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });
      pcRef.current = pc;

      // ✅ Add track (mic) from dashcam to peer
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });

      // ✅ Receive audio from admin and play it
      pc.ontrack = (event) => {
        console.log("Received track from admin");
        const [remoteStream] = event.streams;
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch((err) => {
            console.log("Audio play failed:", err);
          });
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc-signal", { 
            to: adminSocketId, 
            data: event.candidate 
          });
        }
      };

      pc.onconnectionstatechange = () => {
        setCallStatus(`Connection: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          setCallStatus("Call connected - Two-way audio active");
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setCallStatus("Call ended or failed");
          setIsCallActive(false);
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("ICE connection state:", pc.iceConnectionState);
      };

      socket.emit("webrtc-signal", { 
        to: adminSocketId, 
        data: { type: "ready" }
      });

      setCallStatus("Ready - Waiting for offer...");
    });

    socket.on("webrtc-signal", async ({ from, data }: { from: string; data: any }) => {
      const pc = pcRef.current;
      if (!pc) return;

      try {
        if (data.type === "offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socket.emit("webrtc-signal", { 
            to: from, 
            data: pc.localDescription 
          });
          setCallStatus("Answer sent - Establishing connection...");
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data));
        }
      } catch (err) {
        console.error("Error handling WebRTC signal:", err);
      }
    });

    socket.on("call-ended", () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      setCallStatus("Call ended");
      setIsCallActive(false);
      setTimeout(() => setCallStatus("Waiting for call..."), 3000);
    });

    socket.on("disconnect", () => {
      setStatus("Disconnected from server");
      setCallStatus("Disconnected");
      setIsCallActive(false);
    });

    return () => {
      socket.off("connect");
      socket.off("incoming-call");
      socket.off("webrtc-signal");
      socket.off("call-ended");
      socket.off("disconnect");

      if (pcRef.current) pcRef.current.close();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>Dashcam Device</h1>
      
      <div style={{ marginBottom: '20px' }}>
        <div><strong>Status:</strong> {status}</div>
        <div><strong>Call Status:</strong> {callStatus}</div>
      </div>

      {/* Audio Controls */}
      {isCallActive && (
        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
          <h3 style={{ margin: '0 0 10px 0', fontSize: '16px' }}>Audio Controls</h3>
          <audio ref={remoteAudioRef} controls style={{ width: '100%' }} autoPlay playsInline />
          <div style={{ fontSize: '12px', color: '#666', marginTop: '5px' }}>
            Admin audio controls
          </div>
        </div>
      )}

      <div style={{ marginTop: '20px', fontSize: '14px', color: '#666' }}>
        Device ID: dashcam-001
      </div>
    </div>
  );
};

export default App;