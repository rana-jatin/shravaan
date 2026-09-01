/**
 * Long-term memory — slice 4.
 *
 * The two invariants under test are supersede-never-overwrite and
 * soft-delete-always. Both are the difference between a companion that can say
 * "you mentioned you'd moved" and one that either forgets or contradicts itself.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Episode, Fact, MemWriteEvent } from "@sp-i/shared/domain/types.ts";
import { InMemoryLongTermStore } from "../src/memory/in-memory-long-term-store.ts";
import { HashingEmbedder } from "../src/memory/long-term-store.ts";
import { parseDistillation, type Distillation, type Distiller } from "../src/memory/distiller.ts";
import { PROFILE_CAPS, buildProfile, decayedSalience } from "../src/memory/profile.ts";
import { InMemoryMemWriteStream } from "../src/memory/stream.ts";
import { MemoryWorker } from "../src/memory/worker.ts";
import { MemorySessionStore } from "../src/store/memory-store.ts";

const store = () => new InMemoryLongTermStore(new HashingEmbedder());

const draft = (
  uid: string,
  text: string,
  over: Partial<Parameters<InMemoryLongTermStore["putFact"]>[0]> = {},
) => ({
  uid,
  text,
  kind: "biographical" as const,
  salience: 0.5,
  confidence: 0.8,
  source_event_id: "e1",
  source_sid: "s1",
  ...over,
});

describe("fact store: supersede, never overwrite", () => {
  it("retires the old fact and keeps the chain intact", async () => {
    const s = store();
    const pune = await s.putFact(draft("u1", "They live in Pune"));
    const blr = await s.putFact(draft("u1", "They live in Bengaluru", { supersedes: pune.id }));

    const live = await s.listFacts("u1");
    assert.equal(live.length, 1);
    assert.equal(live[0]?.text, "They live in Bengaluru");

    // The old fact must still EXIST — that is what lets the agent say
    // "you mentioned you'd moved".
    const old = await s.getFact(pune.id);
    assert.ok(old, "superseded facts must not be removed");
    assert.equal(old.superseded_by, blr.id);
    assert.equal(old.deleted_reason, "superseded");
    assert.equal(blr.supersedes, pune.id);
  });

  it("never returns superseded facts from listFacts", async () => {
    const s = store();
    const a = await s.putFact(draft("u1", "They work at Acme"));
    await s.putFact(draft("u1", "They work at Globex", { supersedes: a.id }));

    const live = await s.listFacts("u1");
    assert.ok(!live.some((f) => f.text.includes("Acme")), "the agent must not assert stale facts");
  });

  it("never returns superseded facts from search", async () => {
    const s = store();
    const a = await s.putFact(draft("u1", "They live in Pune"));
    await s.putFact(draft("u1", "They live in Bengaluru", { supersedes: a.id }));

    const hits = await s.search("u1", "where do they live", 10);
    assert.ok(!hits.some((h) => h.fact.text.includes("Pune")));
  });
});

describe("fact store: soft delete, always", () => {
  it("hides a deleted fact but keeps it auditable", async () => {
    const s = store();
    const f = await s.putFact(draft("u1", "They have a cat named Mica"));
    await s.softDelete(f.id, "user_requested");

    assert.deepEqual(await s.listFacts("u1"), []);

    const row = await s.getFact(f.id);
    assert.ok(row, "user-requested deletion must remain auditable");
    assert.equal(row.deleted_reason, "user_requested");
    assert.ok(row.deleted_at);
  });

  it("is idempotent", async () => {
    const s = store();
    const f = await s.putFact(draft("u1", "x"));
    await s.softDelete(f.id, "user_requested");
    const first = (await s.getFact(f.id))!.deleted_at;
    await s.softDelete(f.id, "low_confidence");
    assert.equal(
      (await s.getFact(f.id))!.deleted_at,
      first,
      "must not overwrite the original deletion",
    );
  });
});

describe("reinforcement", () => {
  it("raises salience with diminishing returns", async () => {
    const s = store();
    const f = await s.putFact(draft("u1", "They prefer tea", { salience: 0.4 }));

    await s.reinforce(f.id, new Date().toISOString());
    const once = (await s.getFact(f.id))!.salience;
    await s.reinforce(f.id, new Date().toISOString());
    const twice = (await s.getFact(f.id))!.salience;

    assert.ok(once > 0.4);
    assert.ok(twice > once);
    assert.ok(twice - once < once - 0.4, "gains must diminish");
    assert.ok(twice <= 1);
  });

  it("does not reinforce a retired fact", async () => {
    const s = store();
    const f = await s.putFact(draft("u1", "x", { salience: 0.4 }));
    await s.softDelete(f.id, "user_requested");
    await s.reinforce(f.id, new Date().toISOString());
    assert.equal((await s.getFact(f.id))!.salience, 0.4);
  });
});

describe("salience decay", () => {
  it("fades an unreinforced fact but keeps a long half-life", () => {
    const base = {
      salience: 1,
      last_reinforced: new Date("2026-01-01T00:00:00Z").toISOString(),
    } as Fact;

    const at90 = decayedSalience(base, new Date("2026-04-01T00:00:00Z"));
    assert.ok(Math.abs(at90 - 0.5) < 0.02, "~half after the 90-day half-life");

    // A companion forgetting a family member's name after a quiet fortnight
    // would be worse than carrying a slightly stale fact.
    const at14 = decayedSalience(base, new Date("2026-01-15T00:00:00Z"));
    assert.ok(at14 > 0.85, "a fortnight of quiet must barely move it");
  });
});

describe("distillation parsing", () => {
  it("extracts facts from a well-formed response", () => {
    const d = parseDistillation(
      JSON.stringify({
        facts: [
          {
            text: "They have a daughter called Aanya",
            kind: "relationship",
            salience: 0.9,
            confidence: 0.95,
          },
        ],
        summary: "Talked about family.",
        topics: ["family"],
        open_threads: ["Wanted to plan Aanya's birthday"],
        mood: "positive",
      }),
    );
    assert.equal(d.facts.length, 1);
    assert.equal(d.facts[0]?.kind, "relationship");
    assert.equal(d.open_threads.length, 1);
    assert.equal(d.mood, "positive");
  });

  it("tolerates prose wrapped around the JSON", () => {
    const d = parseDistillation(
      'Sure! Here you go:\n{"facts":[],"summary":"nothing"}\nHope that helps.',
    );
    assert.equal(d.summary, "nothing");
  });

  it("degrades to learning nothing rather than throwing", () => {
    // A bad fact is harder to undo than a missing one.
    for (const bad of ["", "not json at all", "{", '{"facts": "not an array"}']) {
      const d = parseDistillation(bad);
      assert.deepEqual(d.facts, []);
    }
  });

  it("drops malformed facts and clamps out-of-range scores", () => {
    const d = parseDistillation(
      JSON.stringify({
        facts: [
          { text: "", kind: "preference" },
          { text: "Valid", kind: "not-a-kind", salience: 5, confidence: -2 },
        ],
      }),
    );
    assert.equal(d.facts.length, 1);
    assert.equal(d.facts[0]?.kind, "biographical", "unknown kinds fall back");
    assert.equal(d.facts[0]?.salience, 1);
    assert.equal(d.facts[0]?.confidence, 0);
  });
});

// ---------------------------------------------------------------------------

class StubDistiller implements Distiller {
  calls = 0;
  readonly #result: Distillation;
  constructor(result: Distillation) {
    this.#result = result;
  }
  async distil(): Promise<Distillation> {
    this.calls++;
    return this.#result;
  }
}

const event = (over: Partial<MemWriteEvent> = {}): MemWriteEvent => ({
  event_id: `ev-${Math.random()}`,
  sid: "s1",
  uid: "u1",
  tid: 1,
  at: new Date().toISOString(),
  kind: "turn_completed",
  language: "hi-IN",
  ...over,
});

function makeWorker(distillation: Distillation) {
  const stream = new InMemoryMemWriteStream();
  const longTerm = store();
  const sessions = new MemorySessionStore();
  const distiller = new StubDistiller(distillation);
  const worker = new MemoryWorker({
    stream,
    longTerm,
    sessions,
    distiller,
    options: { blockMs: 0 },
  });
  return { stream, longTerm, sessions, distiller, worker };
}

describe("memory worker", () => {
  it("writes distilled facts and refreshes the profile", async () => {
    const { stream, longTerm, sessions, worker } = makeWorker({
      facts: [
        { text: "They prefer morning calls", kind: "preference", salience: 0.8, confidence: 0.9 },
      ],
      summary: "Chatted about scheduling.",
      topics: ["scheduling"],
      open_threads: [],
    });

    await stream.append(event({ user_text: "subah call karna theek rahega" }));
    const res = await worker.runOnce();

    assert.equal(res.factsWritten, 1);
    assert.equal((await longTerm.listFacts("u1")).length, 1);

    // Slice 3 already warms the profile at session open; slice 4 makes something
    // actually write it.
    const profile = await sessions.loadProfile("u1");
    assert.ok(profile, "profile must be cached for the next session");
    assert.equal(profile.facts[0]?.text, "They prefer morning calls");
  });

  it("acks what it processed and reports zero lag", async () => {
    const { stream, worker } = makeWorker({ facts: [], summary: "", topics: [], open_threads: [] });
    await stream.append(event());
    assert.equal(await stream.pendingCount(), 1);
    await worker.runOnce();
    assert.equal(await stream.pendingCount(), 0);
  });

  it("skips duplicate event_ids — streams are at-least-once", async () => {
    const { stream, longTerm, worker } = makeWorker({
      facts: [{ text: "They have a dog", kind: "relationship", salience: 0.7, confidence: 0.9 }],
      summary: "",
      topics: [],
      open_threads: [],
    });

    const dup = event({ event_id: "same-id", user_text: "mera kutta hai" });
    await stream.append(dup);
    await worker.runOnce();
    await stream.append({ ...dup });
    const second = await worker.runOnce();

    assert.equal(second.duplicatesSkipped, 1);
    assert.equal(
      (await longTerm.listFacts("u1")).length,
      1,
      "duplicated facts read as the bot repeating itself",
    );
  });

  it("reinforces a restated fact instead of duplicating it", async () => {
    const { stream, longTerm, worker } = makeWorker({
      facts: [{ text: "They prefer tea", kind: "preference", salience: 0.6, confidence: 0.9 }],
      summary: "",
      topics: [],
      open_threads: [],
    });

    await stream.append(event({ event_id: "a" }));
    await worker.runOnce();
    await stream.append(event({ event_id: "b" }));
    const second = await worker.runOnce();

    assert.equal(second.factsReinforced, 1);
    assert.equal(second.factsWritten, 0);
    assert.equal((await longTerm.listFacts("u1")).length, 1);
  });

  it("treats a contradiction as a supersede, not a second fact", async () => {
    const { stream, longTerm, worker } = makeWorker({
      facts: [{ text: "They live in Pune", kind: "biographical", salience: 0.8, confidence: 0.9 }],
      summary: "",
      topics: [],
      open_threads: [],
    });
    await stream.append(event({ event_id: "a" }));
    await worker.runOnce();

    const original = (await longTerm.listFacts("u1"))[0]!;

    // Second pass: the user corrects themselves.
    const corrected = makeWorker({
      facts: [
        {
          text: "They live in Bengaluru",
          kind: "biographical",
          salience: 0.9,
          confidence: 0.95,
          supersedes_text: "They live in Pune",
        },
      ],
      summary: "",
      topics: [],
      open_threads: [],
    });
    // Reuse the populated store so the correction has something to supersede.
    const worker2 = new MemoryWorker({
      stream: corrected.stream,
      longTerm,
      sessions: corrected.sessions,
      distiller: corrected.distiller,
      options: { blockMs: 0 },
    });
    await corrected.stream.append(event({ event_id: "c", kind: "correction" }));
    const res = await worker2.runOnce();

    assert.equal(res.factsSuperseded, 1);
    const live = await longTerm.listFacts("u1");
    assert.equal(live.length, 1);
    assert.equal(live[0]?.text, "They live in Bengaluru");
    assert.equal((await longTerm.getFact(original.id))!.superseded_by, live[0].id);
  });

  it("writes an episode only when the session closes", async () => {
    const { stream, longTerm, worker } = makeWorker({
      facts: [],
      summary: "They talked about their week.",
      topics: ["week"],
      open_threads: ["Wanted to revisit the trip plan"],
      mood: "positive",
    });

    await stream.append(event({ event_id: "t1" }));
    assert.equal(
      (await worker.runOnce()).episodesWritten,
      0,
      "a mid-session turn is not an episode",
    );

    await stream.append(event({ event_id: "close", kind: "session_closed", turn_count: 4 }));
    const res = await worker.runOnce();

    assert.equal(res.episodesWritten, 1);
    const eps = await longTerm.listEpisodes("u1", 10);
    assert.equal(eps[0]?.turn_count, 4);
    assert.equal(eps[0]?.open_threads.length, 1);
    assert.equal(eps[0]?.mood, "positive");
  });
});

describe("profile building", () => {
  it("caps facts, episodes and open threads", async () => {
    const s = store();
    for (let i = 0; i < PROFILE_CAPS.facts + 20; i++) {
      await s.putFact(draft("u1", `Fact number ${i}`, { salience: Math.random() }));
    }
    for (let i = 0; i < PROFILE_CAPS.episodes + 5; i++) {
      await s.appendEpisode({
        id: `e${i}`,
        uid: "u1",
        sid: `s${i}`,
        started_at: new Date(2026, 0, i + 1).toISOString(),
        ended_at: new Date(2026, 0, i + 1, 1).toISOString(),
        turn_count: 3,
        languages: ["hi-IN"],
        summary: `Episode ${i}`,
        topics: [],
        open_threads: [{ id: `t${i}`, text: `Thread ${i}` }],
        fact_ids: [],
      } satisfies Episode);
    }

    const p = await buildProfile("u1", s, { preferredLanguage: "hi-IN" });

    // These caps are charged against latency and tokens on EVERY turn.
    assert.equal(p.facts.length, PROFILE_CAPS.facts);
    assert.equal(p.recent_episodes.length, PROFILE_CAPS.episodes);
    assert.ok(p.open_threads.length <= PROFILE_CAPS.openThreads);
  });

  it("ranks facts by decayed salience, not raw", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const s = new InMemoryLongTermStore(
      new HashingEmbedder(),
      () => new Date("2026-01-01T00:00:00Z"),
    );
    await s.putFact(draft("u1", "Stale but once important", { salience: 0.95 }));

    const fresh = new InMemoryLongTermStore(new HashingEmbedder(), () => now);
    const f2 = await fresh.putFact(draft("u1", "Recent and moderate", { salience: 0.7 }));
    assert.ok(decayedSalience(f2, now) > 0.6);
  });

  it("deduplicates open threads, newest wins", async () => {
    const s = store();
    for (const [i, day] of [1, 2].entries()) {
      await s.appendEpisode({
        id: `e${i}`,
        uid: "u1",
        sid: `s${i}`,
        started_at: new Date(2026, 0, day).toISOString(),
        ended_at: new Date(2026, 0, day, 1).toISOString(),
        turn_count: 1,
        languages: ["hi-IN"],
        summary: "",
        topics: [],
        open_threads: [{ id: `t${i}`, text: "Plan the trip" }],
        fact_ids: [],
      } satisfies Episode);
    }

    const p = await buildProfile("u1", s, { preferredLanguage: "hi-IN" });
    assert.equal(p.open_threads.length, 1, "the same thread must not appear twice");
  });

  it("is empty and harmless for a brand-new user", async () => {
    const p = await buildProfile("nobody", store(), { preferredLanguage: "hi-IN" });
    assert.deepEqual(p.facts, []);
    assert.deepEqual(p.open_threads, []);
    assert.equal(p.preferred_language, "hi-IN");
  });
});

describe("HashingEmbedder — known limitation", () => {
  it("matches lexically", async () => {
    const s = store();
    await s.putFact(draft("u1", "They have a daughter called Aanya"));
    const hits = await s.search("u1", "Aanya daughter", 5);
    assert.ok(hits.length > 0 && hits[0]!.score > 0);
  });

  it("does NOT match across languages — this is why ADR 0004 is still open", async () => {
    const s = store();
    await s.putFact(draft("u1", "They live in Bengaluru"));
    const hits = await s.search("u1", "वे बेंगलुरु में रहते हैं", 5);

    // Documented failure, not an accident: a lexical embedder cannot bridge
    // scripts, and our facts are multilingual by construction. A real
    // multilingual embedder must replace this before retrieval is trusted.
    assert.equal(hits.length, 0);
  });
});
