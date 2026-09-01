import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Speaks the device <-> server protocol documented at the top of
 * ai/scripts/device-client.ts:
 *
 *   device -> server   json    : { type: "hello", uid, sid?, locale_hint? }
 *   server -> device   json    : ready | notice | clear_audio | session_closed
 *                                play_media | stop_media
 *   server -> device   binary  : linear16 PCM @ TTS_SAMPLE_RATE, mono
 *
 * This hook only does the JSON handshake — no mic/speaker — so it's a wiring
 * proof for the dashboard, not a device implementation. Binary frames are
 * counted, not decoded.
 */

export type ConnectionStatus = "idle" | "connecting" | "ready" | "closed" | "error";

export type ControlMessage = { type: string; [key: string]: unknown };

export type DeviceSocketState = {
  status: ConnectionStatus;
  sid: string | null;
  lastMessage: ControlMessage | null;
  audioFramesReceived: number;
  error: string | null;
  connect: (url: string) => void;
  disconnect: () => void;
};

export function useDeviceSocket(): DeviceSocketState {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sid, setSid] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<ControlMessage | null>(null);
  const [audioFramesReceived, setAudioFramesReceived] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const disconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  const connect = useCallback(
    (url: string) => {
      disconnect();
      setStatus("connecting");
      setError(null);
      setSid(null);
      setAudioFramesReceived(0);

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;

      ws.addEventListener("open", () => {
        const hello = { type: "hello", uid: crypto.randomUUID() };
        ws.send(JSON.stringify(hello));
      });

      ws.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data !== "string") {
          setAudioFramesReceived((n) => n + 1);
          return;
        }
        let msg: ControlMessage;
        try {
          msg = JSON.parse(event.data) as ControlMessage;
        } catch {
          return;
        }
        setLastMessage(msg);
        if (msg["type"] === "ready" && typeof msg["sid"] === "string") {
          setSid(msg["sid"]);
          setStatus("ready");
        } else if (msg["type"] === "session_closed") {
          setStatus("closed");
        }
      });

      ws.addEventListener("close", () => {
        setStatus((current) => (current === "error" ? current : "closed"));
      });

      ws.addEventListener("error", () => {
        setStatus("error");
        setError("WebSocket error — is the backend running and reachable at this URL?");
      });
    },
    [disconnect],
  );

  useEffect(() => disconnect, [disconnect]);

  return { status, sid, lastMessage, audioFramesReceived, error, connect, disconnect };
}
