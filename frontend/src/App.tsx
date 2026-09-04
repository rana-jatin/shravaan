import { useState } from "react";
import { useDeviceSocket } from "./useDeviceSocket";

const DEFAULT_URL = "ws://localhost:8080";

// Mirrors the 11 speakable codes in shared/src/config/languages.json.
// Duplicated rather than imported: frontend/ talks to the backend only over
// the WS protocol and doesn't otherwise reach into the Node package graph.
const SPEAKABLE_LANGUAGES: { code: string; name: string }[] = [
  { code: "hi-IN", name: "Hindi" },
  { code: "bn-IN", name: "Bengali" },
  { code: "ta-IN", name: "Tamil" },
  { code: "te-IN", name: "Telugu" },
  { code: "gu-IN", name: "Gujarati" },
  { code: "kn-IN", name: "Kannada" },
  { code: "ml-IN", name: "Malayalam" },
  { code: "mr-IN", name: "Marathi" },
  { code: "pa-IN", name: "Punjabi" },
  { code: "or-IN", name: "Odia" },
  { code: "en-IN", name: "English" },
];

const STATUS_LABEL: Record<string, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  ready: "Ready",
  closed: "Closed",
  error: "Error",
};

export function App() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [locale, setLocale] = useState("");
  const [resume, setResume] = useState(false);
  const { status, sid, lastSid, lastMessage, talking, error, connect, disconnect, toggleTalk } =
    useDeviceSocket();

  const connected = status === "ready" || status === "connecting";

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "3rem auto" }}>
      <h1>SP-I companion dashboard</h1>
      <p style={{ color: "#666" }}>
        A voice-turn tester: connects as a device, streams the mic, and plays back replies. Not a
        product UI — no transcript, no history, no media playback.
      </p>

      <section style={{ margin: "1.5rem 0" }}>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1, padding: "0.5rem" }}
            disabled={connected}
          />
          {connected ? (
            <button onClick={disconnect}>Disconnect</button>
          ) : (
            <button
              onClick={() =>
                connect(url, {
                  localeHint: locale || undefined,
                  resumeSid: resume ? (lastSid ?? undefined) : undefined,
                })
              }
            >
              Connect
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginTop: "0.5rem" }}>
          <label>
            Starting language:{" "}
            <select value={locale} onChange={(e) => setLocale(e.target.value)} disabled={connected}>
              <option value="">(let the server pick)</option>
              {SPEAKABLE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          {lastSid && (
            <label>
              <input
                type="checkbox"
                checked={resume}
                disabled={connected}
                onChange={(e) => setResume(e.target.checked)}
              />{" "}
              Resume last session
            </label>
          )}
        </div>

        <div style={{ marginTop: "0.5rem" }}>
          <button
            onClick={toggleTalk}
            disabled={status !== "ready"}
            style={{
              padding: "0.75rem 1.5rem",
              background: talking ? "#c0392b" : undefined,
              color: talking ? "white" : undefined,
            }}
          >
            {talking ? "Stop talking" : "Start talking"}
          </button>
          <span style={{ marginLeft: "0.75rem", color: "#666" }}>
            {talking
              ? "Streaming mic audio — replies play back automatically."
              : "Needs mic permission the first time."}
          </span>
        </div>
      </section>

      <dl>
        <dt>Status</dt>
        <dd>{STATUS_LABEL[status] ?? status}</dd>
        <dt>Session id</dt>
        <dd>{sid ?? "—"}</dd>
        <dt>Last control message</dt>
        <dd>
          <pre>{lastMessage ? JSON.stringify(lastMessage, null, 2) : "—"}</pre>
        </dd>
      </dl>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
