/**
 * The memory worker: consumes `mem:writes`, distils, and commits.
 *
 * Off the turn path by design — but under strong continuity "eventually
 * consistent" means a companion that forgets what you said an hour ago. Consumer
 * lag is therefore a USER-VISIBLE QUALITY METRIC with an SLO, not queue health
 * trivia. See docs/01-architecture.md section 7.
 */

import { randomUUID } from "node:crypto";
import type { Episode, Fact, MemWriteEvent } from "@sp-i/shared/domain/types.ts";
import type { LongTermStore } from "./long-term-store.ts";
import { buildProfile } from "./profile.ts";
import type { MemWriteStream, StreamEntry } from "./stream.ts";
import type { Distiller } from "./distiller.ts";
import type { SignalsAnalyser } from "./care-signals-analyser.ts";
import type { SessionStore } from "../store/session-store.ts";

export type WorkerOptions = {
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  /** Lag above this is reported as an SLO breach. */
  lagSloEntries?: number;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
};

export type CommitResult = {
  factsWritten: number;
  factsSuperseded: number;
  factsReinforced: number;
  episodesWritten: number;
  eventsProcessed: number;
  duplicatesSkipped: number;
};

export class MemoryWorker {
  readonly #stream: MemWriteStream;
  readonly #longTerm: LongTermStore;
  readonly #sessions: SessionStore;
  readonly #distiller: Distiller;
  readonly #opts: Required<Omit<WorkerOptions, "log" | "now">> & {
    log: NonNullable<WorkerOptions["log"]>;
    now: () => Date;
  };

  /**
   * Idempotency ledger. Streams are at-least-once, and a worker restart
   * mid-batch would otherwise duplicate facts — which in a companion reads as
   * the bot repeating itself.
   *
   * In-process here. A multi-replica deployment needs this in Redis; noted in
   * docs/05-open-questions.md rather than pretended away.
   */
  readonly #processed = new Set<string>();
  readonly #signals: SignalsAnalyser | null;
  #running = false;

  constructor(deps: {
    stream: MemWriteStream;
    longTerm: LongTermStore;
    sessions: SessionStore;
    distiller: Distiller;
    /**
     * Optional third-party read of the closing session. Absent — the default —
     * means episodes carry the distiller's `mood` and nothing else, which is the
     * behaviour every deployment had before ADR 0009 and the one nine of our
     * eleven languages will always have.
     */
    signals?: SignalsAnalyser;
    options?: WorkerOptions;
  }) {
    this.#stream = deps.stream;
    this.#longTerm = deps.longTerm;
    this.#sessions = deps.sessions;
    this.#distiller = deps.distiller;
    this.#signals = deps.signals ?? null;
    const o = deps.options ?? {};
    this.#opts = {
      consumerName: o.consumerName ?? `worker-${randomUUID().slice(0, 8)}`,
      batchSize: o.batchSize ?? 64,
      blockMs: o.blockMs ?? 5000,
      lagSloEntries: o.lagSloEntries ?? 100,
      log: o.log ?? (() => {}),
      now: o.now ?? (() => new Date()),
    };
  }

  /** One pass. Returns what it committed — useful for tests and for metrics. */
  async runOnce(): Promise<CommitResult> {
    const entries = await this.#stream.read(
      this.#opts.consumerName,
      this.#opts.batchSize,
      this.#opts.blockMs,
    );
    if (entries.length === 0) return empty();

    const result = await this.#process(entries);

    await this.#stream.ack(entries.map((e) => e.id));

    const lag = await this.#stream.pendingCount();
    if (lag > this.#opts.lagSloEntries) {
      // Not queue trivia: this is how long the companion has been out of date.
      this.#opts.log("warn", "memory lag over SLO", {
        pending: lag,
        slo: this.#opts.lagSloEntries,
      });
    }
    return result;
  }

  async start(): Promise<void> {
    this.#running = true;
    while (this.#running) {
      try {
        const res = await this.runOnce();
        // Belt and braces: a stream implementation that ignores blockMs would
        // otherwise turn this into a busy loop. Never trust the transport to
        // pace the loop for us.
        if (res.eventsProcessed === 0) await this.#idle();
      } catch (err) {
        this.#opts.log("error", "memory worker pass failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        await this.#idle();
      }
    }
  }

  #idle(): Promise<void> {
    return new Promise((r) => {
      // unref so a running worker never holds the process open.
      setTimeout(r, Math.max(50, this.#opts.blockMs)).unref?.();
    });
  }

  stop(): void {
    this.#running = false;
  }

  // -------------------------------------------------------------------------

  async #process(entries: StreamEntry[]): Promise<CommitResult> {
    const result = empty();

    // Group by session: an episode is a session, and facts are distilled with
    // the whole conversation in view rather than turn by turn.
    const bySession = new Map<string, MemWriteEvent[]>();
    for (const { event } of entries) {
      if (this.#processed.has(event.event_id)) {
        result.duplicatesSkipped++;
        continue;
      }
      this.#processed.add(event.event_id);
      result.eventsProcessed++;

      const list = bySession.get(event.sid);
      if (list) list.push(event);
      else bySession.set(event.sid, [event]);
    }

    for (const [sid, events] of bySession) {
      const merged = await this.#commitSession(sid, events);
      result.factsWritten += merged.factsWritten;
      result.factsSuperseded += merged.factsSuperseded;
      result.factsReinforced += merged.factsReinforced;
      result.episodesWritten += merged.episodesWritten;
    }
    return result;
  }

  async #commitSession(sid: string, events: MemWriteEvent[]): Promise<CommitResult> {
    const result = empty();
    const uid = events[0]!.uid;

    const existing = await this.#longTerm.listFacts(uid, 200);
    const distilled = await this.#distiller.distil(events, existing);

    const factIds: string[] = [];
    const now = this.#opts.now().toISOString();

    for (const df of distilled.facts) {
      // An explicit correction event carries the id directly and is trusted over
      // the distiller's text match.
      const explicit = events.find((e) => e.kind === "correction" && e.supersedes_fact_id);
      const target =
        (explicit?.supersedes_fact_id
          ? existing.find((f) => f.id === explicit.supersedes_fact_id)
          : undefined) ?? matchExisting(df.supersedes_text, existing);

      // Re-stating a fact we already hold should reinforce it, not duplicate it.
      const duplicate = existing.find((f) => sameFact(f.text, df.text));
      if (duplicate && !target) {
        await this.#longTerm.reinforce(duplicate.id, now);
        result.factsReinforced++;
        factIds.push(duplicate.id);
        continue;
      }

      const fact = await this.#longTerm.putFact({
        uid,
        text: df.text,
        kind: df.kind,
        salience: df.salience,
        confidence: df.confidence,
        source_event_id: events[events.length - 1]!.event_id,
        source_sid: sid,
        supersedes: target?.id,
      });
      factIds.push(fact.id);
      result.factsWritten++;
      if (target) result.factsSuperseded++;
    }

    // An episode is written when the session closes, not per turn — it is a
    // record of what happened, and that is only known at the end.
    const closed = events.find((e) => e.kind === "session_closed");
    if (closed) {
      const languages = [...new Set(events.map((e) => e.language).filter((l): l is string => !!l))];

      // Bounded, and off the voice path by virtue of being here at all — see the
      // header of care-signals-analyser.ts. A null is "no signals for this
      // session", which is the common case and not a failure.
      //
      // The catch is belt and braces over an analyser that already swallows its
      // own errors: a throw here would abandon the batch BEFORE the ack while
      // `#processed` has already marked these events seen, so the episode would
      // be lost permanently rather than retried. An optional extra must never be
      // able to cost us the record of what happened.
      let signals: Awaited<ReturnType<SignalsAnalyser>> = null;
      if (this.#signals) {
        try {
          signals = await this.#signals({ events, languages });
        } catch (err) {
          this.#opts.log("warn", "care signals threw; writing the episode without them", {
            sid,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const episode: Episode = {
        id: randomUUID(),
        uid,
        sid,
        started_at: events[0]!.at,
        ended_at: closed.at,
        turn_count: closed.turn_count ?? events.length,
        languages,
        summary: distilled.summary,
        topics: distilled.topics,
        open_threads: distilled.open_threads.map((text) => ({ id: randomUUID(), text })),
        fact_ids: factIds,
        ...(distilled.mood ? { mood: distilled.mood } : {}),
        ...(signals ? { signals } : {}),
      };
      await this.#longTerm.appendEpisode(episode);
      result.episodesWritten++;
    }

    if (result.factsWritten > 0 || result.episodesWritten > 0 || result.factsReinforced > 0) {
      await this.#refreshProfile(uid, events);
    }
    return result;
  }

  /**
   * Rebuild and cache the profile, then invalidate so the next session opens
   * warm. Invalidate-then-write, so a reader never sees a half-built profile.
   */
  async #refreshProfile(uid: string, events: MemWriteEvent[]): Promise<void> {
    try {
      const preferred = [...events].reverse().find((e) => e.language)?.language ?? "hi-IN";
      const profile = await buildProfile(uid, this.#longTerm, {
        preferredLanguage: preferred,
        now: this.#opts.now(),
      });
      await this.#sessions.invalidateProfile(uid);
      await this.#sessions.saveProfile(profile);
    } catch (err) {
      // A profile cache failure costs warmth on the next session, not
      // correctness — the facts are already durable.
      this.#opts.log("warn", "profile refresh failed", {
        uid,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const empty = (): CommitResult => ({
  factsWritten: 0,
  factsSuperseded: 0,
  factsReinforced: 0,
  episodesWritten: 0,
  eventsProcessed: 0,
  duplicatesSkipped: 0,
});

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[.,!?;:—…"'`()[\]{}।॥]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sameFact = (a: string, b: string): boolean => normalize(a) === normalize(b);

function matchExisting(text: string | undefined, existing: Fact[]): Fact | undefined {
  if (!text) return undefined;
  const target = normalize(text);
  return existing.find((f) => normalize(f.text) === target);
}
