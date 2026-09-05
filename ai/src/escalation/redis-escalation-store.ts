/**
 * Redis EscalationStore.
 *
 *   esc:id:{id}            the record, JSON          48 h backstop TTL
 *   esc:index:open         SET of ids — the sweep    no TTL
 *   esc:index:user:{uid}   SET of that person's ids  no TTL
 *
 * THE TTL IS A BACKSTOP AND THE INDEXES HAVE NONE, which sounds backwards until
 * you look at what each failure costs. A record that outlives its ladder is a
 * quiet accumulation of somebody's medication history, so it expires. An index
 * entry that outlives its record is a dangling id, which every read below
 * already tolerates and repairs — expiring the indexes as well would mean an
 * open reminder disappearing from the sweep while the record it names is still
 * there, and nobody would be told.
 *
 * Same index-repair reasoning as scheduler/redis-schedule-store.ts: nothing
 * spans the value and the two sets transactionally.
 */

import { Redis } from "ioredis";
import { TTL, key } from "@sp-i/shared/domain/redis-keys.ts";
import { compareEscalations, isTerminal, type Escalation } from "./types.ts";
import type { EscalationStore } from "./types.ts";

function parse(raw: string | null | undefined): Escalation | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Escalation;
    return typeof value?.id === "string" ? value : null;
  } catch {
    return null;
  }
}

export class RedisEscalationStore implements EscalationStore {
  readonly #redis: Redis;
  readonly #owned: boolean;

  constructor(urlOrClient: string | Redis) {
    this.#owned = typeof urlOrClient === "string";
    this.#redis =
      typeof urlOrClient === "string" ? new Redis(urlOrClient, { lazyConnect: true }) : urlOrClient;
  }

  async open(): Promise<Escalation[]> {
    return this.#load(key.escalationIndex());
  }

  async openFor(uid: string): Promise<Escalation[]> {
    return this.#load(key.userEscalationIndex(uid), uid);
  }

  async get(id: string): Promise<Escalation | null> {
    return parse(await this.#redis.get(key.escalation(id)));
  }

  async put(escalation: Escalation): Promise<void> {
    await this.#redis
      .pipeline()
      .set(key.escalation(escalation.id), JSON.stringify(escalation), "EX", TTL.ESCALATION_SECONDS)
      .sadd(key.escalationIndex(), escalation.id)
      .sadd(key.userEscalationIndex(escalation.uid), escalation.id)
      .exec();
  }

  async remove(id: string): Promise<void> {
    const existing = await this.get(id);
    const pipeline = this.#redis.pipeline().del(key.escalation(id)).srem(key.escalationIndex(), id);
    if (existing) pipeline.srem(key.userEscalationIndex(existing.uid), id);
    await pipeline.exec();
  }

  async close(): Promise<void> {
    if (!this.#owned) return;
    if (this.#redis.status === "wait" || this.#redis.status === "end") {
      this.#redis.disconnect();
      return;
    }
    await this.#redis.quit();
  }

  /**
   * One index read, one bulk value read, and a repair for whatever did not line
   * up — including the record that expired under its backstop TTL while its id
   * stayed in the index, which is the ordinary way this store gets untidy.
   *
   * Terminal records are dropped from the answer rather than returned: `put`
   * then `remove` is two steps, and a sweeper that died between them must not
   * hand the next one an acknowledged reminder to keep climbing.
   */
  async #load(indexKey: string, uid?: string): Promise<Escalation[]> {
    const ids = await this.#redis.smembers(indexKey);
    if (ids.length === 0) return [];

    const raw = await this.#redis.mget(ids.map((id) => key.escalation(id)));

    const out: Escalation[] = [];
    const stale: string[] = [];
    ids.forEach((id, i) => {
      const escalation = parse(raw[i]);
      if (!escalation || (uid !== undefined && escalation.uid !== uid)) stale.push(id);
      else if (isTerminal(escalation.stage)) stale.push(id);
      else out.push(escalation);
    });

    if (stale.length > 0) void this.#redis.srem(indexKey, ...stale).catch(() => {});

    return out.sort(compareEscalations);
  }
}
