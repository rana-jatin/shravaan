/**
 * Which capabilities this deployment runs, and what the boot log says about it.
 *
 * THIS FILE USED TO BE THE PROBLEM IT NOW SOLVES. It held ninety lines of
 * `if (cfg.x.enabled) { … }` for six unrelated features — plus one of their
 * refresh timers — while calendars and alerting lived in two more modules with
 * two more function shapes. Every new capability meant editing it.
 *
 * The capabilities are in `ai/src/capabilities/`, one file each, and the loop
 * that walks them is beside them. What is left here is the part that is genuinely
 * a composition concern: the deployment's capability list, and the shape of the
 * line an operator reads at boot.
 */

import { registerCapabilities } from "@sp-i/ai/capabilities/register.ts";
import { CAPABILITIES } from "@sp-i/ai/capabilities/catalogue.ts";
import type { CapabilityReport } from "@sp-i/ai/capabilities/types.ts";

export { registerCapabilities, CAPABILITIES };
export type { CapabilityWiring } from "@sp-i/ai/capabilities/register.ts";

/**
 * The boot log's `external` block, merged from what each capability reported.
 *
 * server.ts used to build this by reading six config flags back out, which meant
 * the log could disagree with what was actually registered — a capability that
 * failed validation still showed as on. A capability now states what it did and
 * this only collects the answers.
 *
 * The defaults come first so the block has the same keys, in the same order,
 * whatever a deployment has configured. An operator comparing two boot logs
 * should be diffing values, not hunting for which keys went missing.
 */
export function externalSummary(
  reports: readonly CapabilityReport[],
  opts: { weatherEnabled: boolean },
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const report of reports) Object.assign(merged, report.detail);

  return {
    music: false,
    calendars: [],
    calendar_writable: false,
    emergency: false,
    weather: false,
    news: [],
    ...merged,
    // Worth saying out loud at boot: the one hop that is not Sarvam and not in
    // India. See the residency note in shared/src/config/env.ts.
    residency: opts.weatherEnabled ? "get_weather leaves India (Open-Meteo, EU)" : "all in-India",
  };
}
