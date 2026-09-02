import { useEffect, useRef, useState } from "react";
import { viewerSocketUrl } from "../api";

interface FrameMessage {
  type: "frame";
  data: string;
}

export function Viewer({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket(viewerSocketUrl(sessionId));
    socketRef.current = socket;

    socket.addEventListener("open", () => setConnected(true));
    socket.addEventListener("close", () => setConnected(false));
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as FrameMessage;
      if (message.type === "frame") {
        setFrameSrc(`data:image/jpeg;base64,${message.data}`);
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="viewer">
      <div className="viewer-header">
        <span>{connected ? "Live" : "Connecting…"}</span>
        <button type="button" onClick={onClose}>
          Close viewer
        </button>
      </div>
      {frameSrc ? (
        <img src={frameSrc} alt="Live session screen" data-testid="viewer-frame" />
      ) : (
        <p>Waiting for the first frame…</p>
      )}
    </div>
  );
}
