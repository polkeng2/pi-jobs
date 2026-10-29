# Check 3: crash-and-resume procedure (issue #6)

How to repeat the resume check by hand. It answers: after a crash or redeploy in
the middle of a run, does Pi Durable on `PiHarness` carry on with the same
conversation, and which tool calls run again?

## What is in the Worker

- `GET /diag?check=resume-start&mode=tools&holdMs=60000` starts a run in a fresh
  session with `submit()` and returns at once. The run continues in the Lifecycle
  alarm. The prompt asks the model to call two synthetic tools in turn:
  - `check_inventory`, marked `replay: "safe"` (a read),
  - `place_order`, not marked (default `unsafe`; the effectful one).

  Each tool writes a row to our own table `spike_tool_runs` (not `pi_*`) when it
  starts, holds for `holdMs`, then marks the row finished. Every Durable Object
  instance gets a random id, so a restart shows up as a new instance in the rows.
- `mode=stream` starts a run with no tools that asks for a ~400-word story, to
  catch a model stream mid-flight. The `AI` binding is wrapped to record each
  call in `spike_model_calls`: instance, chunks streamed (saved on the first chunk and every 20th, so a cut stream is accurate to within 20), and whether it finished or errored.
- `GET /diag?check=resume-crash` calls `ctx.abort()` on the object. This resets
  it at once, with no grace period, like an uncaught crash.
- `GET /diag?check=resume-status` (optionally `&session=<id>`; default is the
  latest run) reports, without waiting: whether the operation settled, pi's
  pending list, the transcript, our tool and model-call rows, the instances seen,
  and the derived answers (`sameConversation`, `reRuns`, `stream`).

## Procedure A: redeploy (closest to a real deploy)

CF-Pi says a deploy gives in-flight work about 30 seconds, so hold the tools longer than that.

**Result on 2026-10-29: a redeploy did not interrupt the run.** Twice (once
polling every 2 s, once with no requests for 120 s after the deploy) the object
that started the run kept the old code and finished every tool, each held 60 s
and then 150 s, about 5 minutes past the deploy. Only once the run was done
did a new instance (new code) answer. SQLite survived each deploy. So a redeploy
is not a reliable way to force the interruption; use procedure B.

1. `cd spike && npx wrangler deploy --name job-scout-spike-resume` (use your own
   test name; do not deploy over `job-scout-spike`).
2. Start: `curl "$URL/diag?check=resume-start&mode=tools&holdMs=60000"`.
3. Poll `curl "$URL/diag?check=resume-status"` every few seconds. When
   `evidence.toolRuns` has a `check_inventory` row with `finishedAt: null`, run
   the deploy command from step 1 again.
4. Keep polling. When a `place_order` row has `finishedAt: null`, deploy again.
5. Poll until `evidence.settled` is `true`. Read `verdict`, `instances`,
   `sameConversation`, `reRuns` and `stream`.

## Procedure B: forced crash (`ctx.abort()`)

Same as A, with `holdMs=25000`, and `curl "$URL/diag?check=resume-crash"`
instead of each redeploy. For the stream case: start with `mode=stream`, crash
as soon as `evidence.modelCalls` shows a row with `chunks > 0` and
`finishedAt: null`, then poll until settled.

Procedure B is automated: `SPIKE_URL=$URL npx vitest run -t resume`
(about 1 minute, about 40 neurons). The alarm brought the object back within
about half a second of each crash.

Results on 2026-10-29 (pi-durable 1.4.0, agents 0.31.0):

- Same conversation: yes. One conversation id; the prompt and the tool calls
  made before the crash are in the transcript that finished the run.
- `check_inventory` (safe): pi ran the same call id again on the new instance.
- `place_order` (unsafe): not run again. The model got an error result, "Tool
  place_order was interrupted and may have partially run", did not retry, and
  replied DONE. The order's outcome is unknown to the run; v1 must check its own
  table, not trust the transcript.
- Stream: cut after 65 chunks. The partial assistant message stays in the
  transcript with `stopReason: "aborted"` and zero usage, and the call starts
  over from scratch (retried, not resumed). Both attempts are billed.

## How to read the report

- `instances`: more than one means the object restarted during the run.
- `sameConversation`: the original prompt and the tool calls made before the
  interruption are still in the one conversation that finished the run.
- `reRuns.<tool>.reExecutedSameCall`: pi ran the same tool call again (same call
  id). `modelCalledAgain`: the model issued a new call to the tool.
  `results[].isError` and `text` show what the model was told.
- `stream.cutOff` / `retried` / `possibleDoubleBilling`: a cut stream that had
  already produced chunks was generated, and billed, and then generated again.
  The cut attempt's tokens are not reported anywhere (its message has zero usage),
  so the neuron total in the report undercounts by that much.
