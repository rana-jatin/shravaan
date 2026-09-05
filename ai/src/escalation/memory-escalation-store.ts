/**
 * In-process EscalationStore.
 *
 * The reference implementation the contract suite checks Redis against, and
 * what a deployment without REDIS_URL runs on.
 *
 * ⚠ AND THAT DEPLOYMENT LOSES THE FEATURE'S WHOLE POINT. A schedule kept here
 * costs a restart; an escalation kept here costs the reason escalation exists —
 * the record of "said at eight, nobody answered" is what makes nine o'clock
 * different from any other minute, and a restart at 08:05 erases it silently.
 * The boot warning says so, and it is not the same warning as the one about
 * working memory.
 */

import { compareEscalations, isTerminal, type Escalation } from "./types.ts";
import type { EscalationStore } from "./types.ts";

export class MemoryEscalationStore implements EscalationStore {
  readonly #byId = new Map<string, Escalation>();

  async open(): Promise<Escalation[]> {
    return this.#live().sort(compareEscalations);
  }

  async openFor(uid: string): Promise<Escalation[]> {
    return this.#live()
      .filter((e) => e.uid === uid)
      .sort(compareEscalations);
  }

  async get(id: string): Promise<Escalation | null> {
    const found = this.#byId.get(id);
    return found ? structuredClone(found) : null;
  }

  async put(escalation: Escalation): Promise<void> {
    this.#byId.set(escalation.id, structuredClone(escalation));
  }

  async remove(id: string): Promise<void> {
    this.#byId.delete(id);
  }

  async close(): Promise<void> {}

  get size(): number {
    return this.#byId.size;
  }

  /**
   * Settled records are filtered out rather than assumed absent.
   *
   * `put` of a terminal record followed by `remove` is two steps, and a sweeper
   * that dies between them would otherwise hand the next one an acknowledged
   * reminder to keep climbing.
   */
  #live(): Escalation[] {
    return [...this.#byId.values()].filter((e) => !isTerminal(e.stage)).map(copy);
  }
}

function copy(escalation: Escalation): Escalation {
  return structuredClone(escalation);
}
