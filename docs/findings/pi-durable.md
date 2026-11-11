# Pi Durable on PiHarness: how a run actually executes

Read in the pinned `agents` 0.31.0 and `@earendil-works/pi-durable` 1.4.0 sources, then measured. Practices and the spike's other learnings are in [pi-best-practices.md](../pi-best-practices.md); this file keeps what the research on invocations found (issue #16, branch `research/pi-durable-invocations`) and the measurement that followed (#18).

## One run, one detached wait

- `PiHarness` keeps a single Lifecycle job (`pi-wake`). `submit()` only writes SQLite and schedules that job; the RPC call runs no model work.
- The alarm runs `_wakeStep`: if pi has work, it calls `pi.resume()`, starts `_waitWhileActive(pi)` as a **detached promise**, registers it with `lifecycle.trackAlarmWork`, and returns at once with a 30 s heartbeat.
- **All turns and tool calls of a run execute inside that one wait**, in memory, not one alarm per turn. The wait ends when pi is idle or after the 10-minute budget, and then the job is pushed again.
- pi-durable's own terms: "a turn is one model response and its tool calls; a run is the turns from an input to its final answer".

## When a new invocation starts

| Trigger | New alarm invocation? |
|---|---|
| Next turn, or a tool call, in the same run | No, same wait |
| Follow-up submitted while a run is active (default `whenBusy: followUp`) | The RPC is its own invocation; the work joins the running wait |
| `submit()` while pi is idle | Yes, the work runs in the next alarm invocation |
| 30 s heartbeat | Yes, but it does nothing while a wait runs |
| 10-minute wait budget used up | Yes, a new wait |
| Crash, eviction, `ctx.abort()` | Yes, the deadman alarm or heartbeat restarts the object; pi resumes |

## Subrequests across a wait

Measured (`spike/WAIT.md`): 51, 62 and 106 AI calls inside one run raised no "Too many subrequests", but a run of 340 pings hit it from ping 85 and lost 65 of them. So the limit **does apply** to detached work, at a threshold and reset point Cloudflare does not document. Design rule: count subrequests in code and keep a fallback of one run per chunk of work, each submitted after the previous one settles (a fresh `submit()` on an idle pi starts a fresh invocation). See [cloudflare-free-plan.md](cloudflare-free-plan.md).

## A Lifecycle job and a pi run on one alarm, deployed (2026-11-11, issue #22)

Free plan, Worker `signal-shared-alarm` (since deleted), code in `spike/shared-alarm/`. One Durable Object ran our Lifecycle job (`maxAttempts: 1`, one chunk per dispatch, `rescheduleAt`) and PiHarness together. Took 225 s; no "Too many subrequests" in any step.

| Step | What ran | Result |
|---|---|---|
| 1 | Three dispatches, 40 `fetch` each, rescheduled +1 s | 40, 40, 40 calls, no error: each dispatch gets a fresh count |
| 2 | Real GLM run, `read_story` twice (15 fetches and a 35 s hold each); job polled every 30 s with 0 calls | Run `done`; 30 tool fetches, no error; polls coexisted with the run |
| 3 | `session.reset()`, a second run like step 2 | `done`; 30 more fetches. 180 calls in total across invocations, past 50 |
| 4 | FTS5 table, insert, `MATCH '"inversion"*'` on `Inversión en Meta` | Found: **FTS5 and prefix search with diacritics work on a deployed Durable Object** |

Run shape holds: chunks of at most 40 calls, each in its own dispatch, and pi runs submitted after the previous settles. Not measured: a single chunk above 40 calls, and the GLM calls themselves (not counted in the table, only our `fetch` calls were logged).

## Durability rules that follow

- Only `replay: "safe"` tools re-run after a crash. An interrupted effectful tool is not re-run: the model gets "was interrupted and may have partially run", and in the spike it did not retry. **Make effectful tools idempotent in code** (a ledger in our own tables, keyed upserts) and then mark them safe.
- `submit()` is idempotent by `operationId` through `PiHarness` (`requestId` is the name one layer down, on pi-durable's `Harness`).
- pi warns that direct storage calls "may be rolled back by a Pi transaction". Our writes inside tools are keyed upserts, so a re-run is harmless.
