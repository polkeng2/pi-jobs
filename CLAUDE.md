# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Job Scout is a personal, proactive agent built on pi (pi.dev). It runs on Cloudflare (Workers, a Durable Object, Workers AI). Every morning it sends the owner a digest of high-fit job offers over Telegram. The owner talks to Claude in Spanish, while code, identifiers and docs are in English.

The goal is to learn how an agent harness works by building a minimal one, so keep the layer thin. Do not pull in pi-coding-agent or template scaffolding. Prefer a small number of dedicated tools, and put decisions in code wherever no model is needed.

## Read before working

- [docs/design.md](docs/design.md) holds the v1 design: every decision, the budget, evals, model notes and the spike checklist. It is the source of truth for scope.
- [GLOSSARY.md](GLOSSARY.md) is the domain vocabulary. Use its terms in code and docs, and avoid the words listed under _Avoid_. For example, ❌ is **Dismiss**, never "reject".
- [docs/adr/](docs/adr/) holds architecture decisions. 0001 is Pi Durable on PiHarness in a Durable Object.

## Current status

The design is done and the spike is done. Its results are in the "Spike outcome" section of `docs/design.md`, and the design body already reflects them. The spike code lives in `spike/` and is evidence, not the start of v1. **The next step is the v1 spec.** First settle the open decisions listed in the spike outcome (batch count, CPU, batch size).

## Constraints

- **Target the Cloudflare free plan.** The design is sized to 50 subrequests per invocation (`AI` binding calls count) and 10k neurons/day. The 10 ms CPU figure is exceeded in practice (13-74 ms) without being enforced; see the spike outcome. Do not assume Workers Paid.
- **Pin `@earendil-works/pi-*` versions exactly**, because pi-durable is experimental.
- **The repo is public.** The owner's profile (`profile.md`) and all secrets (`.dev.vars`, bot token, API keys) stay out of git.
- The owner's existing job-search workspace is at `C:\Users\polke\repos\ai-job-search`. It is a reference for the scoring rubric (`.claude/skills/job-application-assistant/04-job-evaluation.md`) and profile sources. Read from it, but never copy personal data into this repo.

## Working rules

- **Implement with ponytail.** Any implementation work (`/implement`, `/implement-spec`, or a plain request) uses the `ponytail` skill. That includes implementer subagents: their brief tells them to call it alongside `tdd`. If something was built without it, run `ponytail-review` on it before calling the work done.
- **Explain every change, for learning.** The owner is learning agent architecture and how to build on pi. Before a change, say in a few lines what you will do and why, naming the pi or harness concept it touches (tools, the loop, context, durability, replay, idempotency...). After it, give a short summary of what changed and what it teaches. Keep both brief and in Spanish.

## Agent skills

### Issue tracker

GitHub Issues on `polkeng2/pi-jobs`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), applied as GitHub labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
