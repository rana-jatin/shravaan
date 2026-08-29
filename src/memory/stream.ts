/**
 * The `mem:writes` stream — the seam between the turn path and the memory path.
 *
 * Writes are fire-and-forget from the orchestrator. A failure here degrades
 * TOMORROW's conversation, never today's turn, and that asymmetry is the whole
 * point of the seam.
 *
 * DELIVERY IS AT-LEAST-ONCE. `event_id` is the idempotency key, not decoration:
 * a worker restart mid-batch would otherwise duplicate facts, and duplicated
 * facts in a companion read as the bot repeating itself.
 *
 * Spec: docs/02-data-contracts.md section 3
 */

import type { Redis } from "ioredis";
import { MEM_WRITES_MAXLEN, key } from "../domain/redis-keys.ts";
import type { MemWriteEvent } from "../domain/types.ts";

export type StreamEntry = { id: string; event: MemWriteEvent };

export interface MemWriteStream {
  /** Fire-and-forget append. Must never throw into the turn path. */
  append(event: MemWriteEvent): Promise<void>;
  /** Blocking-ish read of up to `count` entries for a consumer group. */
  read(consumer: string, count: number, blockMs: number): Promise<StreamEntry[]>;
  ack(ids: string[]): Promise<void>;
  /**
   * Entries appended but not yet acked. Under strong continuity this is a
   * user-visible quality metric, not queue trivia: lag here means a companion
   * that has not yet learned what you told it.
   */
  pendingCount(): Promise<number>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------

export class InMemoryMemWriteStream implements MemWriteStream {
  #seq = 0;
  readonly #entries: StreamEntry[] = [];
  readonly #pending = new Set<string>();

  async append(event: MemWriteEvent): Promise<void> {
    const id = `${++this.#seq}`;
    this.#entries.push({ id, event });
    this.#pending.add(id);
  }

  async read(_consumer: string, count: number, blockMs: number): Promise<StreamEntry[]> {
    const ready = this.#entries.filter((e) => this.#pending.has(e.id)).slice(0, count);
    // Honour blockMs when there is nothing to do. Returning instantly on an
    // empty stream turns the worker's poll loop into a busy loop that pins a
    // core and starves everything else on the event loop.
    if (ready.length === 0 && blockMs > 0) {
      // unref: a background poll must never be the reason a process refuses to
      // exit. Without this the worker keeps the event loop alive indefinitely.
      await new Promise((r) => setTimeout(r, blockMs).unref?.());
      return this.#entries.filter((e) => this.#pending.has(e.id)).slice(0, count);
    }
    return ready;
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) this.#pending.delete(id);
  }

  async pendingCount(): Promise<number> {
    return this.#pending.size;
  }

  async close(): Promise<void> {
    this.#entries.length = 0;
    this.#pending.clear();
  }
}

// ---------------------------------------------------------------------------

const GROUP = "mem-workers";

export class RedisMemWriteStream implements MemWriteStream {
  readonly #redis: Redis;
  #groupReady = false;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async #ensureGroup(): Promise<void> {
    if (this.#groupReady) return;
    try {
      // MKSTREAM so the group can be created before the first write.
      await this.#redis.xgroup("CREATE", key.memWrites(), GROUP, "0", "MKSTREAM");
    } catch (err) {
      // BUSYGROUP just means another instance created it first.
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    this.#groupReady = true;
  }

  async append(event: MemWriteEvent): Promise<void> {
    await this.#redis.xadd(
      key.memWrites(),
      "MAXLEN",
      "~",
      MEM_WRITES_MAXLEN,
      "*",
      "event",
      JSON.stringify(event),
    );
  }

  async read(consumer: string, count: number, blockMs: number): Promise<StreamEntry[]> {
    await this.#ensureGroup();

    const res = (await this.#redis.xreadgroup(
      "GROUP",
      GROUP,
      consumer,
      "COUNT",
      count,
      "BLOCK",
      blockMs,
      "STREAMS",
      key.memWrites(),
      ">",
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!res || res.length === 0) return [];

    const out: StreamEntry[] = [];
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const idx = fields.indexOf("event");
        if (idx === -1) continue;
        try {
          out.push({ id, event: JSON.parse(fields[idx + 1]!) as MemWriteEvent });
        } catch {
          // A corrupt entry must not wedge the consumer group forever. Ack it
          // by returning nothing for it; the ack below will clear it.
          out.push({ id, event: null as unknown as MemWriteEvent });
        }
      }
    }
    return out.filter((e) => e.event !== null);
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#redis.xack(key.memWrites(), GROUP, ...ids);
  }

  async pendingCount(): Promise<number> {
    await this.#ensureGroup();
    const res = (await this.#redis.xpending(key.memWrites(), GROUP)) as [number, ...unknown[]] | null;
    return res?.[0] ?? 0;
  }

  async close(): Promise<void> {
    // The Redis connection is owned by the caller.
  }
}
