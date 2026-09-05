/**
 * A small cache, and the reason it exists is the second half of its name.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TTL IS THE OBVIOUS PART AND THE LESS IMPORTANT ONE. What this actually
 * fixes is a shape the whole product has: several conversations happening at
 * once, all of them wanting the same thing at the same moment. Three people
 * asking for the morning headlines within a second of each other made three
 * requests to the same feed, and the second and third arrived while the first
 * was still in flight — so a cache checked only on entry would have missed on
 * all three. Every one of those users then waited the full round trip.
 *
 * SINGLE-FLIGHT MEANS THE SECOND CALLER WAITS ON THE FIRST CALL rather than
 * starting its own. One request leaves this process, three conversations get
 * the answer, and the two that arrived late get it sooner than they would have
 * on their own. That property is worth more here than the TTL: it bounds what
 * we do to somebody else's server no matter how many sessions are live, which
 * matters most for Radio Browser (a volunteer directory) and Open-Meteo (free,
 * unauthenticated, and rate-limited by IP).
 *
 * FAILURES ARE NOT CACHED, AND THE IN-FLIGHT SLOT IS RELEASED WHEN ONE HAPPENS.
 * Every caller waiting on a failed load sees the failure — which is right, they
 * asked for the thing and it did not work — and the next caller after that
 * tries again. Caching an error would turn one bad minute into `ttl` bad
 * minutes for everybody, and this sits in front of tools an elderly person is
 * waiting on in real time.
 *
 * WHAT IT IS NOT. Not shared between processes: two servers keep two copies,
 * which is correct for data this cheap and this public. Not persistent — a
 * restart re-fetches, and that is a feature, since the first thing anyone does
 * to a stale cache is restart the thing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type TtlCacheOptions = {
  /** How long an entry stays fresh. Zero or less disables caching entirely. */
  ttlMs: number;
  /**
   * Ceiling on entries held. Least-recently-used goes first.
   *
   * A BOUND RATHER THAN A TUNING KNOB. `get_weather` is keyed by whatever place
   * a person names, so the key space is "every place name anybody says to this
   * device" — unbounded, and at a twenty-four hour TTL that is a slow leak
   * rather than a cache.
   */
  maxEntries?: number;
  /** Injected so a test can expire an entry without waiting. */
  now?: () => number;
};

type Entry<V> = { value: V; expiresAt: number };

const DEFAULT_MAX_ENTRIES = 256;

export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  /** Insertion-ordered, and re-inserted on a hit — which is what makes it LRU. */
  readonly #entries = new Map<string, Entry<V>>();
  readonly #inFlight = new Map<string, Promise<V>>();

  #hits = 0;
  #misses = 0;
  #shared = 0;

  constructor(opts: TtlCacheOptions) {
    this.#ttlMs = opts.ttlMs;
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = opts.now ?? Date.now;
  }

  /** Off entirely. Callers can say so in a boot log rather than inferring it. */
  get enabled(): boolean {
    return this.#ttlMs > 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * What is in there and still fresh, or undefined.
   *
   * `undefined` is therefore not a cacheable value. Stated rather than guarded:
   * every caller here caches an object or an array, and a sentinel wrapper to
   * support caching "nothing" would cost every read site a `.value`.
   */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      this.#misses++;
      return undefined;
    }
    // Re-insert to move it to the end of the Map's order. This is the whole of
    // the LRU: eviction takes from the front, and the front is whatever has
    // gone longest without being read.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits++;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /**
   * The door everything should come through.
   *
   * Three outcomes, in order: a fresh entry, a load already in flight for this
   * key, or a new load. The middle one is the point — see the header.
   */
  async fetch(key: string, load: () => Promise<V>): Promise<V> {
    if (!this.enabled) return load();

    const fresh = this.get(key);
    if (fresh !== undefined) return fresh;

    const running = this.#inFlight.get(key);
    if (running) {
      this.#shared++;
      return running;
    }

    const pending = load().then((value) => {
      this.#entries.delete(key);
      this.set(key, value);
      return value;
    });

    this.#inFlight.set(key, pending);
    // The slot is released whichever way it goes, so a failure does not wedge
    // the key. `.catch` on the DERIVED promise, not on `pending` — the caller
    // owns `pending` and must still see the rejection; this only stops Node
    // reporting the bookkeeping chain as unhandled.
    void pending.finally(() => this.#inFlight.delete(key)).catch(() => {});

    return pending;
  }

  /** For a boot log or a test. Counts are cumulative, not a window. */
  stats(): { hits: number; misses: number; shared: number; size: number } {
    return { hits: this.#hits, misses: this.#misses, shared: this.#shared, size: this.size };
  }

  clear(): void {
    this.#entries.clear();
  }
}
