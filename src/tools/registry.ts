/**
 * Tool registry and entitlement gating.
 *
 * The important behaviour here is `offerableTo`: the tool list handed to the LLM
 * is filtered by the user's entitlements BEFORE the model ever sees it. A model
 * that cannot see a tool cannot offer it, which is the only reliable way to stop
 * an agent proposing something it will then have to withdraw.
 */

import type { Entitlement, JsonContext } from "../domain/types.ts";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_FILLER_THRESHOLD_MS,
  type ToolDefinition,
} from "./types.ts";

export type ToolSpec = Omit<
  ToolDefinition,
  "deadline_ms" | "filler_threshold_ms" | "mutates_context"
> &
  Partial<Pick<ToolDefinition, "deadline_ms" | "filler_threshold_ms" | "mutates_context">>;

function isGranted(e: Entitlement, now: Date): boolean {
  if (!e.granted) return false;
  if (e.expires_at === null) return true;
  const exp = Date.parse(e.expires_at);
  return Number.isFinite(exp) && exp > now.getTime();
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(spec: ToolSpec): this {
    this.#tools.set(spec.name, {
      deadline_ms: DEFAULT_DEADLINE_MS,
      filler_threshold_ms: DEFAULT_FILLER_THRESHOLD_MS,
      mutates_context: false,
      ...spec,
    });
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /**
   * Tools this user may be OFFERED.
   *
   * A tool with `requires_entitlement` set is invisible unless the entitlement
   * is present, granted and unexpired. When we have no JSON context at all
   * (backend unreachable), entitlement-gated tools are withheld: silently
   * offering a capability we cannot verify is worse than temporarily offering
   * fewer.
   */
  offerableTo(ctx: JsonContext | null, now: Date = new Date()): ToolDefinition[] {
    return this.all().filter((t) => {
      if (!t.requires_entitlement) return true;
      if (!ctx) return false;
      const ent = ctx.entitlements.find((e) => e.key === t.requires_entitlement);
      return ent !== undefined && isGranted(ent, now);
    });
  }

  /** Is this specific call permitted? Checked again at execution time. */
  isEntitled(name: string, ctx: JsonContext | null, now: Date = new Date()): boolean {
    const tool = this.#tools.get(name);
    if (!tool) return false;
    if (!tool.requires_entitlement) return true;
    if (!ctx) return false;
    const ent = ctx.entitlements.find((e) => e.key === tool.requires_entitlement);
    return ent !== undefined && isGranted(ent, now);
  }

  /** OpenAI-style function schemas for the tools this user may be offered. */
  schemasFor(ctx: JsonContext | null, now: Date = new Date()): Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }> {
    return this.offerableTo(ctx, now).map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
}

/**
 * Shallow argument validation against the declared schema.
 *
 * Deliberately not a full JSON Schema implementation: this catches a model
 * hallucinating a field name or omitting a required one, which is the realistic
 * failure. Anything deeper belongs in the handler, which knows its own domain.
 */
export function validateArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  for (const key of tool.parameters.required ?? []) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      return { ok: false, reason: `missing required argument "${key}"` };
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = tool.parameters.properties[key];
    if (!spec) return { ok: false, reason: `unknown argument "${key}"` };

    const actual = Array.isArray(value) ? "array" : typeof value;
    if (spec.type === "integer" || spec.type === "number") {
      if (actual !== "number") return { ok: false, reason: `"${key}" must be a number` };
    } else if (spec.type !== actual) {
      return { ok: false, reason: `"${key}" must be ${spec.type}, got ${actual}` };
    }

    if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
      return { ok: false, reason: `"${key}" must be one of ${spec.enum.join(", ")}` };
    }
  }
  return { ok: true };
}
