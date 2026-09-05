/**
 * In-process ScheduleStore.
 *
 * The reference implementation the contract suite checks Redis against, and
 * what a single-instance deployment without REDIS_URL actually runs on. It is
 * not a stand-in that gets an easier test: if the two disagree, one of them is
 * wrong, and a suite that only ever ran against the Map would not say which.
 *
 * ⚠ NOT DURABLE. Reminders held here are lost on restart, and the boot log says
 * so. That is a real limitation for a medication reminder rather than a
 * development convenience, which is why the warning is at boot and not in a
 * comment only.
 */

import { compareSchedules, type Schedule, type ScheduleStore } from "./types.ts";

export class MemoryScheduleStore implements ScheduleStore {
  readonly #byId = new Map<string, Schedule>();

  async forUser(uid: string): Promise<Schedule[]> {
    return [...this.#byId.values()]
      .filter((s) => s.uid === uid)
      .map(copy)
      .sort(compareSchedules);
  }

  async all(): Promise<Schedule[]> {
    return [...this.#byId.values()].map(copy).sort(compareSchedules);
  }

  async put(schedule: Schedule): Promise<void> {
    this.#byId.set(schedule.id, copy(schedule));
  }

  async remove(id: string): Promise<void> {
    this.#byId.delete(id);
  }

  async get(id: string): Promise<Schedule | null> {
    const found = this.#byId.get(id);
    return found ? copy(found) : null;
  }

  async close(): Promise<void> {}

  /** Tests and the boot log; not part of the interface. */
  get size(): number {
    return this.#byId.size;
  }
}

/**
 * Copy on the way in AND on the way out.
 *
 * Redis round-trips through JSON, so a caller there can never reach back into
 * stored state. Without this the two implementations differ in a way that shows
 * up as a mysterious bug rather than a failing test: mutating the object you
 * just read would silently edit the schedule, and disabling one reminder would
 * appear to work until the process restarted.
 */
function copy(schedule: Schedule): Schedule {
  return structuredClone(schedule);
}
