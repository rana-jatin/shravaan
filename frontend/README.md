# frontend

Companion control dashboard. React + Vite + TS, its own eslint/tsconfig
setup — not part of the Node-side `shared → ai → backend` workspace chain,
just an npm workspace member for `npm install`/`npm run dev -w frontend`
convenience.

## What's here

A wiring proof, not a finished UI: `src/useDeviceSocket.ts` speaks the same
device WebSocket protocol documented at the top of
`ai/scripts/device-client.ts` (`hello` → `ready`/`notice`/`session_closed`),
and `src/App.tsx` shows connection status, session id, and the last control
message. No mic/speaker, no controls — those are real product decisions this
starter deliberately doesn't make.

## Running

```bash
npm run frontend        # from repo root — delegates to `npm run dev -w frontend`
```

Needs a running backend (`npm run dev`) to connect to — defaults to
`ws://localhost:8080`, editable in the UI.

## Linting

Excluded from the root `eslint.config.js` (that config is tuned for the
Node/backend side — type-checked rules, no JSX/DOM globals). Add a
browser-appropriate eslint setup here (react-hooks, jsx-a11y, ...) when the
app grows past this starter.
