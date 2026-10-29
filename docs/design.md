# Job Scout: v1 design

Outcome of the design grilling session (2026-10-28/29). Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). Runtime choice: [ADR 0001](adr/0001-pi-durable-on-piharness.md). The spike (2026-10-29) checked the risky parts; see [Spike outcome](#spike-outcome-2026-10-29). Where it changed the design, the body below already says so.

## Goal

Learn how an agent harness works (tools, context, the loop, durability) by building a small one on pi. The second goal is something useful for the owner's job search. Prefer learning over speed, but ship a working digest early, and make each decision visible.

## Scope

**In v1:** a daily scouting run, the Telegram digest, accept/dismiss, the shortlist export, state and usage logging, and evals.

**Out of v1:**
- Tailored CV generation (it may come back later).
- An application tracker. The owner covers this themselves.
- InfoJobs and any other source.

The shortlist goes to the owner's existing Claude workspace (`C:\Users\polke\repos\ai-job-search`, `/apply <url or text>`). That workspace re-evaluates each offer and writes the CV.

## Scouting run

1. A Cron Trigger fires daily and the digest arrives around 08:00 Europe/Madrid. Cron is in UTC, so watch DST.
2. The cron wakes the single Durable Object. It runs Pi Durable through `PiHarness`.
3. The **orchestrator** (`@cf/zai-org/glm-4.7-flash`) has three tools:
   - `search_offers(source, query, page)`
   - `score_offers(ids)`
   - `send_digest(ids)`

   Its only real decision is *what to search next* when a batch yields too few good offers. `@cf/zai-org/glm-4.7-flash` is served and called tools correctly through pi-ai in the spike.
4. **Sources:** freehire.me (public JSON API, already used by ai-job-search) and Himalayas (`himalayas.app/jobs/api/search`, free key: 60 requests/min, 10k/day; must use `applicationLink` and show credit). LinkedIn is excluded, because its guest endpoints violate the ToS.
5. **Deterministic prefilter, before any model call:** drop duplicates (already seen), wrong work mode or location, and deal-breaker keywords.
6. **Scoring with Clef** (`@cf/cloudflare/clef`, a "System One" decision model). It takes the profile plus the offer as `state` and typed questions, and returns probabilities, not text. The rubric is ported from ai-job-search `04-job-evaluation.md`:
   - 4 `score` questions: Technical 30%, Experience 25%, Behavioral 15%, Career Alignment 30%.
   - 2 `noul` gates: location and language. A failed gate vetoes the offer.
   - The fit score (0-100) is the weighted mean, computed **in code**.
   - **`score_offers` calls Clef through the binding, not pi-ai:** `env.AI.run("@cf/cloudflare/clef", { model: "clef", state, questions })`, one call per offer. `model: "clef"` in the body is required. pi-ai sends a chat payload, which Clef refuses.
   - Answer shapes: a `score` answer is `{ type, score, legend, probabilities, confidence }`, where `score` is the probability-weighted level index (0 = lowest criterion, n-1 = highest). Scale it to 0-100 as `score / (n-1) × 100`. A `noul` answer is `{ type, noul }`, the probability of yes. The gate threshold is a constant in code.
   - `usage` holds only `input_tokens` (`output_tokens` is 0). There is no neuron field, so the usage log computes neurons from tokens × the pricing-page rate.
7. **The stop rule is code, not a model.** A batch scores at most **40** offers, because Clef calls count toward the 50 subrequests per invocation (see Budget). The prefilter runs first, so a batch may fetch more offers than it scores. Stop when there are 10 offers with fit score ≥ 70, or after **3 batches**. If fewer than 10 qualify, send what there is.
   - A 4th batch comes back only if the measured per-question Clef cost allows it (see Budget). If the free tier is exceeded, drop to 2 batches. Moving to prepaid or Workers Paid ($5/month) stays the owner's call.
8. Each batch runs in its own Durable Object alarm wake. See the ADR for why. In the spike the model work ran in pi's Lifecycle alarm invocation, but how pi spreads one run's turns across invocations was not measured. So `score_offers` counts its own subrequests and stops at the cap instead of trusting the wake boundary.

## Telegram

- One message per offer: title, company, salary, location, work mode, fit score, link, and ✅ / ❌ buttons. ❌ offers an optional one-tap reason (salary / location / stack / seniority / company).
- Tapping ✅ edits that offer's buttons (`editMessageReplyMarkup`) to "✅ Accepted · undo". It sends no new message.
- One **shortlist message** after the offer messages, edited live (`editMessageText`) on every accept. It is a code block for one-tap copy, and it holds URL, title, company, fit score and Clef's reasons.
- **📋 Export** marks the shortlist exported and attaches a `.txt` with the full offer texts. That is the fallback for URLs that return 403, and it avoids the 4096-character message limit.
- Webhook: check the `X-Telegram-Bot-Api-Secret-Token` header. Each tap becomes an idempotent `submit()` with `operationId` set to the callback id. Resubmitting the same id returns the existing operation with `accepted: false`.
- **`send_digest` is idempotent in code.** In the spike an interrupted effectful tool was not re-run, and the model was told only that it "was interrupted and may have partially run". GLM did not retry, so a crash mid-digest would leave the digest half-sent for good. So `send_digest` records each sent message in the digest table (scouting run, offer, Telegram `message_id`) and skips offers already recorded. A re-run is then harmless, so the tool is marked `replay: "safe"`. A crash between Telegram's reply and our write can still duplicate one message; that is accepted. Button edits use the same table to find their message.

## State

The Durable Object's SQLite holds Pi Durable's own `pi_*` tables, plus our tables:
- offers seen (dedup key, source, status)
- scores, including per-question probabilities
- decisions: accept / dismiss plus reason
- shortlist / exported flag
- digest messages: scouting run, offer, Telegram `message_id` (the `send_digest` ledger)
- **usage per run:** tokens and neurons per model, to find where the free tier ends. Neurons are computed in code from tokens. A stream cut by a crash is billed but reports zero usage, so the log undercounts retries.

pi warns that direct storage calls "may be rolled back by a Pi transaction". Our writes happen inside tools, so each one is a keyed upsert. That also makes a re-run safe tool harmless.

The 529 jobs in ai-job-search are **not** imported. That workspace already dedups against its own tracker.

## Profile

`profile.md` is condensed from ai-job-search `01-candidate-profile.md` and the deal-breakers in its `CLAUDE.md`. Keep it to ~800 tokens, because it goes into every Clef call. It stays **gitignored**, is uploaded to KV with a wrangler script, and is resynced by hand when the profile changes. The repo is public, so no personal data goes in git.

## Budget (free plan)

Checked against the spike's measurements (2026-10-29). Workers AI returns no neuron count, so neurons are computed from reported tokens × the published neurons-per-M rates.

| Item | Allowance or cost |
|---|---|
| Workers AI | 10,000 neurons/day, reset 00:00 UTC |
| Clef | 21,818 neurons per 1M input tokens; output is free. **Measured:** 1 `score` + 1 `noul` question on ~60 tokens of synthetic state = 325 input tokens = 7.1 neurons. Questions and template add ~265 tokens even for a tiny state |
| Clef per offer (estimate) | ~800 profile + ~1.5k offer + 6 questions ≈ 3.1k tokens ≈ **68 neurons**, if the state counts once per call. If it counts once per question, ≈ 14k tokens ≈ 300 neurons. **Not measured yet; the first v1 measurement** |
| GLM-4.7-Flash | 5,500 / 36,400 neurons per 1M in/out tokens ($0.06 / $0.40). **Reasoning is billed as output** and not reported separately: "reply pong" was 15 in / 143 out = 5.3 neurons; a tool turn (2 calls, ~670 tokens in) ≈ 9 neurons. Estimate ~10-20 neurons per orchestrator call and ~15 calls per scouting run ≈ 300 neurons |
| Scouting run (estimate) | 3 batches × 40 scored offers × 68 + ~300 orchestrator ≈ **8,500 neurons**. 4 batches × 40 would be ~11,200, over the allowance |
| Retries | An interrupted `@cf/` stream is generated again from scratch and both attempts are billed; the cut attempt reports zero usage. Keep ~10% headroom |
| Free plan per invocation | 50 subrequests, **`AI` binding calls included**. Exactly 50 usable; pi's harness adds none of its own. 10 ms CPU (see below) |
| Batch subrequests | ≤ 40 Clef calls + 1-3 source fetches + the orchestrator calls in the same invocation + a retry or two ≤ 50. Hence 40, not 50 |
| Digest wake | ~11 Telegram calls (10 offers + shortlist) + 1-2 orchestrator calls |
| Bundle | 504 KB gzip of the 3 MB free limit (pi-ai pulls in the OpenAI, Anthropic and Google SDKs); startup 25 ms |

**CPU.** Every Durable Object invocation in the spike went over the 10 ms figure: 13-51 ms per RPC call, 21-74 ms per alarm with model work. None was killed. Waiting on fetch does not count, so this is pi's own work (JSON, SQLite, validation). The design cannot get under 10 ms, and it does not count on a looser limit either: the usage log records CPU per wake (from `wrangler tail`) so a change in enforcement shows up. See the open decisions.

The free-plan per-invocation limits are why there is one batch per alarm wake.

## Evals: "is the model good enough?"

- **Scorer, offline.** The labelled set is the owner's accept/dismiss decisions, seeded with the 8 tracker rows from ai-job-search. Its 34 ranked jobs were scored by the agent itself, so they are weak labels. A local Node script runs each model or rubric version over the set and reports precision@10, cost and latency. pi-ai runs in Node, so swapping an orchestrator model means changing one string. Clef is not reachable through pi-ai, so `score_offers` takes its Clef client as a parameter: the binding in the Worker, a fake or recorded answers in Node.
- **Scorer, online.** Weekly accept rate of the digest.
- **Orchestrator.** Do its rewritten queries for batch 2+ yield more offers above threshold than repeating the first query? Comparison candidates: gpt-oss-20b, qwen3-30b-a3b.
- **No LLM-as-judge:** the owner's taps are the judge. There are no public benchmarks for Clef or Jev, so these taps are its first benchmark.

## Model notes (researched 2026-10-28)

| Model | tau2-bench | Tool calling | $/1M in / out |
|---|---|---|---|
| glm-4.7-flash | 79.5 (vendor-reported) | yes, confirmed on Workers AI | 0.06 / 0.40 |
| qwen3-30b-a3b | 49.0 | | 0.051 / 0.335 |
| gpt-oss-20b | 47.7 | | 0.20 / 0.30 |
| clef | n/a | no | 0.24 / free |

- GLM may need "preserved thinking" for multi-turn runs.
- GLM reasons before every answer, even a trivial one, and those tokens are billed as output (spike: 143 output tokens to say "pong"). pi-ai's `usage.reasoning` stays undefined for it.
- gpt-oss has reports of Harmony tool-call tokens leaking. Wrap calls in validate and retry.
- Clef cannot call tools or write text.

## Spike first (risks that could break the design)

Before the real build, a minimal Worker with a Durable Object, `PiHarness`, one tool and one Clef call checked:

1. **AJV.** Does pi's tool validation call `new Function()`, which Workers forbid? A community package (`@funtuantw/pi-agent-cf`) claimed it does.
2. **Subrequests.** Do `AI` binding calls count toward the 50-subrequest free limit?
3. **Resume.** Does `PiHarness` resume mid-batch after a forced crash or redeploy?
4. **Clef from pi-ai.** Clef's request (state plus questions) isn't a chat completion. Can pi-ai send it, or must `score_offers` call `env.AI.run` directly? Binding only, never the REST API with a token.
5. **pi best practices.** First version of [pi-best-practices.md](pi-best-practices.md) from primary sources, with each practice marked official or learned in the spike.

## Spike outcome (2026-10-29)

Code and procedures: `spike/` on the `spike` branch (`spike/src/index.ts`, `spike/RESUME.md`) and issues #2-#7. Each check ran on a deployed free-plan Worker through `GET /diag?check=<name>`, which returns the verdict, the raw evidence and the pinned versions. **No result contradicts [ADR 0001](adr/0001-pi-durable-on-piharness.md).**

| Check | Verdict | Evidence | Design consequence |
|---|---|---|---|
| 1. AJV | **Pass.** pi 1.4.0 has no AJV. It validates with typebox, which on workerd cannot use `new Function` and falls back to interpreted validation. The agent called the tool with validated, coerced arguments (`"3"` became 3; `{a:"x"}` was refused with "a: must be integer") | `check=tool`, `check=tool-interpreted` on `job-scout-spike-ajv`; #3 | Tools work, no workaround package needed. Pass the tool `registry` to `Harness.open`, or the model sees no tools |
| 2. Subrequests | **They count.** `AI` binding calls and fetches share the 50 per invocation: call 51 throws "Too many subrequests by single Worker invocation", whatever the mix. pi adds none. CPU 13-74 ms per invocation, never killed | `check=subrequests&ai=N&fetches=M` on `job-scout-spike-subreq`, plus `wrangler tail`; #5 | A batch scores at most 40 offers, and `score_offers` counts its own calls. 3 batches by default. CPU is logged per wake. The limit was measured per RPC invocation; the alarm invocation is assumed to have the same one |
| 3. Resume | **Pass** with a forced crash (`ctx.abort()`): the alarm restarted the object in ~0.4 s and the run went on in the same conversation. The `replay: "safe"` tool re-ran with the same call id. The effectful tool did not re-run: the model got an "interrupted and may have partially run" error, did not retry, and ended the run. An interrupted stream was retried from scratch; both attempts were billed and the cut one recorded zero usage. **A redeploy did not interrupt** a busy object: it kept the old code and finished minutes later, unlike CF-Pi's "30 seconds" | `check=resume-start`, `resume-crash`, `resume-status` on `job-scout-spike-resume`; `spike/RESUME.md`; #6 | ADR 0001 holds. `send_digest` gets a ledger and becomes safe to re-run (see Telegram). Our table writes are keyed upserts. The budget keeps retry headroom. A deploy during a scouting run is harmless: the run finishes on the old code |
| 4. Clef | **pi-ai cannot call it**: it sends a chat payload, which Clef refuses. `env.AI.run("@cf/cloudflare/clef", { model: "clef", state, questions })` works: ~7 neurons for 2 questions on a tiny state. `usage` has only `input_tokens` | `check=clef` on `job-scout-spike-clef`; #4 | `score_offers` calls the binding directly (see step 6). The fit score maps Clef's level index in code. The per-question cost is still unmeasured |
| 5. Best practices | **Done.** Guide v1 with official, spike and silent tags. Through `PiHarness` the submit key is `operationId`. The pi repo moved to `github.com/earendil-works/pi` | [pi-best-practices.md](pi-best-practices.md); #7 | `operationId` = Telegram callback id. Links below updated |

**Pinned versions for v1** (exact, from `spike/package.json`): `@earendil-works/pi-ai` 1.4.0, `@earendil-works/pi-durable` 1.4.0, `@earendil-works/chord` 1.4.0, `agents` 0.31.0, `typebox` 1.3.27 (a direct dependency, so `typebox/system` can be imported). `@earendil-works/pi-agent-core` 1.4.0 if used directly. Tooling: `wrangler` 4.155.0, `typescript` 5.9.3, `vitest` 3.2.4. Install with `npm ci --ignore-scripts`.

**Open decisions for the owner:**
- **How many batches.** The estimate allows 3 batches of 40 on the free plan. A 4th needs one of: fewer or shorter Clef questions, a shorter offer text in `state`, prepaid Workers AI, or Workers Paid. Measure Clef's per-question cost first (one call with 1 and one with 6 questions on a full-size state). If the state is counted per question, not even 3 batches fit, and the rubric has to shrink.
- **CPU.** Invocations use 13-74 ms against the free plan's 10 ms and are not killed today. Options: stay on the free plan and watch the logged CPU, or move to Workers Paid if enforcement tightens.
- **Batch size 40** leaves ~10 subrequests for source fetches, orchestrator calls and retries. Alternatives: score one batch over two wakes (50 again, more moving parts), or a smaller batch.

## Key references

- pi: https://pi.dev · https://github.com/earendil-works/pi (formerly `badlogic/pi-mono`). Packages are under `@earendil-works/*`: `pi-ai`, `pi-agent-core`, `pi-durable`, `chord`.
- Cloudflare pi-ai provider: https://developers.cloudflare.com/agents/models/pi-ai/
- PiHarness: https://developers.cloudflare.com/agents/harnesses/pi/
- Clef: https://developers.cloudflare.com/workers-ai/models/clef/ · Jev / System One: https://docs.typesafe.ai/introduction
- Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Himalayas API: https://himalayas.app/docs/remote-jobs-api
- Telegram Bot API: https://core.telegram.org/bots/api

## Still to write

Nothing for the design. Next is the v1 spec. [pi-best-practices.md](pi-best-practices.md) is a running guide, filled in as v1 teaches more.
