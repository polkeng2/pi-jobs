# Job Scout: v1 design

Outcome of the design grilling session (2026-10-28/29). Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). Runtime choice: [ADR 0001](adr/0001-pi-durable-on-piharness.md).

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

   Its only real decision is *what to search next* when a batch yields too few good offers.
4. **Sources:** freehire.me (public JSON API, already used by ai-job-search) and Himalayas (`himalayas.app/jobs/api/search`, free key: 60 requests/min, 10k/day; must use `applicationLink` and show credit). LinkedIn is excluded, because its guest endpoints violate the ToS.
5. **Deterministic prefilter, before any model call:** drop duplicates (already seen), wrong work mode or location, and deal-breaker keywords.
6. **Scoring with Clef** (`@cf/cloudflare/clef`, a "System One" decision model). It takes the profile plus the offer as `state` and typed questions, and returns probabilities, not text. The rubric is ported from ai-job-search `04-job-evaluation.md`:
   - 4 `score` questions: Technical 30%, Experience 25%, Behavioral 15%, Career Alignment 30%.
   - 2 `noul` gates: location and language. A failed gate vetoes the offer.
   - The fit score (0-100) is the weighted mean, computed **in code**.
7. **The stop rule is code, not a model.** Batches are 50 offers each. Stop when there are 10 offers with fit score ≥ 70, or after 4 batches. If fewer than 10 qualify, send what there is.
   - If the free tier is exceeded, drop to 3 batches, then 2. The owner then decides whether to move to prepaid or Workers Paid ($5/month).
8. Each batch runs in its own Durable Object alarm wake. See the ADR for why.

## Telegram

- One message per offer: title, company, salary, location, work mode, fit score, link, and ✅ / ❌ buttons. ❌ offers an optional one-tap reason (salary / location / stack / seniority / company).
- Tapping ✅ edits that offer's buttons (`editMessageReplyMarkup`) to "✅ Accepted · undo". It sends no new message.
- One **shortlist message** after the offer messages, edited live (`editMessageText`) on every accept. It is a code block for one-tap copy, and it holds URL, title, company, fit score and Clef's reasons.
- **📋 Export** marks the shortlist exported and attaches a `.txt` with the full offer texts. That is the fallback for URLs that return 403, and it avoids the 4096-character message limit.
- Webhook: check the `X-Telegram-Bot-Api-Secret-Token` header. Each tap becomes an idempotent `submit()` keyed by the callback id.

## State

The Durable Object's SQLite holds Pi Durable's own `pi_*` tables, plus our tables:
- offers seen (dedup key, source, status)
- scores, including per-question probabilities
- decisions: accept / dismiss plus reason
- shortlist / exported flag
- **usage per run:** tokens and neurons per model, to find where the free tier ends

The 529 jobs in ai-job-search are **not** imported. That workspace already dedups against its own tracker.

## Profile

`profile.md` is condensed from ai-job-search `01-candidate-profile.md` and the deal-breakers in its `CLAUDE.md`. Keep it to ~800 tokens, because it goes into every Clef call. It stays **gitignored**, is uploaded to KV with a wrangler script, and is resynced by hand when the profile changes. The repo is public, so no personal data goes in git.

## Budget (free plan)

| Item | Allowance |
|---|---|
| Workers AI | 10,000 neurons/day, reset 00:00 UTC |
| Clef | ~21,818 neurons per 1M input tokens; output is free. That is ~450k input tokens/day |
| Scoring at ~3.5k tokens/call | ~130 offers/day |
| Scoring at ~800 profile + ~1.5k offer + questions | ~200 offers/day (4 × 50) |
| GLM-4.7-Flash | $0.06 / $0.40 per 1M in/out tokens. Orchestrator calls are small |
| Free plan per invocation | 50 subrequests, 10 ms CPU |

Waiting on fetch does not count toward the 10 ms CPU limit. The free-plan per-invocation limits are why there is one batch per alarm wake.

## Evals: "is the model good enough?"

- **Scorer, offline.** The labelled set is the owner's accept/dismiss decisions, seeded with the 8 tracker rows from ai-job-search. Its 34 ranked jobs were scored by the agent itself, so they are weak labels. A local Node script runs each model or rubric version over the set and reports precision@10, cost and latency. pi-ai runs in Node, so swapping a model means changing one string.
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
- gpt-oss has reports of Harmony tool-call tokens leaking. Wrap calls in validate and retry.
- Clef cannot call tools or write text.

## Spike first (risks that could break the design)

Before the real build, deploy a minimal Worker with a Durable Object, `PiHarness`, one tool and one Clef call. Verify:

1. **AJV.** Does pi's tool validation call `new Function()`, which Workers forbid? A community package (`@funtuantw/pi-agent-cf`) claims it does.
2. **Subrequests.** Do `AI` binding calls count toward the 50-subrequest free limit?
3. **Resume.** Does `PiHarness` resume mid-batch after a forced crash or redeploy?
4. **Clef from pi-ai.** Clef's request shape (state plus questions) isn't a chat completion. Docs check (2026-10-29):
   - The Cloudflare pi-ai provider (`createAI({ binding: env.AI })`) routes through the same `AI` binding. Either path bills the same account-wide Workers AI free allocation (10k neurons/day). Using pi-ai does not leave the free plan.
   - The provider documents only `complete`/`stream` (text) and `ai.images`. Clef isn't mentioned.
   - Clef is documented only via `env.AI.run("@cf/cloudflare/clef", { model, state, questions })` and the REST `/ai/run` endpoint.
   - Verify: can pi-ai send Clef's shape at all? If not, `score_offers` calls `env.AI.run` directly. That is still Cloudflare and still the free plan. Use the binding, never the REST API with a token. Also record the real shape of `answers` and `usage`.
5. **pi best practices.** Research primary sources (pi.dev, `badlogic/pi-mono`, Cloudflare's PiHarness and pi-ai docs) and write the first version of `docs/pi-best-practices.md`. Cover: tool definitions (schemas, descriptions, returning errors the model can act on), durability (`replay: "safe"`, idempotency keys, `submit()`, resume), context management across batches, version pinning and upgrades, local testing and mocking in Node, and common failures (stream retries, malformed tool calls). pi 1.0 is new (2026-10-01), so mark what is official guidance and what we learned in the spike.

## Key references

- pi: https://pi.dev · https://github.com/badlogic/pi-mono. Packages are under `@earendil-works/*`: `pi-ai`, `pi-agent-core`, `pi-durable`.
- Cloudflare pi-ai provider: https://developers.cloudflare.com/agents/models/pi-ai/
- PiHarness: https://developers.cloudflare.com/agents/harnesses/pi/
- Clef: https://developers.cloudflare.com/workers-ai/models/clef/ · Jev / System One: https://docs.typesafe.ai/introduction
- Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Himalayas API: https://himalayas.app/docs/remote-jobs-api
- Telegram Bot API: https://core.telegram.org/bots/api

## Still to write

`docs/pi-best-practices.md` will be a running guide to building with pi. Spike point 5 starts it, and it is filled in as we learn.
