import { useEffect, useRef, useState } from "react";
import { socket } from "./socket";

// Type definitions for WebRTC signaling data
interface SignalingData {
  type?: "offer" | "answer" | "ready";
  sdp?: string;
  candidate?: RTCIceCandidateInit | string;
}

const App = () => {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState("Initializing...");
  const [callStatus, setCallStatus] = useState("Waiting for call...");
  const [isCallActive, setIsCallActive] = useState(false);
  const REACT_APP_DEVICE_ID = "dashcam-001";

  // Helper function to safely stop media tracks
  const stopMediaTracks = (stream: MediaStream | null) => {
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.stop();
        console.log(`Stopped ${track.kind} track`);
      });
    }
  };

  // Parse string-based ICE candidate to RTCIceCandidateInit
  const parseIceCandidate = (candidate: RTCIceCandidateInit | string): RTCIceCandidateInit | null => {
    if (typeof candidate === "string") {
      try {
        const parts = candidate.match(/candidate:(\S+) (\d+) (\w+) (\d+) (\S+) (\d+) typ (\w+)(.*)/);
        if (!parts) {
          console.warn("Failed to parse ICE candidate string:", candidate);
          return null;
        }
        const [, foundation, component, protocol, priority, ip, port, type, rest] = parts;
        const candidateObj: RTCIceCandidateInit = {
          candidate: `candidate:${foundation} ${component} ${protocol} ${priority} ${ip} ${port} typ ${type}${rest}`,
          sdpMid: rest.match(/sdpMid (\S+)/)?.[1] || "0",
          sdpMLineIndex: parseInt(rest.match(/sdpMLineIndex (\d+)/)?.[1] || "0"),
          usernameFragment: rest.match(/ufrag (\S+)/)?.[1] || undefined,
        };
        return candidateObj;
      } catch (err) {
        console.error("Error parsing ICE candidate string:", err);
        return null;
      }
    }
    return candidate as RTCIceCandidateInit;
  };

  // Initialize media and WebSocket connection
  const init = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;
      setStatus("Microphone access granted");
      console.log("Mic access granted, tracks:", stream.getTracks());
    } catch (err: any) {
      console.error("Mic access error:", err);
      setStatus(`Microphone error: ${err.name} - ${err.message}`);
    }
  };

  useEffect(() => {
    init();

    // Handle WebSocket connection
    socket.on("connect", () => {
      const deviceId = REACT_APP_DEVICE_ID || "dashcam-001";
      socket.emit("dashcam-join", deviceId);
      socket.emit("video-dashcam-join", deviceId);
      setStatus(`Connected as ${deviceId}`);
      console.log("Socket connected:", socket.id);
    });

    socket.on("connect_error", (err) => {
      console.error("Socket connection error:", err);
      setStatus(`Socket connection failed: ${err.message}`);
    });

    socket.on("reconnect", () => {
      setStatus("Reconnected to server");
      const deviceId = REACT_APP_DEVICE_ID || "dashcam-001";
      socket.emit("dashcam-join", deviceId);
      socket.emit("video-dashcam-join", deviceId);
      console.log("Socket reconnected, re-registered as:", deviceId);
    });

    const handleIncomingCall = async (adminSocketId: string, isVideo: boolean) => {
      setCallStatus(`Incoming ${isVideo ? "video" : "audio"} call - Setting up connection...`);
      setIsCallActive(true);

      // Clean up existing stream
      stopMediaTracks(localStreamRef.current);
      localStreamRef.current = null;

      try {
        const mediaConstraints = isVideo
          ? {
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15 },
              },
            }
          : {
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            };

        const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        localStreamRef.current = stream;

        const videoTracks = stream.getVideoTracks();
        const audioTracks = stream.getAudioTracks();
        console.log(`Got ${videoTracks.length} video tracks, ${audioTracks.length} audio tracks`, {
          video: videoTracks.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })),
          audio: audioTracks.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })),
        });

        setCallStatus(`${isVideo ? "Camera and microphone" : "Microphone"} access granted`);
      } catch (err: any) {
        console.error("Media access error:", err);
        setCallStatus(`Media error: ${err.name} - ${err.message}`);
        setIsCallActive(false);
        socket.emit(isVideo ? "video-call-ended" : "call-ended", { to: adminSocketId });
        return;
      }

      // Clean up existing peer connection
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelay",
            credential: "openrelay",
          },
        ],
      });
      pcRef.current = pc;

      // Add tracks to peer connection
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          console.log(`Adding ${track.kind} track to peer connection:`, {
            readyState: track.readyState,
            enabled: track.enabled,
            settings: track.getSettings(),
          });
          pc.addTrack(track, localStreamRef.current!);
        });
      }

      // Handle incoming audio tracks only for audio calls
      pc.ontrack = (event) => {
        console.log("Received track from admin:", event.track.kind, {
          id: event.track.id,
          enabled: event.track.enabled,
          readyState: event.track.readyState,
        });
        if (event.track.kind === "audio" && remoteAudioRef.current && !isVideo) {
          const [remoteStream] = event.streams;
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play().catch((err) => {
            console.error("Remote audio play failed:", err);
            setCallStatus(`Audio play error: ${err.message}`);
          });
        } else if (event.track.kind === "audio" && isVideo) {
          console.log("Ignoring admin audio track during video call");
          event.track.stop();
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("Sending ICE candidate:", {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          });
          socket.emit(isVideo ? "webrtc-video-signal" : "webrtc-signal", {
            to: adminSocketId,
            data: {
              candidate: {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
                usernameFragment: event.candidate.usernameFragment,
              },
            },
          });
        }
      };

      // Monitor ICE connection state
      pc.oniceconnectionstatechange = () => {
        console.log("ICE connection state:", pc.iceConnectionState);
        if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
          setCallStatus("ICE connection failed");
          setIsCallActive(false);
          socket.emit(isVideo ? "video-call-ended" : "call-ended", { to: adminSocketId });
        }
      };

      // Monitor connection state
      pc.onconnectionstatechange = () => {
        console.log("Connection state:", pc.connectionState);
        if (pc.connectionState === "connected") {
          setCallStatus(`${isVideo ? "Video and audio" : "Audio"} active`);
        } else if (pc.connectionState === "failed") {
          setCallStatus("Connection failed");
          setIsCallActive(false);
          socket.emit(isVideo ? "video-call-ended" : "call-ended", { to: adminSocketId });
        } else if (pc.connectionState === "disconnected") {
          setCallStatus("Disconnected");
          setIsCallActive(false);
          socket.emit(isVideo ? "video-call-ended" : "call-ended", { to: adminSocketId });
        } else {
          setCallStatus(`Connecting... (${pc.connectionState})`);
        }
      };

      // Signal readiness to admin
      socket.emit(isVideo ? "webrtc-video-signal" : "webrtc-signal", {
        to: adminSocketId,
        data: { type: "ready" },
      });

      setCallStatus(`Ready - Waiting for ${isVideo ? "video" : "audio"} offer...`);
    };

    socket.on("incoming-call", ({ adminSocketId }: { adminSocketId: string }) => {
      console.log("Received incoming audio call from:", adminSocketId);
      handleIncomingCall(adminSocketId, false);
    });

    socket.on("incoming-video-call", ({ adminSocketId }: { adminSocketId: string }) => {
      console.log("Received incoming video call from:", adminSocketId);
      handleIncomingCall(adminSocketId, true);
    });

    socket.on("webrtc-signal", async ({ from, data }: { from: string; data: SignalingData }) => {
      const pc = pcRef.current;
      if (!pc) return;

      try {
        if (data.type === "offer") {
          console.log("Received audio offer from admin:", data);
          await pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("webrtc-signal", {
            to: from,
            data: pc.localDescription,
          });
          console.log("Sent audio answer to:", from);
          setCallStatus("Answer sent - Establishing audio connection...");
        } else if (data.candidate) {
          console.log("Received ICE candidate:", data.candidate);
          const candidate = parseIceCandidate(data.candidate);
          if (candidate && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log("Added ICE candidate:", candidate);
          } else {
            console.warn("Invalid or unprocessable ICE candidate:", data.candidate);
          }
        }
      } catch (err) {
        console.error("Error handling WebRTC signal:", err);
        setCallStatus(`WebRTC error: ${err}`);
      }
    });

    socket.on("webrtc-video-signal", async ({ from, data }: { from: string; data: SignalingData }) => {
      const pc = pcRef.current;
      if (!pc) return;

      try {
        if (data.type === "offer") {
          console.log("Received video offer from admin:", data);
          await pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("webrtc-video-signal", {
            to: from,
            data: pc.localDescription,
          });
          console.log("Sent video answer to:", from);
          setCallStatus("Answer sent - Establishing video connection...");
        } else if (data.candidate) {
          console.log("Received ICE candidate:", data.candidate);
          const candidate = parseIceCandidate(data.candidate);
          if (candidate && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log("Added ICE candidate:", candidate);
          } else {
            console.warn("Invalid or unprocessable ICE candidate:", data.candidate);
          }
        }
      } catch (err) {
        console.error("Error handling WebRTC video signal:", err);
        setCallStatus(`WebRTC video error: ${err}`);
      }
    });

    socket.on("call-ended", () => {
      console.log("Audio call ended by admin");
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      stopMediaTracks(localStreamRef.current);
      localStreamRef.current = null;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
      }
      setCallStatus("Audio call ended");
      setIsCallActive(false);
      setTimeout(() => setCallStatus("Waiting for call..."), 3000);
    });

    socket.on("video-call-ended", () => {
      console.log("Video call ended by admin");
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      stopMediaTracks(localStreamRef.current);
      localStreamRef.current = null;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
      }
      setCallStatus("Video call ended");
      setIsCallActive(false);
      setTimeout(() => setCallStatus("Waiting for call..."), 3000);
    });

    socket.on("disconnect", () => {
      setStatus("Disconnected from server");
      setCallStatus("Disconnected");
      setIsCallActive(false);
    });

    // Cleanup on unmount
    return () => {
      socket.off("connect");
      socket.off("connect_error");
      socket.off("reconnect");
      socket.off("incoming-call");
      socket.off("incoming-video-call");
      socket.off("webrtc-signal");
      socket.off("webrtc-video-signal");
      socket.off("call-ended");
      socket.off("video-call-ended");
      socket.off("disconnect");

      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      stopMediaTracks(localStreamRef.current);
      localStreamRef.current = null;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
      }
    };
  }, []);

  return (
    <div style={{ padding: "20px", fontFamily: "Arial, sans-serif" }}>
      <h1>Dashcam Device</h1>

      <div style={{ marginBottom: "20px" }}>
        <div>
          <strong>Status:</strong> {status}
        </div>
        <div>
          <strong>Call Status:</strong> {callStatus}
        </div>
      </div>

      {isCallActive && !callStatus.includes("video") && (
        <div style={{ marginBottom: "20px", padding: "15px", backgroundColor: "#f5f5f5", borderRadius: "8px" }}>
          <h3 style={{ margin: "0 0 10px 0", fontSize: "16px" }}>Admin Audio</h3>
          <audio ref={remoteAudioRef} controls style={{ width: "100%" }} autoPlay playsInline />
          <div style={{ fontSize: "12px", color: "#666", marginTop: "5px" }}>
            Audio from admin
          </div>
        </div>
      )}

      <div style={{ marginTop: "20px", fontSize: "14px", color: "#666" }}>
        Device ID: {REACT_APP_DEVICE_ID || "dashcam-001"}
        <br />
        Call Type: {isCallActive ? (callStatus.includes("video") ? "Video Call Active" : "Audio Call Active") : "Standby"}
        <br />
        Socket ID: {socket.id || "Not connected"}
      </div>
    </div>
  );
};

export default App;