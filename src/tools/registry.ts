/**
 * Tool registry and entitlement gating.
 *
 * The important behaviour here is `offerableTo`: the tool list handed to the LLM
 * is filtered by the user's entitlements BEFORE the model ever sees it. A model
 * that cannot see a tool cannot offer it, which is the only reliable way to stop
 * an agent proposing something it will then have to withdraw.
 */

import type { ToolSchema } from "../providers/sarvam-llm.ts";
import type { Entitlement, JsonContext } from "../domain/types.ts";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_FILLER_THRESHOLD_MS,
  type JsonSchemaProperty,
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
  schemasFor(ctx: JsonContext | null, now: Date = new Date()): ToolSchema[] {
    return this.offerableTo(ctx, now).map(toSchema);
  }
}

/**
 * A tool definition as the model sees it.
 *
 * `strict: true` is emitted only when the schema actually satisfies strict
 * mode's rule — every property required, no additional properties. OpenAI
 * rejects a strict schema with optional fields, and while Sarvam accepted
 * `strict` in the probe it was never tested against a non-conforming schema.
 * Claiming strictness we do not meet is how you earn a 400 on the one turn a
 * user needed the tool, so we claim it only where it is true.
 */
export function toSchema(t: ToolDefinition): ToolSchema {
  const props = Object.keys(t.parameters.properties);
  const required = t.parameters.required ?? [];
  const conforms =
    t.parameters.additionalProperties === false && props.every((p) => required.includes(p));

  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(conforms ? { strict: true } : {}),
    },
  };
}

/**
 * Argument validation against the declared schema.
 *
 * Still deliberately not a full JSON Schema implementation — no `$ref`, no
 * nested objects, no composition keywords. It enforces exactly what our schemas
 * can express, because a validator that silently ignores a constraint it claims
 * to check is worse than one with a stated boundary.
 *
 * `strict` in OpenAI's sense is enforced HERE rather than trusted to the model.
 * Sarvam accepts the `strict` flag but nothing in its documentation promises to
 * honour it, and a companion that dispatches a malformed call because a remote
 * flag was ignored is the kind of failure that only shows up in production.
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

  // A tool that declares no parameters accepts anything and reads none of it.
  //
  // This is not laxity, it is the cheaper of two failures. sarvam-105b emits a
  // junk argument object for no-argument tools at a measured ~40% rate — the
  // observed shape is `{"{}": "{}"}`, generated token by token (`{`, `"{}": `,
  // `"{}`, `"`, `}`), so it is the model inventing an object, not our parser
  // mangling one. Rejecting it cost a whole extra round trip on nearly every
  // `end_conversation`, which is to say on nearly every conversation close, and
  // spends a request against the rate limit ADR 0003 calls the system's
  // concurrency ceiling. The handler signature is `(_args, ctx)`; there is no
  // argument for junk to corrupt.
  //
  // Tools that DO declare parameters keep the strict check below — there a
  // stray key is a real hallucination and rejecting it is what stops the model
  // from quietly acting on something the user never asked for.
  const declaresNoParameters = Object.keys(tool.parameters.properties).length === 0;

  for (const [key, value] of Object.entries(args)) {
    const spec = tool.parameters.properties[key];
    if (!spec) {
      if (declaresNoParameters) continue;
      return { ok: false, reason: `unknown argument "${key}"` };
    }

    const failure = checkValue(key, value, spec);
    if (failure) return { ok: false, reason: failure };
  }
  return { ok: true };
}

function checkValue(key: string, value: unknown, spec: JsonSchemaProperty): string | null {
  const actual = Array.isArray(value) ? "array" : typeof value;

  switch (spec.type) {
    case "integer":
      // `typeof 1.5 === "number"` too, so the previous check let a float through
      // as an integer. A tool that takes a count deserves a count.
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `"${key}" must be an integer, got ${JSON.stringify(value)}`;
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `"${key}" must be a number, got ${JSON.stringify(value)}`;
      }
      break;
    case "array": {
      if (!Array.isArray(value)) return `"${key}" must be array, got ${actual}`;
      const itemType = spec.items?.type;
      if (itemType) {
        for (const [i, item] of value.entries()) {
          const bad = checkValue(`${key}[${i}]`, item, { type: itemType });
          if (bad) return bad;
        }
      }
      break;
    }
    default:
      if (spec.type !== actual) return `"${key}" must be ${spec.type}, got ${actual}`;
  }

  if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
    return `"${key}" must be one of ${spec.enum.join(", ")}`;
  }
  return null;
}
