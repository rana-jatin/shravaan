/**
 * Tool execution: deadlines, spoken fillers, pending tracking.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: `sess:{sid}:pending` is cleared on
 * EVERY path — success, timeout, thrown handler, missing tool, refused
 * entitlement. A stale pending entry is what makes an agent claim it is still
 * working on something it abandoned, and that is a worse failure than the
 * original error.
 *
 * Deadlines are per call, not global: a slow tool must not consume the whole
 * turn budget (docs/02-data-contracts.md section 5).
 */

import { randomUUID } from "node:crypto";
import type { JsonContext, LanguageCode } from "../domain/types.ts";
import { ToolRegistry, validateArgs } from "./registry.ts";
import type { PendingCall, ProgressKey, SessionToolHost, ToolCall, ToolResult } from "./types.ts";

export type ExecutorDeps = {
  registry: ToolRegistry;
  uid: string;
  sid: string;
  /**
   * A call has run past its filler threshold.
   *
   * Called at most once PER CALL, but the session may still decline to say
   * anything: with calls now running concurrently, two slow tools in one round
   * would otherwise stack two fillers back to back, and a model that already
   * introduced the call itself has made the filler redundant. The round-level
   * decision lives in the orchestrator, which is the only thing that knows what
   * a round is. `progressKey` is the tool's own line, when it has one.
   */
  speakFiller: (language: LanguageCode, progressKey?: ProgressKey) => void;
  /** The live session, narrowed. Handed to every handler. See SessionToolHost. */
  host: SessionToolHost;
  /** Persist / clear the in-flight entry. Failures here must not break the call. */
  setPending?: (call: PendingCall) => Promise<void>;
  clearPending?: (callId: string) => Promise<void>;
  /** Invalidate user:{uid}:ctx after a mutating tool succeeds. */
  invalidateContext?: () => Promise<void>;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
};

export class ToolExecutor {
  readonly #d: ExecutorDeps;
  readonly #now: () => number;
  /** Live in-flight calls, mirrored to the store. */
  readonly #pending = new Map<string, PendingCall>();

  constructor(deps: ExecutorDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  hasPending(callId: string): boolean {
    return this.#pending.has(callId);
  }

  async execute(
    call: ToolCall,
    ctx: { language: LanguageCode; jsonContext: JsonContext | null; signal?: AbortSignal },
  ): Promise<ToolResult> {
    const started = this.#now();
    const callId = call.call_id || randomUUID();
    const base = { call_id: callId, name: call.name };

    const tool = this.#d.registry.get(call.name);
    if (!tool) {
      // The model invented a tool. Nothing was dispatched, so nothing to clear.
      return {
        ...base,
        ok: false,
        elapsed_ms: this.#now() - started,
        error: {
          code: "unknown_tool",
          message: `no such tool: ${call.name}`,
          spoken_fallback_key: "tool.generic",
        },
      };
    }

    // Re-check entitlement at execution even though offering was already
    // filtered: the context may have gone stale mid-session, and a capability
    // the user has lost must not still fire.
    if (!this.#d.registry.isEntitled(call.name, ctx.jsonContext)) {
      return {
        ...base,
        ok: false,
        elapsed_ms: this.#now() - started,
        error: {
          code: "not_entitled",
          message: `missing entitlement ${tool.requires_entitlement}`,
          spoken_fallback_key: "tool.not_entitled",
        },
      };
    }

    const valid = validateArgs(tool, call.args);
    if (!valid.ok) {
      return {
        ...base,
        ok: false,
        elapsed_ms: this.#now() - started,
        error: {
          code: "invalid_args",
          message: valid.reason,
          spoken_fallback_key: "tool.invalid_args",
        },
      };
    }

    const pending: PendingCall = {
      call_id: callId,
      name: call.name,
      args: call.args,
      dispatched_at: new Date().toISOString(),
      deadline_ms: tool.deadline_ms,
      filler_spoken: false,
    };
    this.#pending.set(callId, pending);
    await this.#safe(() => this.#d.setPending?.(pending), "setPending");

    // Filler fires only if the call actually runs slow. Speaking it immediately
    // would make every fast tool feel slow.
    const fillerTimer = setTimeout(() => {
      const live = this.#pending.get(callId);
      if (!live || live.filler_spoken) return;
      live.filler_spoken = true;
      this.#d.speakFiller(ctx.language, tool.progress_key);
    }, tool.filler_threshold_ms);
    fillerTimer.unref?.();

    const abort = new AbortController();
    const onOuterAbort = () => abort.abort();
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });

    const deadlineTimer = setTimeout(() => abort.abort(), tool.deadline_ms);
    deadlineTimer.unref?.();

    try {
      const data = await tool.handler(call.args, {
        uid: this.#d.uid,
        sid: this.#d.sid,
        language: ctx.language,
        jsonContext: ctx.jsonContext,
        signal: abort.signal,
        host: this.#d.host,
      });

      if (tool.mutates_context) {
        await this.#safe(() => this.#d.invalidateContext?.(), "invalidateContext");
      }

      return {
        ...base,
        ok: true,
        data,
        elapsed_ms: this.#now() - started,
        context_mutated: tool.mutates_context,
      };
    } catch (err) {
      const timedOut = abort.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      this.#d.log?.(timedOut ? "warn" : "error", "tool failed", {
        tool: call.name,
        timedOut,
        err: message,
      });

      return {
        ...base,
        ok: false,
        elapsed_ms: this.#now() - started,
        error: timedOut
          ? {
              code: "timeout",
              message: `exceeded ${tool.deadline_ms}ms`,
              spoken_fallback_key: "tool.timeout",
            }
          : {
              code: "upstream_error",
              message,
              spoken_fallback_key: "tool.unavailable",
            },
      };
    } finally {
      // Every path. A stale pending entry outlives the turn and makes the agent
      // claim it is still working on something it gave up on.
      clearTimeout(fillerTimer);
      clearTimeout(deadlineTimer);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
      this.#pending.delete(callId);
      await this.#safe(() => this.#d.clearPending?.(callId), "clearPending");
    }
  }

  /** Abandon everything in flight — used on barge-in and teardown. */
  async clearAll(): Promise<void> {
    const ids = [...this.#pending.keys()];
    this.#pending.clear();
    for (const id of ids) await this.#safe(() => this.#d.clearPending?.(id), "clearPending");
  }

  /** Store failures must never break a tool call that otherwise succeeded. */
  async #safe(fn: () => Promise<void> | undefined, what: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.#d.log?.("warn", `${what} failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
