---
status: accepted
---

# Pi Durable on PiHarness in a Durable Object is the agent runtime

A scouting run spans several batches. A batch can crash halfway. The owner answers the digest hours later, by tapping a Telegram button. All of that has to resume against the same saved conversation. So the agent runs on `@earendil-works/pi-durable` hosted by Cloudflare's `PiHarness`, inside a single Durable Object. Its SQLite also holds our own tables: offers, scores, decisions and usage. Each batch runs in its own alarm wake, which keeps it under the free plan's per-invocation limits of 50 subrequests and 10 ms CPU. A button tap becomes an idempotent `submit()` keyed by the Telegram callback id.

## Considered Options

- **Cloudflare Workflows**: durable steps with retries, but no agent transcript or context model. We would rebuild what Pi Durable already gives us.
- **Plain cron Worker with state in KV/D1**: simplest, but a crash mid-run loses the run. One invocation can't fit several batches under the free-plan limits either.

## Consequences

- Pi Durable is experimental (launched with Pi 1.0, 2026-10-01), and its API "changes without notice between releases". Pin exact versions and upgrade deliberately.
- Only tools marked `replay: "safe"` re-run after a crash. Effectful tools (`send_digest`, Telegram edits) need their own idempotency keys.
- An alarm wake lasts at most 15 min. Interrupted `@cf/` model streams are retried, not resumed, and may be billed twice.
- Verified by the spike (2026-10-29, pi 1.4.0, `agents` 0.31.0; see the design's "Spike outcome"). Tool validation works in Workers: pi uses typebox, not AJV, and it falls back to interpreted checks. After a forced crash the run resumed in the same conversation, the safe tool re-ran and the effectful one did not. An interrupted stream was billed twice. Two refinements, neither a reason to reopen this decision: `AI` binding calls count toward the 50 subrequests, so a batch scores at most 40 offers; and invocations used 13-74 ms CPU, over the 10 ms figure, without being killed.
