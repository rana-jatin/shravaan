/**
 * Redis ScheduleStore.
 *
 *   sched:id:{id}            the schedule, JSON        NO TTL
 *   sched:index:all          SET of ids — the ticker   NO TTL
 *   sched:index:user:{uid}   SET of that person's ids  NO TTL
 *
 * THE ABSENT TTL IS THE DESIGN, not an oversight — see the note beside these
 * keys in shared/src/domain/redis-keys.ts. Everything else in this Redis is
 * working memory and is meant to age out; a standing reminder is not.
 *
 * TWO INDEXES RATHER THAN A SCAN. `all()` runs on every tick, and `SCAN` over a
 * database shared with every session key would walk far more than it reads. A
 * set of ids costs one SMEMBERS and one MGET whatever else is in there.
 *
 * WHY THE INDEXES CANNOT BE TRUSTED BLINDLY. There is no transaction spanning
 * the value and the two sets, so a process killed between two pipeline commands
 * can leave an id in an index with no schedule behind it. Both reads below cope
 * with that and repair it in passing, because the alternative — an index that
 * only self-heals when someone notices — is how a deleted reminder comes back.
 */

import { Redis } from "ioredis";
import { key } from "@sp-i/shared/domain/redis-keys.ts";
import { compareSchedules, type Schedule, type ScheduleStore } from "./types.ts";

function parse(raw: string | null | undefined): Schedule | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Schedule;
    // A schedule with no id cannot be removed, disabled or reported on. Treat it
    // as absent so the repair below clears it rather than dispatching from it.
    return typeof value?.id === "string" ? value : null;
  } catch {
    return null;
  }
}

export class RedisScheduleStore implements ScheduleStore {
  readonly #redis: Redis;
  readonly #owned: boolean;

  constructor(urlOrClient: string | Redis) {
    // `lazyConnect`: nothing here opens a socket until something actually reads
    // or writes a schedule. A deployment where no capability schedules anything
    // pays nothing for this store existing — which is what lets composition
    // build it unconditionally instead of guessing whether it will be needed.
    // `#owned` decides whether close() may hang up: a client handed in belongs
    // to the caller, and closing somebody else's connection out from under them
    // is how one test's teardown breaks the next one.
    this.#owned = typeof urlOrClient === "string";
    this.#redis =
      typeof urlOrClient === "string" ? new Redis(urlOrClient, { lazyConnect: true }) : urlOrClient;
  }

  async forUser(uid: string): Promise<Schedule[]> {
    return this.#load(key.userScheduleIndex(uid), uid);
  }

  async all(): Promise<Schedule[]> {
    return this.#load(key.scheduleIndex());
  }

  async get(id: string): Promise<Schedule | null> {
    return parse(await this.#redis.get(key.schedule(id)));
  }

  async put(schedule: Schedule): Promise<void> {
    // Value first, then the indexes. The other order can point the ticker at an
    // id whose schedule has not been written yet; this order can only leave a
    // schedule nothing lists, which the next `put` fixes and no one is woken by.
    await this.#redis
      .pipeline()
      .set(key.schedule(schedule.id), JSON.stringify(schedule))
      .sadd(key.scheduleIndex(), schedule.id)
      .sadd(key.userScheduleIndex(schedule.uid), schedule.id)
      .exec();
  }

  async remove(id: string): Promise<void> {
    // Read first, only to learn whose index to clear. `remove` is a caregiver
    // action, not something on the tick path, so the extra round trip is free
    // and the alternative is a permanent stale entry in a person's list.
    const existing = await this.get(id);
    const pipeline = this.#redis.pipeline().del(key.schedule(id)).srem(key.scheduleIndex(), id);
    if (existing) pipeline.srem(key.userScheduleIndex(existing.uid), id);
    await pipeline.exec();
  }

  async close(): Promise<void> {
    if (!this.#owned) return;
    // `quit()` on a lazy client that never connected opens a socket purely in
    // order to close it, and on an already-ended one it can hang. Neither is
    // something to discover during a shutdown.
    if (this.#redis.status === "wait" || this.#redis.status === "end") {
      this.#redis.disconnect();
      return;
    }
    await this.#redis.quit();
  }

  /**
   * One index read, one bulk value read, and a repair for whatever did not
   * line up.
   *
   * `uid` is passed for the per-user index only, and is a SECOND check rather
   * than a redundant one: an id left in the wrong person's index — by a crash
   * mid-`put`, or a schedule rewritten under a different uid — would otherwise
   * show one person another person's reminders. That is the one failure in this
   * file worth paying an `if` for on every read.
   */
  async #load(indexKey: string, uid?: string): Promise<Schedule[]> {
    const ids = await this.#redis.smembers(indexKey);
    if (ids.length === 0) return [];

    const raw = await this.#redis.mget(ids.map((id) => key.schedule(id)));

    const out: Schedule[] = [];
    const stale: string[] = [];
    ids.forEach((id, i) => {
      const schedule = parse(raw[i]);
      if (!schedule || (uid !== undefined && schedule.uid !== uid)) stale.push(id);
      else out.push(schedule);
    });

    // Fire and forget: the answer above is already correct without it, and a
    // read on the tick path must not fail because a tidy-up did.
    if (stale.length > 0) void this.#redis.srem(indexKey, ...stale).catch(() => {});

    return out.sort(compareSchedules);
  }
}
