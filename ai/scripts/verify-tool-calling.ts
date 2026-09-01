/**
 * Does sarvam-105b actually do OpenAI-style function calling?
 *
 * ADR 0003 flagged that NOTHING in Sarvam's documentation describes its
 * tool-calling reliability, and docs/04-milestones.md named slice 6 as the real
 * test. src/providers/sarvam-llm.ts assumes an OpenAI-compatible `tool_calls`
 * delta on faith. This script is that test.
 *
 * It deliberately does NOT use SarvamLlm. Parsing through the client under test
 * would hide exactly the divergence we are looking for, so it speaks to the
 * endpoint directly and prints raw SSE frames.
 *
 *   npm run verify:tools           # all probes
 *   npm run verify:tools -- --raw  # plus every SSE line, unparsed
 *
 * Each probe answers one question that changes what we build:
 *   1  are `tools` accepted at all, and is a call emitted?
 *   2  is the delta shape OpenAI's (index / id / function.name / arguments)?
 *   3  does a role:"tool" result round-trip back into a spoken answer?
 *   4  tool_choice: "required" | "none" | {function:{name}}
 *   5  parallel calls — two tools in one round
 *   6  strict: true, and whether it is accepted or rejected
 */

import { loadConfig } from "@sp-i/shared/config/env.ts";
import { SarvamLlm, parseToolArgs, type ChatMessage } from "../src/providers/sarvam-llm.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ToolExecutor } from "../src/tools/executor.ts";
import { BUILTIN_TOOLS } from "../src/tools/builtin.ts";
import { SYSTEM_PROMPT } from "../src/orchestrator/session.ts";
import type { SessionToolHost } from "../src/tools/types.ts";

const RAW = process.argv.includes("--raw");
const cfg = loadConfig();

type Delta = {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type Probe = {
  ok: boolean;
  status: number;
  /** Raw SSE `data:` payloads, in order. */
  frames: string[];
  text: string;
  deltas: Delta[];
  /** First tool_calls delta seen, verbatim — the shape question. */
  firstToolCallDelta: unknown;
  calls: Array<{ index: number; id: string; name: string; args: string }>;
  errorBody: string;
};

const GET_TIME = {
  type: "function",
  function: {
    name: "get_time",
    description: "Get the current time and date in the user's timezone.",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone, e.g. Asia/Kolkata" },
      },
      required: [],
    },
  },
};

const GET_WEATHER = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

async function probe(body: Record<string, unknown>): Promise<Probe> {
  const url = new URL("/v1/chat/completions", cfg.sarvam.apiBase);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": cfg.sarvam.apiKey,
    },
    body: JSON.stringify({ model: cfg.sarvam.llmModel, stream: true, ...body }),
  });

  const out: Probe = {
    ok: res.ok,
    status: res.status,
    frames: [],
    text: "",
    deltas: [],
    firstToolCallDelta: null,
    calls: [],
    errorBody: "",
  };

  if (!res.ok || !res.body) {
    out.errorBody = await res.text().catch(() => "<unreadable>");
    return out;
  }

  const acc = new Map<number, { id: string; name: string; args: string }>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      if (!line.startsWith("data:")) {
        if (RAW) console.log(`    [non-data] ${line}`);
        continue;
      }
      const payload = line.slice(5).trim();
      out.frames.push(payload);
      if (RAW) console.log(`    ${payload}`);
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: Delta }> };
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        out.deltas.push(delta);
        if (delta.content) out.text += delta.content;
        if (delta.tool_calls) {
          if (out.firstToolCallDelta === null) out.firstToolCallDelta = delta.tool_calls;
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            const cur = acc.get(i) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(i, cur);
          }
        }
      } catch {
        if (RAW) console.log(`    [unparseable] ${payload.slice(0, 200)}`);
      }
    }
  }

  out.calls = [...acc.entries()].map(([index, c]) => ({ index, ...c }));
  return out;
}

function report(label: string, p: Probe, notes: string[] = []): void {
  const head = p.ok ? "ok" : `HTTP ${p.status}`;
  console.log(`\n-- ${label} -- ${head}`);
  if (!p.ok) {
    console.log(`   body: ${p.errorBody.slice(0, 600)}`);
    for (const n of notes) console.log(`   ${n}`);
    return;
  }
  console.log(
    `   frames: ${p.frames.length}  deltas: ${p.deltas.length}  calls: ${p.calls.length}`,
  );
  if (p.text.trim()) console.log(`   text: ${JSON.stringify(p.text.slice(0, 200))}`);
  for (const c of p.calls) {
    console.log(
      `   call[${c.index}] id=${c.id || "<none>"} name=${c.name || "<none>"} args=${c.args || "<empty>"}`,
    );
  }
  if (p.firstToolCallDelta) {
    console.log(`   first tool_calls delta: ${JSON.stringify(p.firstToolCallDelta)}`);
  }
  for (const n of notes) console.log(`   ${n}`);
}

async function main(): Promise<void> {
  console.log(`model=${cfg.sarvam.llmModel}  base=${cfg.sarvam.apiBase}`);
  console.log("Probing sarvam-105b tool-calling. ADR 0003's open question.");

  // 1 — are tools accepted, and does a call come back?
  const p1 = await probe({
    tools: [GET_TIME],
    messages: [{ role: "user", content: "What time is it right now?" }],
  });
  report("1  tools accepted + call emitted", p1, [
    p1.calls.length > 0
      ? "VERDICT: a tool call was emitted."
      : "VERDICT: NO tool call -- model answered in prose or ignored `tools`.",
  ]);

  // 2 — shape of the delta, from probe 1's frames.
  const shaped =
    Array.isArray(p1.firstToolCallDelta) && (p1.firstToolCallDelta as unknown[]).length > 0;
  console.log(
    `\n-- 2  delta shape -- ${shaped ? "tool_calls present in delta" : "no tool_calls delta seen"}`,
  );
  if (shaped) {
    const first = (p1.firstToolCallDelta as Array<Record<string, unknown>>)[0]!;
    console.log(`   keys: ${Object.keys(first).join(", ")}`);
    console.log(
      `   has index: ${"index" in first}  has id: ${"id" in first}  has function: ${"function" in first}`,
    );
    console.log(
      `   arguments fragmented across deltas: ${p1.deltas.filter((d) => d.tool_calls).length > 1}`,
    );
  }

  // 3 — does a tool result round-trip?
  const call = p1.calls[0];
  if (call && call.name) {
    const p3 = await probe({
      tools: [GET_TIME],
      messages: [
        { role: "user", content: "What time is it right now?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: call.id || "call_1",
              type: "function",
              // Repaired through the real parser before being sent back. The raw
              // accumulator above is naive ON PURPOSE — it is what exposes the
              // duplicate-value divergence — but Sarvam validates that
              // `arguments` is a JSON-encoded string on the way in, so sending
              // the raw `{}{}` would fail this probe for the wrong reason.
              function: {
                name: call.name,
                arguments: JSON.stringify(parseToolArgs(call.args, call.name)),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: call.id || "call_1",
          content: JSON.stringify({ time: "18:42", date: "2026-08-29", timezone: "Asia/Kolkata" }),
        },
      ],
    });
    report("3  tool result round-trips into an answer", p3, [
      p3.text.trim() !== ""
        ? "VERDICT: the model spoke an answer from the tool result."
        : "VERDICT: no prose came back from the tool result.",
    ]);
  } else {
    console.log("\n-- 3  result round-trip -- SKIPPED (probe 1 produced no call to answer)");
  }

  // 4 — tool_choice
  const choices: Array<[string, unknown]> = [
    ["required", "required"],
    ["none", "none"],
    ["named", { type: "function", function: { name: "get_time" } }],
  ];
  for (const [label, choice] of choices) {
    const p = await probe({
      tools: [GET_TIME],
      tool_choice: choice,
      messages: [{ role: "user", content: "Hello, how are you today?" }],
    });
    report(`4  tool_choice: ${label}`, p, [
      label === "none"
        ? p.calls.length === 0
          ? "VERDICT: honoured -- no call, as asked."
          : "VERDICT: IGNORED -- called a tool despite tool_choice:none."
        : p.calls.length > 0
          ? "VERDICT: honoured -- a call was forced."
          : "VERDICT: IGNORED or unsupported -- no call despite being asked.",
    ]);
  }

  // 5 — parallel calls in one round
  const p5 = await probe({
    tools: [GET_TIME, GET_WEATHER],
    messages: [{ role: "user", content: "What time is it, and what is the weather in Bengaluru?" }],
  });
  report("5  parallel calls in one round", p5, [
    p5.calls.length > 1
      ? `VERDICT: ${p5.calls.length} calls in one round -- parallel supported.`
      : "VERDICT: at most one call per round; parallelism must come from multiple rounds.",
  ]);

  // 6 — strict
  const p6 = await probe({
    tools: [
      {
        type: "function",
        function: {
          ...GET_WEATHER.function,
          strict: true,
          parameters: { ...GET_WEATHER.function.parameters, additionalProperties: false },
        },
      },
    ],
    messages: [{ role: "user", content: "What is the weather in Bengaluru?" }],
  });
  report("6  strict:true accepted", p6, [
    p6.ok
      ? "VERDICT: `strict` did not break the request (accepted or ignored)."
      : "VERDICT: REJECTED -- `strict` is not supported on this endpoint.",
  ]);

  await endToEnd();

  console.log("\nDone. Record the answers in docs/adr/0003-llm.md.");
}

/**
 * Probe 7 — the whole loop, through the real code.
 *
 * Probes 1-6 speak to the endpoint directly, on purpose: they had to be able to
 * see a divergence the client might paper over. This one is the opposite test,
 * and the one that actually matters — SarvamLlm, ToolRegistry and ToolExecutor
 * exactly as the orchestrator wires them, driven to a spoken answer.
 */
async function endToEnd(): Promise<void> {
  console.log("\n-- 7  end-to-end through SarvamLlm + registry + executor");

  const registry = new ToolRegistry();
  for (const spec of BUILTIN_TOOLS) registry.register(spec);

  const host: SessionToolHost = {
    lastAgentReply: () => "I said your tablets are at half past eight.",
    requestLanguage: (code) => ({ switched: true, language: code }),
    pace: () => 1.0,
    setPace: (p) => p,
    requestEnd: () => console.log("   [host] end requested"),
    rememberFact: (text, kind) => console.log(`   [host] remember (${kind}): ${text}`),
    forgetFacts: async () => ({ forgotten: 0, texts: [] }),
    recallFacts: async () => [],
    recentMood: async () => null,
    timezone: () => "Asia/Kolkata",
    playMedia: (req) => console.log(`   [host] play ${req.source}: ${req.title}`),
    stopMedia: (reason) => console.log(`   [host] stop media (${reason})`),
  };

  const executor = new ToolExecutor({
    registry,
    uid: "verify",
    sid: "verify",
    host,
    speakFiller: () => console.log("   [filler] one moment"),
    log: (level, msg, extra) => console.log(`   [${level}] ${msg} ${JSON.stringify(extra ?? {})}`),
  });

  const llm = new SarvamLlm(cfg);
  const messages: ChatMessage[] = [
    // The REAL prompt, not a stand-in. Probe 7 exists to test what ships.
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "What time is it? And remember that my mother is called Sharada." },
  ];

  for (let round = 0; round <= 3; round++) {
    const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let text = "";

    for await (const chunk of llm.stream(messages, {
      tools: registry.schemasFor(null),
      toolChoice: round < 3 ? "auto" : "none",
      onWarn: (m, extra) => console.log(`   [warn] ${m} ${JSON.stringify(extra)}`),
    })) {
      if (chunk.type === "text") text += chunk.text;
      else calls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
    }

    if (text.trim()) console.log(`   round ${round} said: ${JSON.stringify(text.trim())}`);
    if (calls.length === 0) {
      console.log(
        text.trim()
          ? "   VERDICT: the loop reached a spoken answer."
          : "   VERDICT: the model went silent without calling anything.",
      );
      // A companion cannot speak markdown. Worth knowing whether tool rounds
      // tempt the model into it, because the TTS will read the asterisks out.
      if (/[*_#`]|^\s*[-\d]+[.)]\s/m.test(text)) {
        console.log("   NOTE: reply contains markdown — it would be spoken aloud as punctuation.");
      }
      return;
    }

    console.log(
      `   round ${round} called: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ")}`,
    );

    // Concurrently, exactly as session.#runTools now does.
    const results = await Promise.all(
      calls.map((c) =>
        executor.execute(
          { call_id: c.id, name: c.name, args: c.args },
          { language: "en-IN", jsonContext: null },
        ),
      ),
    );
    for (const r of results) {
      console.log(
        `   -> ${r.name} ${r.ok ? `ok ${JSON.stringify(r.data)}` : `FAILED ${r.error.code}: ${r.error.message}`} (${r.elapsed_ms}ms)`,
      );
    }

    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });
    for (const r of results) {
      messages.push({
        role: "tool",
        tool_call_id: r.call_id,
        content: JSON.stringify(r.ok ? r.data : { error: r.error.code }),
      });
    }
  }
}

await main();
