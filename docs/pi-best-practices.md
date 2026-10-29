# pi best practices

A running guide to building Job Scout on pi. Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). Runtime: [ADR 0001](adr/0001-pi-durable-on-piharness.md). Scope: [design.md](design.md).

**Status: first version, 2026-10-29, plus the spike's learnings (last section).** The numbered sections are written from primary sources. pi 1.0 shipped on 2026-10-01, so the guidance is young and some of it will change. Pi Durable is experimental: its README says the API "changes without notice between releases". Re-check every practice against the pinned version before relying on it.

Versions this was checked against: `@earendil-works/pi-ai`, `pi-agent-core`, `pi-durable` and `chord` 1.4.0 (npm `latest` on 2026-10-29, published 2026-10-21). Cloudflare `agents` 0.31.0, which supports Pi 1.4 (needs 0.30.0+).

## How to read this

Every practice carries a tag and a source.

- **[Official]** means the project's own docs, README or published package say it. The source is linked.
- **[Spike]** means learned by running it in the spike on a deployed free-plan Worker. These are collected in the last section, which says what each one confirms or contradicts.
- **[Silent]** means the sources say nothing, and the entry says so plainly instead of guessing.

Sources:

| Short name | URL |
|---|---|
| CF-Pi | https://developers.cloudflare.com/agents/harnesses/pi/ |
| CF-PiAI | https://developers.cloudflare.com/agents/models/pi-ai/ |
| Durable | https://github.com/earendil-works/pi/blob/main/packages/durable/README.md (also `@earendil-works/pi-durable` on npm; changelog ships in the package) |
| Core | https://github.com/earendil-works/pi/blob/main/packages/agent/README.md |
| AI | https://github.com/earendil-works/pi/blob/main/packages/ai/README.md |
| pi.dev | https://pi.dev |
| Repo | https://github.com/earendil-works/pi (the `badlogic/pi-mono` link in the design now points here) |

## 1. Tool definitions

Job Scout's orchestrator has three tools: `search_offers`, `score_offers`, `send_digest`.

1. **Define parameters with a TypeBox schema.** Pi Durable's `defineTool` takes `name`, `description`, `parameters: Type.Object(...)` and `execute`. Optional fields: `structuredOutputSchema`, `replay`, `callers`, `deferred`. **[Official]** Durable README.
2. **Describe the tool and each parameter.** `description` is what tells the model what the tool does, and parameters take `{ description }`. **[Official]** Core README (`read_file` example).
3. **Keep a small set of dedicated tools.** pi's stance is a small core, and it ships no sub-agents, plan mode or built-in to-dos. **[Official]** pi.dev. (This matches the project goal.)
4. **Return errors the model can act on by throwing, not by returning text.** The Core README says "Do not return error messages as content". A thrown error is caught and reported to the model as a tool error with `isError: true`. Write the message so the model can fix its next call (which argument, what was wrong, what is valid). **[Official]** Core README.
5. **Invalid arguments are reported as an error result, not a crash.** `validateToolCall(tools, toolCall)` throws on bad arguments, and the AI README recommends returning that text as a tool result with `isError: true` so the model can retry. `toolcall_end` gives a call that is "not schema-validated" yet. **[Official]** AI README.
6. **Use the three result channels on purpose.** Pi Durable tools return `output` (for the model), `structuredOutput` (for programs) and `details` (for UIs). Only `output` and `details` enter the transcript. Put what the model needs in `output`; keep bulk data out. **[Official]** Durable README.
7. **End the run from a tool only when every result asks for it.** `control: { terminate: true }` ends the run when every result in the round sets it. `false` does not end it (typed `boolean` since 1.4.0). **[Official]** Durable README and changelog.
8. **Coercion is on.** The validator coerces primitive types (for example a string `"3"` to a number) before checking. Do not rely on strict typing of model output. **[Official]** pi-ai 1.4.0 published source, `dist/utils/validation.js`. The README does not describe it.

**Not stated by the sources:**
- **[Silent]** How long a tool description should be, or how many tools a model of GLM-4.7-Flash's size handles well. No sizing guidance exists.
- **[Silent]** The Core README does not document the validator or the invalid-argument error format. See "AJV question" below.

### AJV question (spike check 1)

The design worries that validation calls `new Function()`. What the published packages show:

- pi-ai 1.4.0 and pi-durable 1.4.0 depend on `typebox@1.3.27`. Neither depends on AJV. **[Official]** npm package manifests.
- pi-ai validates with `Compile` from `typebox/compile`. In typebox, `Compile` builds an evaluated (code-generated) check only when `Environment.CanEvaluate()` is true. That function tries `new Function` once and also honours `Settings.useAcceleration`. If evaluation is refused it falls back to a dynamic (interpreted) check. **[Official]** published `typebox@1.3.27` source, `build/schema/build.mjs` and `build/system/environment/evaluate.mjs`.
- So the likely answer is that tools work in Workers, with or without `new Function`. The claim about AJV probably concerns older pi versions or another package. If it fails, `Settings.Set({ useAcceleration: false })` in typebox is the first thing to try.
- **Answered by the spike: tools work.** On workerd `new Function` is refused, so validation always takes the interpreted path. See S1 below.

## 2. Durability

1. **Tools do not re-run after a crash unless marked `replay: "safe"`.** After a crash or redeploy, only `replay: "safe"` tools run again. Any other interrupted tool does not re-run, and the model gets an `interrupted` error result carrying the output committed so far. The default is not safe. Mark safe only when repeating is harmless. **[Official]** CF-Pi, Durable.
   - For Job Scout: `search_offers` and `score_offers` are candidates for `replay: "safe"`, as long as scoring writes are idempotent. `send_digest` must not be safe.
2. **A safe tool with outside effects still needs its own idempotency.** The README says so for nested calls and gives no general mechanism for tools. For Telegram, key sends and edits yourself, for example by offer id and run id, stored in our own tables. **[Official]** Durable README. The mechanism itself is **[Silent]**.
3. **Intent is committed before `execute()` runs.** Each call is its own durable task. Plan on "at least once" for safe tools and "at most once" for the rest. **[Official]** Durable README.
4. **Make every input idempotent with an id that survives retries.** In the Durable README the key is `requestId` on `submit()`; resubmitting the same `requestId` returns the existing submission. In CF-Pi the key is called `operationId` and resubmitting returns the existing operation with `accepted: false`. For Telegram taps, use the callback id. **[Official]** CF-Pi, Durable.
   - **Resolved: both names are right, at different layers.** `requestId` is the field on pi-durable's own `Harness` (`root.submit(...)`, `submissionByRequest` in its `types.d.ts`). `PiHarness` in `agents` 0.31.0 wraps it and exposes `operationId`: `session.submit(input, { operationId })` returns a `PiReceipt { operationId, session, accepted }`. Job Scout talks to `PiHarness`, so it uses `operationId`. **[Spike]** pinned `.d.ts` files, `check=resume-start`.
5. **Use `submit()` then `wait()` for long work, `prompt()` only for short.** `submit()` stores the input durably and returns a receipt; `wait(operationId)` returns `done` or `unanswered`. **[Official]** CF-Pi.
6. **Input sent while the session is busy queues by default.** `whenBusy: "steer"` or `session.steer()` joins the current run after its current tool round. **[Official]** CF-Pi.
7. **Record non-user input with `entry`.** Use your own `kind` (start it with `app.`; `pi.` is reserved). It is a label, not a permission check. **[Official]** CF-Pi.
8. **Resume is automatic on Cloudflare.** The harness keeps a Lifecycle alarm. On eviction, crash, deploy or resource-limit overrun, the alarm restarts the Durable Object and Pi resumes from its last checkpoint. Deploys give in-flight work 30 seconds first. **[Official]** CF-Pi.
9. **A streaming model call is repeated, not resumed.** The partial answer already stored is kept, and the call is retried. Through `@cf/` models this can bill twice, because `@cf/` streams have no run id and cannot resume. **[Official]** CF-Pi, CF-PiAI.
10. **Crash loops park a task.** A task cut off `settings.restartLimit` times in a row (default 5) is parked, reported through `onReport` as `task_parked`. Resume it with `session.retry()` or give up with `session.abort()`. A tool call cut off that often ends with a `restart_limit` error result. Surface parked tasks to the owner. **[Official]** CF-Pi, Durable.
11. **Failed runs are a setting.** `settings.afterFailedRun` is `keep` (default), `continue` or `withdraw`. Pick one on purpose: `keep` holds queued input until the next `submit()` or `reset()`. **[Official]** CF-Pi.
12. **Phases rerun from their top after a restart.** Work after a wait goes in the next phase; there is no sleep inside a phase (`TaskRuntime.sleep()` was removed in 1.4.0). **[Official]** Durable README and changelog.
13. **Expect to lose up to about a second.** Partial answers and tool output are committed every 100 ms and stored at the latest after `persistWithinMs` (default 1000). **[Official]** Durable README.
14. **Our tables share the SQLite database.** Pi's data lives in `pi_*` tables. Direct storage calls bypass the operation queue and "may be rolled back by a Pi transaction". Write our own tables with care about where in a tool they run. **[Official]** CF-Pi, Durable README. How to do this safely in practice is **[Silent]**.
15. **Alarm limits.** An alarm invocation runs up to 15 minutes; the harness hands off every 10 minutes; a single model call streaming past 15 minutes can be cut off. While work exists, a heartbeat alarm fires every 30 seconds, and completion can be noticed up to 30 seconds late. **[Official]** CF-Pi.
16. **Known gaps that touch us.** No approval step for tool calls. Event streams cannot resume from a cursor. Conversations cannot be deleted. `abort()` waits for idle, so a tool that ignores its abort signal blocks it. **[Official]** CF-Pi.

**Not stated by the sources:**
- **[Silent]** How `waitUntil`-style or subrequest accounting behaves per alarm wake. The free-plan 50-subrequest and 10 ms CPU limits are not discussed in the pi docs. That is spike check 2.
- **[Silent]** Whether the Pi harness stays within the free plan's CPU limit during a batch. Spike check 3.

## 3. Context management across batches

A scouting run is several batches. The conversation must not grow without bound.

1. **Automatic compaction exists and is configurable.** `settings.compaction` takes `enabled`, `reserveTokens` (16384), `keepRecentTokens` (20000), `backgroundTokens` (32768, `0` disables background compaction) and per-model `modelOverrides`. Compaction appends a `pi.compaction` summary entry; older entries stay in storage. Values shown are the README's example, not verified defaults. **[Official]** Durable README.
2. **Compaction recovers from overflow.** On a context-overflow rejection, generation compacts and retries once. A failed compaction at the blocking threshold fails the run with `model_error`. **[Official]** Durable README.
3. **Set the context window for `@cf/` models.** Unlisted `@cf/` ids default to 128,000 context, 8,192 output tokens and zero cost. Override with `contextWindow`, `maxTokens` and `cost` in the model metadata, or compaction thresholds and cost tracking will be wrong. **[Official]** CF-PiAI.
4. **Compact manually when you know the point.** `root.compact("Keep the failing test names")` takes a focus instruction. **[Official]** Durable README.
5. **Start a new context with `reset(summary)`.** A handoff note starts fresh; older entries stay stored. This is the official route for a clean batch boundary. **[Official]** CF-Pi, Durable README.
6. **Shape what the model sees at the agent-core level.** `transformContext` (prune, compact, add external context), `prepareRequest` (rebuild context before every request) and `finishTurn` (`continue`, `end`) are the hooks. **[Official]** Core README. They apply to the `Agent` in pi-agent-core; how they appear through `PiHarness` is **[Silent]**.
7. **Keep tool output small.** Only `output` and `details` enter the transcript; put structured bulk in `structuredOutput`. **[Official]** Durable README. (This follows from the channels above. It is our application of that rule.)

**Not stated by the sources:**
- **[Silent]** No guidance on how often to `reset()` in a multi-batch job, or how much a summary loses. For Job Scout, the stop rule, dedup and scores live in code and our tables, so the model needs little history. Deciding between `reset()` per batch and compaction is a spike or v1 choice.
- **[Silent]** GLM "preserved thinking" for multi-turn runs (mentioned in design.md) is not covered by the pi sources read here.

## 4. Version pinning and upgrades

1. **Pin exactly.** The README warns that the API changes without notice between releases. The pi repo itself uses exact-pinned direct dependencies and `save-exact=true`. **[Official]** Durable README, Repo README.
2. **Match the Cloudflare pairing.** `agents` declares Pi packages as optional peer dependencies at `~1.4.0`, and "each `agents` release supports one Pi minor version". `agents` 0.30.0+ supports Pi 1.4. Upgrade `agents` and the Pi packages together. **[Official]** CF-Pi, CF-PiAI.
3. **Keep the `@earendil-works/*` packages on the same version.** pi-durable 1.4.0 depends on `pi-ai` and `chord` at exactly 1.4.0 and on `typebox` at exactly 1.3.27. **[Official]** npm manifests.
4. **Read the changelog before every upgrade.** The pi-durable 1.4.0 changelog lists breaking changes that a build would hit: `TaskRuntime.sleep()` removed, `checkpointWhen` required on `defineDoc`, `ToolExecutionApi.now()` added. **[Official]** `CHANGELOG.md` in the `@earendil-works/pi-durable` package.
5. **Storage migrations are one-way.** Opening SQLite storage on 1.4.0 migrates it to schema version 2, and "a deployment cannot roll back past this release". Before an upgrade, plan a rollback that does not depend on reopening old data. **[Official]** pi-durable 1.4.0 changelog.
6. **Do not change the storage `prefix`.** It "does not migrate existing data". **[Official]** Durable README.
7. **Use the same release-age guard.** The pi repo uses `min-release-age=2` and disables install scripts by default. **[Official]** Repo README. Adopting it is our choice.
8. **Node 22.19 or newer** for pi tooling in Node. Pi-ai also has a `legacy-node20` dist-tag (0.74.2). **[Official]** Repo README, npm.

**Not stated by the sources:** **[Silent]** a published stability or deprecation policy for 1.x minors, and a support window.

## 5. Local testing and mocking in Node

The design's evals run offline in Node, and pi-ai runs in Node.

1. **Script model replies with the faux provider.** `fauxProvider()` is an in-memory provider with scripted responses. Register it with `models.setProvider(faux.provider)`; queue replies with `setResponses([...])` or `appendResponses([...])`; build them with `fauxAssistantMessage`, `fauxText`, `fauxThinking` and `fauxToolCall`. `state.callCount` and `getPendingResponseCount()` show progress. An empty queue yields the error "No more faux responses queued". **[Official]** AI README.
2. **Swap models by changing one string.** `createModels()` plus a provider registry makes a model a lookup, so an eval can run several models over one set. **[Official]** AI README, CF-PiAI.
3. **Inject the clock.** Pass `now` and `setTimer` to the Harness to run sleeps and retries on a fake clock. `onWake` lets a host handle wakeups. **[Official]** Durable README.
4. **Test storage with the conformance suite.** `registerStorageConformance` and `registerEnvConformance` come from `@earendil-works/pi-durable/testing`. They are for storage implementers; whether we need them is **[Silent]**.
5. **Tools are plain functions.** A tool's `execute` can be called directly with fake arguments. In pi-agent-core, `streamFn` is the injection point for a fake model. **[Official]** Core README. The README does not call this a testing pattern, so treat it as an inference.
6. **Context serializes with plain JSON.** `JSON.stringify` and `JSON.parse` save and restore a `Context`, which allows replaying a recorded conversation in a test. **[Official]** AI README.
7. **Repo tests skip model calls without keys.** `./test.sh` skips LLM-dependent tests when no API keys are set. **[Official]** Repo README. Our tests should do the same.
8. **Note the first-party examples.** Runnable examples live under `test/examples` in the durable package. **[Official]** Durable README.

**Not stated by the sources:**
- **[Silent]** The Durable README does not document the faux provider's API; it points to it only as an example default. The shapes above come from the pi-ai README.
- **[Silent]** There is no official way to run `PiHarness` in Node without Workers. Whether a SQLite/JSONL storage plus the Harness is enough for the evals is a spike question. Clef cannot be mocked through pi-ai, because the Cloudflare provider documents only text and images (design.md, spike point 4).

## 6. Common failures

1. **Stream cut off or idle.** The provider treats cut-off streams, and streams with no data for `streamIdleTimeoutMs`, as retryable (`isRetryableAssistantError()`), and the harness retries the turn. **[Official]** CF-PiAI.
2. **Stream errors do not throw.** After a stream starts, failures emit an `error` event and the final message carries the details (`stopReason` is `error` or `aborted`). Handle `stopReason`; do not rely on `try/catch`. Missing auth on a direct `streamSimple()` call does throw synchronously. **[Official]** AI README.
3. **Tune retries.** `retries: { maxAttempts, backoff, retryDelayMs }` on `createAI`, model or call. The Durable harness has `settings.retry` (README example `{ maxRetries: 3 }`). A request the host died during counts as a failed attempt; with no retries left the run ends with `runFailure` reason `interrupted`. **[Official]** CF-PiAI, Durable README.
4. **Fallback models only help before output.** `fallback: [...]` applies only if a stream ends in `error` before producing output. The answering message carries a `cloudflare-fallback` diagnostic. **[Official]** CF-PiAI.
5. **Read diagnostics.** Failures add a `cloudflare-error` diagnostic (`status`, `code`, `logId`); dropped options add `cloudflare-compat`. Gateway failures throw `CloudflareAIError`. Log these into the usage table. **[Official]** CF-PiAI.
6. **Run states to handle.** `model_error` (retries did not help), `no_model` (no usable model; without a default model "prompts go unanswered"), and parked tasks (see Durability). **[Official]** CF-Pi.
7. **Unsupported options are dropped silently.** On `@cf/` and gateway models some options are dropped (`reasoningEffort` and `chatTemplateKwargs` on third-party models; thinking formats other than `reasoning_effort` on `openai-completions`). Read the `cloudflare-compat` diagnostic. **[Official]** CF-PiAI.
8. **Per-model options are lost on reload.** They are stored under symbol keys, which `JSON.stringify` and `structuredClone` drop. A session stores only provider and id, so set options on `createAI`, not `ai(model, options)`. **[Official]** CF-PiAI.
9. **Cross-model handoff drops thinking.** Moving a conversation to another model drops its thinking blocks; user messages, tool calls and results carry over. Relevant if the orchestrator model is swapped mid-conversation. **[Official]** AI README.

**Malformed tool calls and leaked Harmony tokens: the sources are silent.**
- The pi-ai README, the Core README, the Durable README and both Cloudflare pages do not mention Harmony, leaked channel tokens, or any repair step. Searching the published pi-ai and pi-durable 1.4.0 packages for Harmony found nothing. The only gpt-oss mention is a custom Ollama model example with compat flags (`supportsDeveloperRole: false`, `supportsReasoningEffort: false`).
- What the sources do give is the generic path: a call that fails schema validation becomes an error tool result with `isError: true` and the model can retry (sections 1.4 and 1.5). The design's plan, "wrap calls in validate and retry" for gpt-oss, is our own and is not official guidance. Treat it as a hypothesis for the spike or v1 evals.

## 7. Workers AI and the free plan

Pi docs say little about the free plan. These are the relevant official facts.

1. **Use the `AI` binding.** `createAI({ binding: env.AI })` routes `@cf/` models through `env.AI.run()`. A token and account id are only for gateways in another account or calls from outside a Worker. **[Official]** CF-PiAI.
2. **Set up the Worker as documented.** Compatibility date, `nodejs_compat`, an `ai` binding named `AI`, and a SQLite-backed Durable Object class. Register the provider with `createModels()` then `models.setProvider(ai.provider)`. **[Official]** CF-Pi, CF-PiAI.
3. **The harness factory must be idempotent.** It runs at startup and again after a storage-error reopen. Pass `onWake` through to `Harness.open()`. **[Official]** CF-Pi.
4. **In Workers, idle-eviction timers are declined** so that a Durable Object can hibernate (fixed in pi-durable 1.4.0). **[Official]** pi-durable 1.4.0 changelog.
5. **Clef is not a chat model.** The pi-ai Cloudflare provider documents `complete`, `stream`, `ai.images` and nothing for Clef. **[Silent]** The spike showed pi-ai cannot call it; see S8.
6. **Cloudflare pi-ai docs show `@cf/zai-org/glm-5.3-flash`** in examples; design.md uses `glm-4.7-flash`. **[Official]** CF-PiAI. `@cf/zai-org/glm-4.7-flash` is served and works through `createAI({ binding })`. **[Spike]**

## Open questions the sources leave unanswered

- ~~Whether pi tool validation works in Workers.~~ Yes (S1).
- ~~Whether `AI` binding calls count toward the 50-subrequest limit, and how pi's own calls count.~~ They count; pi adds none (S5).
- ~~Which of `requestId` and `operationId` the pinned `PiHarness` API exposes.~~ `operationId` (section 2.4).
- The Harmony/gpt-oss malformed-call handling.
- How `reset()` versus compaction behaves over many batches.
- A general idempotency pattern for effectful tools. The spike showed why one is needed (S10); the pattern is our own (design.md, Telegram).
- How pi spreads one run's turns across alarm invocations, and whether the alarm invocation has the same 50-subrequest limit as an RPC call.
- Clef's cost per question: is the `state` counted once per call or once per question?

## Spike learnings

Learned on deployed free-plan Workers on 2026-10-29, with the versions pinned in `spike/package.json` (pi-* and `chord` 1.4.0, `agents` 0.31.0, `typebox` 1.3.27). The evidence is the spike code on the `spike` branch (`spike/src/index.ts`, `spike/RESUME.md`) and the `GET /diag?check=<name>` reports; issue numbers point at the write-up for each check. Not official guidance.

**Tools**

- **S1. Tool validation works in Workers, on the interpreted path.** On workerd `Environment.CanEvaluate()` is false even with `useAcceleration: true`, so typebox never builds an evaluated check; `Compile(...).IsAccelerated()` is false. Setting `useAcceleration: false` changes nothing. Coercion and rejection behave as in section 1.8 (`"3"` → 3; `{ a: "x" }` → "a: must be integer"). Confirms section 1 and the AJV reading. **[Spike]** `check=tool`, `check=tool-interpreted`; #3.
- **S2. Pass the tool registry to `Harness.open`.** Without `registry` in its options the model saw no tools at all (27 input tokens) and nothing failed loudly. **[Spike]** #3. Not in the sources.
- **S3. typebox validators are cached per schema object** (a `WeakMap`). Testing a different validator setting needs a separate schema object. To import `typebox/system`, typebox must be a direct, exactly pinned dependency (1.3.27). **[Spike]** #3.
- **S4. A tool turn costs two model calls.** One call to choose the tool, one to read its result: about 270 + 400 input tokens, ~9 neurons and ~5 s with GLM-4.7-Flash. **[Spike]** #3.

**Workers and the free plan**

- **S5. `AI` binding calls are subrequests.** They share the 50 per invocation with `fetch`; call 51 throws "Too many subrequests by single Worker invocation" whatever the mix. Lifecycle and RPC overhead add none, so exactly 50 are usable. A caught subrequest error does not appear as an exception in `wrangler tail`. Fills the gap noted in section 2. **[Spike]** `check=subrequests&ai=N&fetches=M`; #5. Only the RPC invocation was measured, not the alarm invocation.
- **S6. The 10 ms CPU figure is exceeded and not enforced (today).** Durable Object RPC invocations used 13-51 ms, alarm invocations with model work 21-74 ms; none was killed. Fills the gap noted in section 2. **[Spike]** `wrangler tail`; #2, #5.
- **S7. Setup gotchas.** Call `Lifecycle.start()` by hand inside Durable Object RPC methods, because native RPC bypasses `fetch`. `sessions.create()` returns string ids that keep counting across sessions and deploys. `Date.now()` in a Durable Object does not advance during CPU-only work, only across I/O. The bundle is 504 KB gzip (pi-ai pulls in several provider SDKs) with 25 ms startup. npm 11 skips install scripts; `npm ci --ignore-scripts` works and `wrangler deploy` still runs. **[Spike]** #2, #6.
- **S8. pi-ai cannot call Clef.** It sends a chat payload; the platform answers "required properties at '/' are 'model,state,questions'", and the message ends with `stopReason: "error"` and zero usage. Call `env.AI.run("@cf/cloudflare/clef", { model: "clef", state, questions })` directly; `model: "clef"` in the body is required. `usage` is `{ input_tokens, output_tokens: 0 }`, not `prompt_tokens`. **[Spike]** `check=clef`; #4.
- **S9. Workers AI returns no neuron count, and GLM's reasoning is billed but not split out.** Compute neurons from tokens × the pricing-page rates. GLM-4.7-Flash answered "reply pong" with 15 input and 143 output tokens (~5.3 neurons), and `usage.reasoning` is undefined. pi-ai fills `usage.cost` only if a `cost` is set in the model metadata. **[Spike]** #2. Relates to section 3.3.

**Durability**

- **S10. After a crash, pi resumes as documented, and the effectful tool's outcome is lost to the run.** Forced with `ctx.abort()`, the alarm restarted the object in ~0.4 s and the run carried on in the same conversation (`api.conversationId` equals the `PiSession` id). The `replay: "safe"` tool ran again with the same call id. The unsafe one was not re-run; the model got `isError` "Tool place_order was interrupted and may have partially run", did not call it again, and ended the run. So the run never finished the effect, and the transcript cannot say whether it happened. Reconcile from our own tables. Confirms sections 2.1 and 2.3. **[Spike]** `check=resume-start/-crash/-status`, `spike/RESUME.md`; #6.
- **S11. An interrupted stream is retried from scratch and billed twice, and the cut attempt is invisible in usage.** The partial assistant message stays in the transcript with `stopReason: "aborted"` and all-zero usage; a new binding call then streams the whole answer. Confirms section 2.9 and adds that usage undercounts. **[Spike]** `check=resume-*&mode=stream`; #6.
- **S12. A redeploy does not interrupt a busy Durable Object.** Twice, the object running a run kept the old code and finished tool holds of 60 s and 150 s about 5 minutes after the deploy; a new instance appeared only once the run had settled. SQLite survived. This contradicts section 2.8's "deploys give in-flight work 30 seconds" as observed on the free plan. To test resume, force a crash with `ctx.abort()`. **[Spike]** `spike/RESUME.md` procedure A; #6.
- **S13. The binding transport returns a raw `Response`.** `agents` calls `env.AI.run(model, input, { returnRawResponse: true })`. To observe or count a model stream, wrap the `AI` binding and the response body. **[Spike]** #6.

**Sources**

- **S14. The pi repo is `github.com/earendil-works/pi`.** `badlogic/pi-mono` is the old name; docs live under `packages/coding-agent/docs`. **[Spike]** #7.
