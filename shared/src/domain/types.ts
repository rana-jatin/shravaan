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

/**
 * `gate.*` keys come from the speakability gate. `degraded.*` keys come from
 * slice 8 and are spoken ONLY when a degradation ends the session — see
 * src/domain/degradation.ts for why shallow degradations stay silent.
 */
export type MessageKey =
  | "gate.unsupported_language"
  | "gate.switch_declined"
  | "degraded.voice_unavailable"
  | "degraded.hearing_unavailable"
  | "degraded.thinking_unavailable"
  /** The exception: announces a failed TURN, not a degraded state. */
  | "degraded.turn_failed";

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
// Long-term memory — docs/02-data-contracts.md sections 3 and 4
// ---------------------------------------------------------------------------

export type MemWriteKind = "turn_completed" | "session_closed" | "explicit_recall" | "correction";

export type MemWriteEvent = {
  /** ULID. Idempotency key — streams are at-least-once. */
  event_id: string;
  sid: string;
  uid: string;
  tid: number;
  at: Iso8601;
  kind: MemWriteKind;

  user_text?: string;
  agent_text?: string;
  language?: LanguageCode;

  turn_count?: number;
  duration_s?: number;

  /** Present on `correction`: the user contradicted a stored fact. */
  supersedes_fact_id?: string;

  /** Signals for distillation priority, not conclusions. */
  hints?: {
    named_entities?: string[];
    stated_preference?: boolean;
    emotional_salience?: "low" | "medium" | "high";
  };
};

export type FactKind = "preference" | "biographical" | "relationship" | "commitment" | "aversion";

export type Fact = {
  id: string;
  uid: string;
  /** Canonical, first person about the user. */
  text: string;
  embedding: number[];
  kind: FactKind;
  /** 0..1, decays without reinforcement. */
  salience: number;
  confidence: number;
  first_seen: Iso8601;
  last_reinforced: Iso8601;

  /** Supersede chain — new facts do not delete old ones. */
  supersedes: string | null;
  superseded_by: string | null;
  /** Soft delete. Never hard-delete: the log must stay explicable. */
  deleted_at: Iso8601 | null;
  deleted_reason: "superseded" | "user_requested" | "low_confidence" | null;

  /** Provenance, so any fact traces back to the turn that produced it. */
  source_event_id: string;
  source_sid: string;
};

/**
 * Retrospective wellbeing signals for one session. Written by the memory worker,
 * never by the turn loop — see src/domain/care-signals.ts and ADR 0009.
 *
 * OPTIONAL AT EVERY LEVEL, AND THAT IS THE CONTRACT. The whole object is absent
 * when the session was not analysed (not English, too short, feature off, or the
 * provider was down), and each field is absent when the provider did not return
 * it. A reader must never treat a missing score as a neutral one: "we did not
 * look" and "we looked and they were fine" are different weeks.
 */
export type CareSignals = {
  provider: "deepgram";
  analysed_at: Iso8601;
  /** Whole-transcript average. `score` is -1..1; the label is Deepgram's banding. */
  sentiment?: { label: "positive" | "neutral" | "negative"; score: number };
  /** Per-segment scores in spoken order — enough to see a shift within one session. */
  sentiment_segments?: number[];
  /** Watch-list intents that fired, strongest first. Never an alarm; see care-signals.ts. */
  flagged_intents?: Array<{ intent: string; confidence: number; text: string }>;
};

export type Episode = {
  id: string;
  uid: string;
  sid: string;
  started_at: Iso8601;
  ended_at: Iso8601;
  turn_count: number;
  /** Every language observed in the session. */
  languages: LanguageCode[];
  summary: string;
  topics: string[];
  /** Threads left open — seeds the next session's greeting. */
  open_threads: Array<{ id: string; text: string }>;
  /** Join key back to the semantic store. */
  fact_ids: string[];
  mood?: "positive" | "neutral" | "negative" | "mixed";
  /**
   * Third-party analysis of this session, when one ran. Distinct from `mood`,
   * which is the distiller's own read in the user's own language and is always
   * available; this is numeric, English-only and frequently absent.
   */
  signals?: CareSignals;
};

// ---------------------------------------------------------------------------
// Turn state machine — docs/01-architecture.md section 4
// ---------------------------------------------------------------------------

export type TurnPhase =
  "idle" | "listening" | "user_speaking" | "thinking" | "tool_wait" | "speaking" | "interrupted";

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
