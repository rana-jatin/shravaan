import { useState } from "react";
import { useDeviceSocket } from "./useDeviceSocket";

const DEFAULT_URL = "ws://localhost:8080";

const STATUS_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  ready: "Ready",
  closed: "Closed",
  error: "Error",
};

export function App() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const { status, sid, lastMessage, audioFramesReceived, error, connect, disconnect } =
    useDeviceSocket();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "3rem auto" }}>
      <h1>SP-I companion dashboard</h1>
      <p style={{ color: "#666" }}>
        Wiring proof only — connects to the backend over its device WebSocket protocol and shows
        session status. No mic/speaker, no controls yet.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", margin: "1.5rem 0" }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: 1, padding: "0.5rem" }}
          disabled={status === "connecting" || status === "ready"}
        />
        {status === "ready" || status === "connecting" ? (
          <button onClick={disconnect}>Disconnect</button>
        ) : (
          <button onClick={() => connect(url)}>Connect</button>
        )}
      </div>

      <dl>
        <dt>Status</dt>
        <dd>{STATUS_LABEL[status] ?? status}</dd>
        <dt>Session id</dt>
        <dd>{sid ?? "—"}</dd>
        <dt>Audio frames received</dt>
        <dd>{audioFramesReceived}</dd>
        <dt>Last control message</dt>
        <dd>
          <pre>{lastMessage ? JSON.stringify(lastMessage, null, 2) : "—"}</pre>
        </dd>
      </dl>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
