/**
 * Distillation: turns a batch of conversation events into facts and an episode.
 *
 * This is the judgement layer of the memory system, and the part most likely to
 * make the companion feel either attentive or creepy. Two rules shape it:
 *
 *   1. STORE WHAT THE USER CHOSE TO TELL US, not everything they said. A
 *      companion that remembers every passing remark is unsettling; one that
 *      remembers what mattered is attentive. The prompt asks for durable facts,
 *      not a transcript summary.
 *
 *   2. A CONTRADICTION IS A SUPERSEDE, NOT A NEW FACT. "No, I told you I moved"
 *      must retire the old fact rather than sit alongside it. Without this a
 *      companion accumulates contradictions and eventually asserts both.
 */

import type { Fact, FactKind, MemWriteEvent } from "../domain/types.ts";
import type { LlmClient } from "../providers/llm-client.ts";

export type DistilledFact = {
  text: string;
  kind: FactKind;
  salience: number;
  confidence: number;
  /** Text of an existing fact this contradicts, if any. */
  supersedes_text?: string;
};

export type Distillation = {
  facts: DistilledFact[];
  summary: string;
  topics: string[];
  open_threads: string[];
  mood?: "positive" | "neutral" | "negative" | "mixed";
};

const FACT_KINDS: FactKind[] = [
  "preference",
  "biographical",
  "relationship",
  "commitment",
  "aversion",
];

const SYSTEM = `You distil durable facts from a conversation between a person and their companion assistant.

Return ONLY a JSON object, no prose, of this shape:
{
  "facts": [{"text": string, "kind": one of ${FACT_KINDS.map((k) => `"${k}"`).join("|")}, "salience": 0..1, "confidence": 0..1, "supersedes_text": string?}],
  "summary": string,
  "topics": [string],
  "open_threads": [string],
  "mood": "positive"|"neutral"|"negative"|"mixed"
}

Rules:
- Record only things worth remembering weeks later: stated preferences, biographical details, relationships, commitments made, things they dislike.
- Do NOT record small talk, transient state, or anything the person did not volunteer about themselves.
- Write each fact in the third person about the person, in the language they used.
- If a statement contradicts something listed under EXISTING FACTS, put that existing fact's exact text in "supersedes_text".
- "open_threads" are things left unfinished that they would expect to be picked up next time.
- Prefer fewer, higher-quality facts. An empty list is a valid answer.`;

export interface Distiller {
  distil(events: MemWriteEvent[], existing: Fact[]): Promise<Distillation>;
}

export class LlmDistiller implements Distiller {
  readonly #llm: LlmClient;

  constructor(llm: LlmClient) {
    this.#llm = llm;
  }

  async distil(events: MemWriteEvent[], existing: Fact[]): Promise<Distillation> {
    const transcript = events
      .filter((e) => e.kind === "turn_completed" || e.kind === "correction")
      .map((e) => {
        const parts: string[] = [];
        if (e.user_text) parts.push(`PERSON: ${e.user_text}`);
        if (e.agent_text) parts.push(`ASSISTANT: ${e.agent_text}`);
        return parts.join("\n");
      })
      .filter(Boolean)
      .join("\n");

    if (transcript.trim() === "") return emptyDistillation();

    const existingBlock =
      existing.length > 0
        ? `EXISTING FACTS:\n${existing.map((f) => `- ${f.text}`).join("\n")}\n\n`
        : "";

    let raw = "";
    for await (const chunk of this.#llm.stream(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${existingBlock}CONVERSATION:\n${transcript}` },
      ],
      { temperature: 0.2 },
    )) {
      // Distillation is prose-only; no tools are offered here.
      if (chunk.type === "text") raw += chunk.text;
    }

    return parseDistillation(raw);
  }
}

export function emptyDistillation(): Distillation {
  return { facts: [], summary: "", topics: [], open_threads: [] };
}

/**
 * Parse defensively. A malformed distillation must degrade to "learned nothing
 * this session", never to a crashed worker or a garbage fact — a bad fact is
 * harder to undo than a missing one.
 */
export function parseDistillation(raw: string): Distillation {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return emptyDistillation();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return emptyDistillation();
  }

  const rawFacts = Array.isArray(parsed["facts"]) ? (parsed["facts"] as unknown[]) : [];
  const facts: DistilledFact[] = [];

  for (const f of rawFacts) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    const text = typeof o["text"] === "string" ? o["text"].trim() : "";
    if (text === "") continue;

    const kind = FACT_KINDS.includes(o["kind"] as FactKind)
      ? (o["kind"] as FactKind)
      : "biographical";

    const fact: DistilledFact = {
      text,
      kind,
      salience: clamp01(o["salience"], 0.5),
      confidence: clamp01(o["confidence"], 0.6),
    };
    if (typeof o["supersedes_text"] === "string" && o["supersedes_text"].trim() !== "") {
      fact.supersedes_text = o["supersedes_text"].trim();
    }
    facts.push(fact);
  }

  const out: Distillation = {
    facts,
    summary: typeof parsed["summary"] === "string" ? parsed["summary"] : "",
    topics: strArray(parsed["topics"]),
    open_threads: strArray(parsed["open_threads"]),
  };

  const mood = parsed["mood"];
  if (mood === "positive" || mood === "neutral" || mood === "negative" || mood === "mixed") {
    out.mood = mood;
  }
  return out;
}

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}
