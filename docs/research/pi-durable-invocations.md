# How pi-durable spreads a run across invocations

Research for issue #16 (blocks #13). Question: how does `PiHarness` / pi-durable spread one run's turns across Durable Object invocations, is the 50-subrequest free-plan limit per turn or per run, and when does a new invocation start?

Versions read: `@earendil-works/pi-durable` 1.4.0, `agents` 0.31.0 (the pinned ones). Date: 2026-10-30.

Tags: **[Source]** read in the pinned package code, **[Docs]** stated in official docs, **[Spike]** measured in `spike/`, **[Inferred]** my reasoning, not proven.

## Short answer

1. **Turns are not spread across invocations.** One run (all its turns and tool calls) executes inside one detached "wait" that the wake job starts in a single alarm invocation. Pi's scheduler runs the turns in memory while that wait lasts. [Source]
2. **A new invocation starts only at defined boundaries** (table below): a submit, the 30 s heartbeat, the 10-minute wait budget, a sleep (retry backoff), a crash or eviction. Not at a turn boundary. [Source]
3. **The 50-subrequest limit is not documented per turn or per run.** Cloudflare says "per invocation". Which invocation the detached model calls are charged to was never measured. If they are charged to the alarm invocation that started the wait, the limit covers the whole wait (up to 10 minutes of turns), not one turn. [Docs + Inferred]
4. The design's step 8 ("each batch runs in its own alarm wake") is **not guaranteed by the harness**. It holds only if a batch is not queued into a run that is already waiting. See "Consequence for the design".

## What the source proves

### One wake job, one wait loop

Line numbers are those of the published build under `agents/dist/harness/pi/index.js` unless noted.

- `PiHarness` keeps a single Lifecycle job `pi-wake` (`WAKE_JOB_ID`), `singleflight: true`, `recoveryLoop: true` (l.341, `_wake`). [Source]
- `submit()` goes through `enqueue` and `_admit` (l.326): it pushes the wake job due now, hands the input to pi (`conversation.submit`), then pushes the wake job again. The RPC call itself runs no model work; it only writes SQLite and schedules. [Source]
- The alarm fires `onJob` and then `_wakeStep` (l.361). If pi has work (`pi.wake().active`), `_wakeStep`:
  - calls `pi.resume()` (starts pi's in-memory task scheduler),
  - starts `_waitWhileActive(pi)` as a **detached promise** kept in `#waiting`,
  - registers it with `lifecycle.trackAlarmWork(wait)` (l.376), and
  - **returns immediately** with `rescheduleAt = now + 30 s` (the heartbeat).

  So the alarm handler returns promptly and the run goes on in the detached promise. The `trackAlarmWork` comment in `lifecycle-v1rKHV2C.js` (l.519) says "The alarm itself returns promptly". [Source]
- `_waitWhileActive` (l.392) loops while `pi.wake().active`, sleeping until pi's `onWake` callback signals a change (or 1 s polls without `onWake`). Pi's own scheduler runs generation turns and tool tasks in between. The loop ends when pi is idle, or at `WAIT_BUDGET_MS = 10 min` (l.32). [Source]
- When the wait ends, `.then(ended => _wake())` pushes the wake job again (l.370). If pi is idle, the next `_wakeStep` finds no work and the job completes. If the budget ran out, the job runs again as a **new alarm invocation** and starts a new wait. [Source]
- Heartbeat: every 30 s the job is due again. `_wakeStep` sees `#waiting` is set and returns a new heartbeat without doing anything (l.363). So a long run has extra `alarm()` invocations every 30 s that do **no** model work. [Source]
- The docs agree: "The wake-up job waits inside an alarm invocation, and an alarm invocation runs for up to 15 minutes", "The harness hands off to a new alarm every 10 minutes", "While Pi has work, the job's heartbeat alarm fires every 30 seconds". https://developers.cloudflare.com/agents/harnesses/pi/ [Docs]
- pi-durable defines "a turn is one model response and its tool calls; a run is the turns from an input to its final answer" (README l.101). It has no notion of invocations; it only reports `wake()` (`active`, `at`) to the host (README l.166). [Source]

### When a new invocation starts

| Trigger | New alarm invocation? | Evidence |
|---|---|---|
| Next turn of the same run | No, same wait loop | `_waitWhileActive` |
| Tool call within a turn | No | same |
| Follow-up input submitted while a run is active (`whenBusy` defaults to `followUp`) | The RPC call is its own invocation, but the work joins the running wait (`_wakeStep` returns early if `#waiting`) | `enqueue`, l.363 |
| `submit()` while pi is idle | The RPC is one invocation; the work runs in the next alarm invocation (job pushed due now) | `_admit`, `_wake` |
| 30 s heartbeat | Yes, but it does no work while a wait is running | l.363 |
| Wait budget (10 min) exhausted | Yes: job re-pushed, new wait | l.370, l.32 |
| Only sleeping tasks (e.g. retry backoff), nothing active | Yes: job rescheduled at `wake.at` | end of `_wakeStep` |
| A sleep alongside running work | No: the wait loop calls `pi.resume()` itself when due | `_waitWhileActive` |
| Crash, eviction, `ctx.abort()` | Yes: the deadman alarm (30 s pre-arm, `DEADMAN_ALARM_DELAY_MS`) or heartbeat restarts the object; pi reopens and resumes | lifecycle l.445; [Spike] restart in about 0.4 s |
| Wake dispatch fails | Yes, with backoff (30 s doubling to 10 min) | `onJobError` |

### Cloudflare facts

- Only one `alarm()` instance runs at a time per object. https://developers.cloudflare.com/durable-objects/api/alarms/ [Docs]. Lifecycle's code still guards against overlapping alarm calls, so do not lean on this beyond the normal path.
- Alarm handler wall time is at most 15 minutes; CPU limit per invocation (HTTP request, WebSocket message or alarm) is 30 s. https://developers.cloudflare.com/durable-objects/platform/limits/ [Docs]
- Subrequests: "Workers Free: 50 subrequests per invocation". The page does not say what an invocation is for alarms or detached work, and does not mention Workers AI bindings. https://developers.cloudflare.com/workers/platform/limits/ [Docs]. The Durable Objects limits page does not mention subrequests.

## What the spike shows

- `check=subrequests` made all calls inside **one RPC invocation**; call 51 threw "Too many subrequests by single Worker invocation", AI calls and fetches mixed. pi added none. [Spike] (`spike/src/index.ts` `subrequests()`; design "Spike outcome" row 2.)
- The design already notes the gap: "The limit was measured per RPC invocation; the alarm invocation is assumed to have the same one." No check ran several model turns in one wait and counted subrequests, so **per turn vs per run is not measured**. [Spike, absence]
- Resume check: a run started with `submit()` returned at once and "continues in the Lifecycle alarm", surviving `ctx.abort()` (`spike/RESUME.md`). This confirms the run lives in alarm-side work but did not count invocations. [Spike]
- A redeploy did not interrupt a busy object for minutes; the old instance finished. Consistent with a long-lived detached wait. [Spike]

## Inferred (not proven)

- **Which invocation the detached work is charged to.** The model calls happen in a promise started inside alarm invocation A that outlives A's handler. Workers charge subrequests to an invocation context, and a detached promise most plausibly still belongs to A, so all turns of the wait would share A's 50. The platform could instead count against another invocation, or stop counting once the handler returns. Nothing read decides this. [Inferred]
- **Heartbeat alarms have their own counters** but make no AI calls, so they do not add budget. [Inferred]
- **A crash resets the counter**: resumed work runs in a new alarm invocation with a fresh budget. [Inferred, follows from "per invocation"]

## Consequence for the design

- A batch of up to 40 Clef calls fits the budget only if it runs in an invocation of its own. With the behaviour above, all of a run's calls land in one wait and would share one budget of 50, however many turns the run has. Queueing a second batch as a follow-up while the first is still running puts both in the same wait, so 40 + 40 would exceed 50 if the counter is per wait.
- Safest shape under the uncertainty: one batch is one run, and the next batch is submitted only after the previous run has settled (`wait()` returned). Then the `submit()` starts a fresh alarm invocation (pi idle, wake job due now). `score_offers` keeps its own call counter, as the design says, and does not trust the wake boundary.
- The orchestrator's own model turns (GLM through `createAI`) are AI-binding subrequests too, so they share the budget and grow with the number of turns, not with batch size.

## Open uncertainty and the cheap measurement

Unresolved: whether detached work spanning many turns in one wait shares one 50-subrequest budget, resets per turn, or is charged to some other invocation than the alarm that started it.

Cheapest test (free plan, a few hundred neurons at most): add a spike check that `submit()`s a run with a `replay: "safe"` tool `ping` that calls `env.AI.run("@cf/meta/llama-3.2-1b-instruct", { max_tokens: 1 })` once, and a prompt that asks the model to call it 30 times in sequence. That is 30 tool subrequests plus about 30 orchestrator turns, so over 50 in total. Wrap `alarm()` in the spike class to log a `crypto.randomUUID()` per alarm invocation, tag each call with the current one, and watch `wrangler tail`. Read the result:
- A "Too many subrequests" error near 50 total: counted per wait (per run).
- No error with all 60 or so calls passing: counted per turn or not charged to the detached work.

Repeat once with a follow-up submitted mid-run to confirm it joins the same wait.

## Sources

- `agents` 0.31.0: `dist/harness/pi/index.js`, `dist/lifecycle-v1rKHV2C.js`.
- `@earendil-works/pi-durable` 1.4.0: `README.md` (turn and run definitions, `wake()` and `onWake`).
- https://developers.cloudflare.com/agents/harnesses/pi/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/workers/platform/limits/
- `spike/RESUME.md`, `spike/src/index.ts`, `docs/design.md` (Scouting run step 8, Spike outcome), `docs/adr/0001-pi-durable-on-piharness.md`.
