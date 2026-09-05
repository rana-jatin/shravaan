/**
 * `mem:writes` under an outage — slice 8.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE RESOLVES AN OPEN DECISION. docs/02-data-contracts.md section 6 says
 * of a Redis outage: "**do not** silently drop `mem:writes` — buffer or accept
 * the loss explicitly". It did not say which. Here is which, and why.
 *
 * **Buffer in process, bounded, and account for every single drop.**
 *
 * The three candidates and what is wrong with two of them:
 *
 *   - *Drop silently.* Forbidden by the contract, and rightly. Under strong
 *     continuity a dropped write is not a lost log line, it is a companion that
 *     will never know something you told it. That has to be visible.
 *   - *Buffer without limit.* Turns a dependency outage into an OOM. A memory
 *     outage that takes the conversation down with it has inverted the entire
 *     point of putting a queue between them.
 *   - *Block the turn path until the write lands.* Inverts the asymmetry the seam
 *     exists to create — a failure here is supposed to degrade tomorrow's
 *     conversation, never today's turn.
 *
 * So: a fixed-size buffer, a retry loop off the turn path, and a drop counter
 * that is a real metric rather than a debug line.
 *
 * WHICH EVENT GETS DROPPED IS NOT ARBITRARY. On overflow this evicts the oldest
 * LOW-PRIORITY event, not simply the oldest. A `correction` outranks everything:
 * losing one leaves a superseded fact standing as current, and a companion
 * confidently repeating something you corrected is a worse failure than one that
 * merely forgot. Losing a `turn_completed` costs a detail; losing a `correction`
 * costs trust.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { MemWriteEvent, MemWriteKind } from "@sp-i/shared/domain/types.ts";
import type { MemWriteStream, StreamEntry } from "./stream.ts";
import { SOCKET_RECONNECT, delayFor, type BackoffPolicy } from "@sp-i/shared/domain/backoff.ts";

/** Higher survives longer. See the header for why corrections top the list. */
const PRIORITY: Record<MemWriteKind, number> = {
  correction: 3,
  session_closed: 2,
  explicit_recall: 1,
  turn_completed: 0,
};

export type BufferedStreamOptions = {
  /** Hard cap. At ~1 KB an event this is well under a megabyte. */
  capacity?: number;
  policy?: BackoffPolicy;
  log?: ((level: string, msg: string, extra?: Record<string, unknown>) => void) | undefined;
  /** Fired the first time a write is buffered, and again when the backlog clears. */
  onStateChange?: ((buffering: boolean) => void) | undefined;
  now?: (() => number) | undefined;
};

export const DEFAULT_CAPACITY = 500;

export class BufferedMemWriteStream implements MemWriteStream {
  readonly #inner: MemWriteStream;
  readonly #capacity: number;
  readonly #policy: BackoffPolicy;
  readonly #opts: BufferedStreamOptions;
  #buffer: MemWriteEvent[] = [];
  #dropped = 0;
  #attempt = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  #buffering = false;
  #closed = false;

  constructor(inner: MemWriteStream, opts: BufferedStreamOptions = {}) {
    this.#inner = inner;
    this.#capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.#policy = opts.policy ?? SOCKET_RECONNECT;
    this.#opts = opts;
  }

  /** Events accepted but not yet handed to the real stream. */
  get bufferedCount(): number {
    return this.#buffer.length;
  }

  /**
   * Writes this process will never deliver. NOT a debug counter — under strong
   * continuity this is the number of things the companion will never learn, and
   * it belongs on a dashboard next to consumer lag.
   */
  get droppedCount(): number {
    return this.#dropped;
  }

  get buffering(): boolean {
    return this.#buffering;
  }

  /**
   * Never throws and never blocks. If the backing stream is unreachable the event
   * goes into the buffer and a retry is scheduled; the caller returns to the turn
   * either way.
   */
  async append(event: MemWriteEvent): Promise<void> {
    if (this.#buffering) {
      // Ordering matters to the distiller — a correction that arrives before the
      // fact it corrects reads as a contradiction — so once we are buffering,
      // everything queues behind the backlog rather than jumping it.
      this.#enqueue(event);
      return;
    }

    try {
      await this.#inner.append(event);
    } catch (err) {
      this.#setBuffering(true);
      this.#opts.log?.("warn", "mem:writes unavailable — buffering", {
        err: err instanceof Error ? err.message : String(err),
        capacity: this.#capacity,
        note: "bounded buffer; overflow drops the oldest low-priority event and is counted",
      });
      this.#enqueue(event);
      this.#scheduleFlush();
    }
  }

  #enqueue(event: MemWriteEvent): void {
    if (this.#buffer.length >= this.#capacity) this.#evictOne();
    this.#buffer.push(event);
  }

  /**
   * Evict the oldest event of the lowest priority present. Linear over a bounded
   * buffer, which is cheap and keeps the rule readable — the alternative is a
   * priority queue whose behaviour nobody can reconstruct during an incident.
   */
  #evictOne(): void {
    let victim = 0;
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.#buffer.length; i++) {
      const p = PRIORITY[this.#buffer[i]!.kind] ?? 0;
      if (p < worst) {
        worst = p;
        victim = i;
      }
    }
    const [dropped] = this.#buffer.splice(victim, 1);
    this.#dropped += 1;
    this.#opts.log?.("error", "mem:writes buffer overflow — a memory is permanently lost", {
      kind: dropped?.kind,
      event_id: dropped?.event_id,
      dropped_total: this.#dropped,
      note: "this is a hole in long-term memory, not a delay",
    });
  }

  #setBuffering(on: boolean): void {
    if (this.#buffering === on) return;
    this.#buffering = on;
    this.#opts.onStateChange?.(on);
  }

  #scheduleFlush(): void {
    if (this.#retryTimer || this.#closed) return;
    const delayMs = delayFor(Math.min(this.#attempt, this.#policy.maxAttempts), this.#policy);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        void this.flush();
      },
      Math.max(delayMs, 100),
    );
    // A retry loop must never be the reason a process refuses to exit.
    this.#retryTimer.unref?.();
  }

  /**
   * Try to drain the backlog. Stops at the first failure and re-queues the
   * remainder, preserving order — the distiller's supersede logic depends on it.
   */
  async flush(): Promise<void> {
    if (this.#buffer.length === 0) {
      this.#setBuffering(false);
      this.#attempt = 0;
      return;
    }

    const pending = this.#buffer;
    this.#buffer = [];

    for (let i = 0; i < pending.length; i++) {
      try {
        await this.#inner.append(pending[i]!);
      } catch {
        this.#buffer = [...pending.slice(i), ...this.#buffer];
        this.#scheduleFlush();
        return;
      }
    }

    this.#opts.log?.("info", "mem:writes backlog drained", {
      delivered: pending.length,
      dropped_total: this.#dropped,
    });
    this.#setBuffering(false);
    this.#attempt = 0;
  }

  // --- pass-through -------------------------------------------------------
  // The consumer side is not buffered. A worker that cannot read is a worker
  // that has nothing to do, and pretending otherwise invents entries.

  read(consumer: string, count: number, blockMs: number): Promise<StreamEntry[]> {
    return this.#inner.read(consumer, count, blockMs);
  }
  ack(ids: string[]): Promise<void> {
    return this.#inner.ack(ids);
  }
  async pendingCount(): Promise<number> {
    // Buffered events have not reached the stream, so they are invisible to
    // XPENDING. Adding them keeps the lag metric honest about total unprocessed
    // work rather than only the part that made it to Redis.
    return (await this.#inner.pendingCount()) + this.#buffer.length;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    // One last attempt on the way out. Best effort — if Redis is still down,
    // the backlog dies with the process, which is what a bounded in-process
    // buffer means and is stated plainly in ADR 0008.
    await this.flush().catch(() => {});
    if (this.#buffer.length > 0) {
      this.#opts.log?.("error", "shutting down with an undelivered mem:writes backlog", {
        lost: this.#buffer.length,
        dropped_total: this.#dropped,
      });
    }
    await this.#inner.close();
  }
}
