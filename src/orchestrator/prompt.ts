/**
 * The messages handed to the model.
 *
 * PURE, AND THAT IS THE POINT. These were two private methods on Session which
 * between them touched nothing but `#turns`, `#profile` and SYSTEM_PROMPT — so
 * they were already functions, just spelled as methods on an 1800-line class.
 * As functions they can be asserted on directly, and what the model is actually
 * told is the highest-leverage thing in this system and the hardest to see.
 *
 * SYSTEM_PROMPT itself stays in session-deps.ts with the other declarations,
 * because the measurement note attached to it is about the turn loop's
 * behaviour rather than about rendering a message.
 */

import type { ChatMessage } from "../providers/llm-client.ts";
import type { Profile, Turn } from "../domain/types.ts";
import { SYSTEM_PROMPT } from "./session-deps.ts";

/**
 * Build the LLM window: oldest first, capped, with each turn's own language.
 *
 * `language` is per turn rather than per session on purpose — a code-mixing
 * user produces a mixed window, and the model should see that rather than a
 * flattened single value (docs/02-data-contracts.md section 2.4).
 */
export function buildMessages(
  turns: readonly Turn[],
  profile: Profile | null,
  userText: string,
): ChatMessage[] {
  const history = [...turns]
    .reverse()
    .filter((t) => t.text.trim() !== "")
    .map((t) => ({
      role: t.role === "user" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));

  // The current turn was just recorded, so it is already the last entry.
  const alreadyIncluded =
    history.length > 0 &&
    history[history.length - 1]!.role === "user" &&
    history[history.length - 1]!.content === userText;

  return [
    { role: "system" as const, content: SYSTEM_PROMPT + profileBlock(profile) },
    ...history,
    ...(alreadyIncluded ? [] : [{ role: "user" as const, content: userText }]),
  ];
}

/**
 * The only long-term memory on the turn path. Capped upstream in
 * buildProfile(); this just renders it.
 *
 * Kept as a stable suffix on the system message so the prefix stays
 * byte-identical across turns — Sarvam prices cached input at roughly a third
 * of fresh input, which is only reachable if we do not churn the prefix.
 */
export function profileBlock(profile: Profile | null): string {
  const p = profile;
  if (!p) return "";

  const parts: string[] = [];
  if (p.facts.length > 0) {
    parts.push(`What you know about them:\n${p.facts.map((f) => `- ${f.text}`).join("\n")}`);
  }
  if (p.open_threads.length > 0) {
    parts.push(
      `Left unfinished last time:\n${p.open_threads.map((t) => `- ${t.text}`).join("\n")}`,
    );
  }
  if (p.recent_episodes.length > 0) {
    parts.push(
      `Recently:\n${p.recent_episodes
        .slice(0, 3)
        .map((e) => `- ${e.summary}`)
        .join("\n")}`,
    );
  }
  if (parts.length === 0) return "";

  return (
    `\n\n${parts.join("\n\n")}\n\n` +
    `Draw on this only when it is genuinely relevant. Do not recite it, and do not ` +
    `open by listing what you remember — that is unsettling rather than warm.`
  );
}
