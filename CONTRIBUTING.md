# Adding a capability

A capability is one feature: medication reminders, the weather, the daily
check-in. **Adding one is adding a file and a line.** If it makes you edit
somebody else's registration code, the seams are wrong and that is worth
raising rather than working around.

This document is the interface and the rules that go with it. `CLAUDE.md` is
the wider orientation; `docs/` is the spec and outranks both.

---

## The shape

```
ai/src/capabilities/<name>.ts     the capability
ai/src/tools/<name>.ts            its tools
ai/src/copy/<name>.ts             anything it says out loud, in 11 languages
ai/test/<name>.test.ts            its tests
ai/src/capabilities/catalogue.ts  one line, in registration order
shared/src/config/env.ts          its config block
.env.example                      its variables, documented
```

The capability itself is two functions:

```ts
export const thingCapability: Capability = {
  name: "thing",

  // Pure, and takes only config, so the boot log can say what is off and why
  // before anything has been constructed.
  isConfigured: (cfg) => cfg.thing.enabled,

  register(registry, ctx, contributions): CapabilityReport {
    const spec = createDoThing({ ...ctx });
    registry.register(spec);
    return { name: "thing", registered: true, tools: [spec.name], detail: {} };
  },
};
```

`register` is called **only** when `isConfigured` returned true. It may still
find the config unusable — a feed URL that is not http, a credential that will
not parse — and return `registered: false` after saying so in the log. A
capability that throws while wiring itself does not take the server with it; it
is caught, logged, and skipped.

### What `register` is handed

| Field | What it is |
|---|---|
| `cfg` | The whole `Config`. Read your own block. |
| `log` | The server's logger. What an operator learns about you at boot. |
| `schedules` | Where a reminder you want back later is written. |
| `escalations` | Where an unanswered reminder waits mid-ladder. |
| `sessions` | Live conversations — `reach(uid)` gives one `speakProactively`. |
| `now` | The clock. **Read this, never `Date.now()`.** |

`contributions` is the third argument: what your capability gives every
`Session` beyond its tools. Two fields exist — `alerter` (emergency) and
`fetchContext` (vitals) — and adding a third is the whole cost of a capability
needing one.

### What `register` returns

`CapabilityReport`. Beyond the name and the tool list:

- **`detail`** is merged verbatim into the boot log's `external` block, so you
  decide what an operator is told about you.
- **`dispose`** releases timers and clients at shutdown. It lives on the report
  rather than on the capability because a `Capability` is a module-level
  singleton and two servers can exist in one process.
- **`onOccurrence`** is called when one of your schedules comes due.
- **`escalation`** is how you speak and escalate something nobody answered.

---

## The rules, and why each one is load-bearing

### Unconfigured means unregistered means never described to the user

An agent that offers the weather and then cannot fetch it is worse than one
that never mentioned it. `isConfigured` is that rule with a name, and
`offerableTo` in `tools/registry.ts` is where it bites: a tool the model cannot
see is a tool it cannot offer.

Half-configured is sometimes fine and sometimes not, and the difference is
worth stating in your file. Medication registers with no contacts — it still
reminds, and the log says the family half is off. Emergency alerting does not:
an alarm with nowhere to send it tells somebody help is coming when nothing is.

### A domain outcome is data; only infrastructure throws

`{ repeated: false, reason: "nothing_said_yet" }` is a **success**. `ok: false`
costs a `spoken_fallback_key`, and every key costs eleven translations — so
modelling "there is nothing to repeat" as an error lets the translation backlog
decide how many tools this product can carry.

The line is not "did it work" but "is this the system failing". A geocoder with
no entry for a place is data. A geocoder answering 503 is infrastructure, and
must throw, so the model speaks the reviewed `tool.unavailable` copy instead of
confidently saying a real place does not exist.

### Everything that leaves the process is injectable

Providers take an `HttpFetch`; `Session` takes ASR/LLM/TTS factories; you take
your stores and your clock. This is why `npm test` needs no credentials and
opens no sockets. If you add something that talks to the network and does not
take its client as a dependency, you have made a piece of the system
untestable — `docs/07-defect-register.md` §9 records what that cost last time.

**Read `now()` rather than `Date.now()`.** The first end-to-end test of
medication reminders escalated to the family without the device ever speaking,
because one capability read wall time while everything around it read the
test's clock.

### Copy is a table, not a string

Anything spoken goes in `ai/src/copy/`, in all eleven languages, through
`t(CATALOGUE, key, language)`. A missing translation must never become silence
— the resolver walks the ladder in `languages.json` and always ends in a
string. Mark unreviewed entries `draft()` and report them at boot; nine of
eleven languages are placeholders today and the server says so.

The family message is the exception and is English, because the contact list
carries an address and a name and nothing else.

### What a capability may say about somebody's health

**Ask them, wait, then tell somebody. In that order, and nothing else.**

No tool result may carry a judgement about a reading — not `high`, not
`severity`, not a trend, not a comparison. Anything in a tool result is handed
to a language model and spoken aloud inside the same turn, so a field named
`concern` is medical advice with extra steps. There is a test asserting a
vitals result contains only a number, a unit and a time, and it is there to be
kept.

The numbers go to the family, who can act on them. The person is asked how they
are, in copy a human reviewed. If you find yourself wanting to tell somebody
alone at eleven at night that their pulse looked wrong, that is the moment this
rule exists for.

### Config is nested by concern, and validated at boot

`cfg.thing.apiBase`, not `cfg.thingApiBase`. Fail at boot, not on the first
session. Add every variable to `.env.example` by hand — it is kept in sync with
`shared/src/config/env.ts` by nothing but discipline.

**Never cast to `Config`.** Use `testConfig()` from `ai/test/helpers.ts`;
eslint rejects the cast. Two fixtures once used `as unknown as Config` and a
nested-config migration typechecked clean while thirteen tests failed.

---

## If it acts between turns

Four capabilities do, and none of them implements timing, persistence, retries,
speech or escalation. There are three loops in this product and you should not
be adding a fourth:

- **the ticker** (`ai/src/scheduler/`) fires a schedule that came due;
- **the sweep** (`ai/src/escalation/`) walks an unanswered reminder up a ladder;
- **the watcher** (`ai/src/vitals/`) polls for alerts raised outside this
  process.

Write a schedule, return an `onOccurrence` that opens a ladder, and return an
`escalation` handler that says what to speak and who to tell. That is the whole
of medication and the whole of the check-in.

**`onOccurrence` does not speak.** The sweep owns every utterance, so there is
exactly one code path that says a reminder out loud and exactly one that decides
whether it landed — otherwise the first attempt follows different rules from
the retry.

**The ladder breaks toward silence, and the sweep breaks toward telling
somebody.** Told twice, a person takes a second tablet; told never, nobody is
woken at three in the morning. Those asymmetries point in opposite directions
and are written down at the top of each file.

`EscalationHandler` has two optional hooks worth knowing about. `answered` is
polled before the clock on every sweep — the check-in uses it because "they
said anything at all" is not something a tool call can represent. `settled` is
called when the ladder ends and exists for a reminder that mirrors state
outside this process; vitals uses it to close the alert on the safety service.

---

## Before you commit

```bash
npm run check      # format + lint + typecheck + test. Not `npm test` alone.
```

For anything touching boot wiring, the strongest check available is to boot the
server against a synthetic `.env` before and after and diff the log. It catches
what the test suite does not — a capability that quietly stopped registering,
a timer that started when nothing asked for one.

Small, verifiable steps. Prefer moves over delete-and-recreate so history
survives. Don't change external behaviour as a side effect of a refactor, and
if a change alters what a user hears or an operator sees, say so explicitly.

Comments explain **why**, not what. This codebase's comments carry
measurements, rejected alternatives and the reasoning behind a constant. When
you move code, move its comment with it; when a comment says something was
measured, do not paraphrase the numbers away.
