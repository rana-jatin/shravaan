/**
 * Data contracts. Mirrors docs/02-data-contracts.md.
 * Keep this file and that document in sync — the doc is the spec, this is the code.
 */

export type LanguageCode = string; // BCP-47, e.g. "hi-IN"
export type Iso8601 = string; // RFC 3339 UTC

// ---------------------------------------------------------------------------
// Speakability gate — docs/06-speakability-gate.md
// ---------------------------------------------------------------------------

export type SpeakabilityVerdict =
  | { status: "speakable"; code: LanguageCode }
  | { status: "heard_not_speakable"; code: LanguageCode; confidence?: number }
  | { status: "out_of_scope"; code: LanguageCode }
  | { status: "uncertain"; code: LanguageCode | null; confidence?: number };

export type GateNumber = 1 | 2 | 3;

export type GateAction =
  | "proceed"
  | "refuse_pre_connect"
  | "refuse_and_close"
  | "decline_switch"
  | "fallback_to_seed"
  | "reprompt";

export type GateDecision = {
  verdict: SpeakabilityVerdict;
  gate: GateNumber;
  action: GateAction;
  /**
   * Language the refusal or acknowledgement is SPOKEN in. Always speakable.
   * Required, not optional: this is the field that stops the gate committing
   * the exact bug it exists to catch.
   */
  respond_in: LanguageCode;
  /** Key into pre-written copy. Never a literal string. */
  message_key?: MessageKey;
};

export type MessageKey = "gate.unsupported_language" | "gate.switch_declined";

// ---------------------------------------------------------------------------
// JSON context — read-only, from our backend
// ---------------------------------------------------------------------------

export type Entitlement = {
  key: string;
  granted: boolean;
  expires_at: string | null;
};

export type JsonContext = {
  uid: string;
  fetched_at: Iso8601;
  etag?: string;
  identity: {
    display_name: string;
    preferred_name?: string;
    /** As stated by the user. Absent means use they/them. */
    pronouns?: string;
    /** A hint for the opening turn only, never a lock. */
    locale_hint?: LanguageCode;
    timezone?: string;
  };
  account?: {
    tier?: string;
    status?: "active" | "suspended" | "trial" | "closed";
    created_at?: Iso8601;
  };
  entitlements: Entitlement[];
  history?: Array<{
    kind: string;
    id: string;
    occurred_at: Iso8601;
    summary?: string;
  }>;
};

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export type LanguageSource = "profile" | "context" | "detected" | "user_stated" | "default";

export type SlotValue = {
  value: string | number | boolean | null;
  source: "user" | "context" | "inferred";
  /** Absent on the Sarvam path — no ASR confidence is documented. See docs/05 Q4. */
  asr_confidence?: number;
  filled_at: Iso8601;
  confirmed: boolean;
};

export type SessionState = {
  sid: string;
  user_id: string;
  /** Per-turn observed value, NOT a lock. */
  language: LanguageCode;
  language_source: LanguageSource;
  language_confidence?: number;
  turn_no: number;
  agent_speaking: boolean;
  last_tool: string | null;
  slots: Record<string, SlotValue>;
  started_at: Iso8601;
  last_activity_at: Iso8601;
  asr_provider: "sarvam" | "deepgram";
  degraded: string[];
  /** Gate 3 bookkeeping: acknowledge an unspeakable switch once per session. */
  switch_declined_acknowledged: boolean;
  /** Gate 3 bookkeeping: consecutive turns detected as the same off-set language. */
  pending_switch?: { code: LanguageCode; consecutive: number } | undefined;
};

export type Turn = {
  tid: number;
  role: "user" | "agent";
  text: string;
  /** Per turn, not per session — a code-mixing user produces a mixed window. */
  language: LanguageCode;
  at: Iso8601;
  tool_calls?: Array<{ name: string; ok: boolean }>;
  interrupted?: boolean;
};

export type Profile = {
  uid: string;
  distilled_at: Iso8601;
  /** Sticky preference. Seeds the opening turn; does not lock the session. */
  preferred_language: LanguageCode;
  facts: Array<{ id: string; text: string; salience: number }>;
  recent_episodes: Array<{ id: string; summary: string; at: Iso8601 }>;
  open_threads: Array<{ id: string; text: string; last_touched: Iso8601 }>;
};

// ---------------------------------------------------------------------------
// Turn state machine — docs/01-architecture.md section 4
// ---------------------------------------------------------------------------

export type TurnPhase =
  | "idle"
  | "listening"
  | "user_speaking"
  | "thinking"
  | "tool_wait"
  | "speaking"
  | "interrupted";

export type TurnEvent =
  | { type: "session_open" }
  | { type: "speech_start" }
  | { type: "partial"; text: string }
  | { type: "speech_end"; text: string; language?: LanguageCode; confidence?: number }
  | { type: "first_clause_ready" }
  | { type: "tool_dispatched" }
  | { type: "tool_result" }
  | { type: "playback_drained" }
  | { type: "idle_timeout" };
