import { useCallback, useEffect, useRef, useState } from "react";
import { MicStreamer, PcmPlayer } from "./pcmAudio";

/**
 * Speaks the device <-> server protocol documented at the top of
 * ai/scripts/device-client.ts:
 *
 *   device -> server   json    : { type: "hello", uid, sid?, locale_hint? }
 *   device -> server   binary  : linear16 PCM @ ASR_SAMPLE_RATE, mono
 *   server -> device   json    : ready | notice | clear_audio | session_closed
 *                                play_media | stop_media | set_media_volume
 *   server -> device   binary  : linear16 PCM @ TTS_SAMPLE_RATE, mono
 *
 * play_media / stop_media / set_media_volume are logged, not acted on — this
 * is a voice-turn tester, not a media player. See device-client.ts's
 * MediaPlayer for what that needs (ducking, a media resolver).
 */

export type ConnectionStatus = "idle" | "connecting" | "ready" | "closed" | "error";

export type ControlMessage = { type: string; [key: string]: unknown };

export type ConnectOptions = {
  localeHint?: string;
  resumeSid?: string;
};

export type DeviceSocketState = {
  status: ConnectionStatus;
  sid: string | null;
  lastSid: string | null;
  lastMessage: ControlMessage | null;
  talking: boolean;
  error: string | null;
  connect: (url: string, opts?: ConnectOptions) => void;
  disconnect: () => void;
  toggleTalk: () => void;
};

export function useDeviceSocket(): DeviceSocketState {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sid, setSid] = useState<string | null>(null);
  const [lastSid, setLastSid] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<ControlMessage | null>(null);
  const [talking, setTalking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const micRef = useRef<MicStreamer | null>(null);

  const stopTalking = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    setTalking(false);
  }, []);

  const disconnect = useCallback(() => {
    stopTalking();
    playerRef.current?.close();
    playerRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
  }, [stopTalking]);

  const connect = useCallback(
    (url: string, opts: ConnectOptions = {}) => {
      disconnect();
      setStatus("connecting");
      setError(null);
      setSid(null);

      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;
      playerRef.current = new PcmPlayer();

      ws.addEventListener("open", () => {
        const hello: Record<string, unknown> = { type: "hello", uid: crypto.randomUUID() };
        if (opts.resumeSid) hello["sid"] = opts.resumeSid;
        if (opts.localeHint) hello["locale_hint"] = opts.localeHint;
        ws.send(JSON.stringify(hello));
      });

      ws.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data !== "string") {
          playerRef.current?.write(event.data);
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
          setLastSid(msg["sid"]);
          setStatus("ready");
        } else if (msg["type"] === "clear_audio") {
          playerRef.current?.flush();
        } else if (msg["type"] === "session_closed") {
          setStatus("closed");
        }
      });

      ws.addEventListener("close", () => {
        stopTalking();
        setStatus((current) => (current === "error" ? current : "closed"));
      });

      ws.addEventListener("error", () => {
        setStatus("error");
        setError("WebSocket error — is the backend running and reachable at this URL?");
      });
    },
    [disconnect, stopTalking],
  );

  const toggleTalk = useCallback(() => {
    if (talking) {
      stopTalking();
      return;
    }
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const mic = new MicStreamer();
    micRef.current = mic;
    mic
      .start((frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      })
      .then(() => setTalking(true))
      .catch((err: unknown) => {
        micRef.current = null;
        setError(err instanceof Error ? err.message : "Could not access the microphone.");
      });
  }, [talking, stopTalking]);

  useEffect(() => disconnect, [disconnect]);

  return {
    status,
    sid,
    lastSid,
    lastMessage,
    talking,
    error,
    connect,
    disconnect,
    toggleTalk,
  };
}
