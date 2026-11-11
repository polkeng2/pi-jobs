// The Daily Run driver: one Lifecycle job, one chunk per dispatch. State between chunks lives only in our tables.
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";

import { createBudget, isSubrequestLimit } from "./budget.ts";
import { CLEF, scoreStories as score } from "./scorer.ts";
import type { Signal } from "./signal.ts";
import { prune } from "./storage.ts";

export type Io = ReturnType<Signal["io"]>;
type Phase = "fetch" | "score" | "write" | "publish" | "done";
type Budget = ReturnType<typeof createBudget>;
/** What every chunk gets. `fetch` and `ai` are counted by `budget`. */
export type Deps = { sql: SqlStorage; budget: Budget; ai: Pick<Ai, "run">; now: () => number };

const utc = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`);
const DAY_MS = 86_400_000;

// Stubs. #28 replaces fetchFeeds (src/feeds.ts), #30 scoreStories (src/scorer.ts),
// #32 the write phase, #33 publishDigest (src/publish.ts). Keep the spec signatures.
const fetchFeeds = async (_d: Deps, _date: string) => ({ done: true });
const scoreStories = (d: Deps, date: string) =>
  score({ ...d, clef: (state, questions) => d.ai.run(CLEF, { model: "clef", state, questions } as any) as any }, date);
function publishDigest(d: { sql: SqlStorage; now: () => number }, date: string) {
  const late = d.now() >= utc(date, "07:50");
  d.sql.exec(
    "UPDATE digests SET published_at = ?, status = ?, notice = ?, db_bytes = ? WHERE date = ? AND published_at IS NULL",
    d.now(), late ? "partial" : "complete", late ? "Se alcanzó la hora límite: este Digest está incompleto." : null,
    d.sql.databaseSize, date,
  );
}

const setPhase = (sql: SqlStorage, date: string, phase: Phase) =>
  sql.exec("UPDATE digests SET phase = ? WHERE date = ?", phase, date);

/** Runs the chunk for the Digest's current phase and says when to run again. */
export async function runChunk(sql: SqlStorage, io: Io, date: string): Promise<LifecycleJobOutcome> {
  const { phase } = sql.exec<{ phase: Phase }>("SELECT phase FROM digests WHERE date = ?", date).one();
  const budget = createBudget(io.fetch); // a fresh budget is the reset at chunk start
  const d: Deps = { sql, budget, ai: budget.countAI(io.ai), now: io.now };
  const next = { rescheduleAt: io.now() + io.chunkDelayMs };
  try {
    switch (phase) {
      case "fetch":
        if ((await fetchFeeds(d, date)).done) setPhase(sql, date, "score");
        return next;
      case "score":
        if ((await scoreStories(d, date)).done) setPhase(sql, date, "write");
        return next;
      case "write": // #32: sessions, submit, poll at io.pollDelayMs, retries, code reads
        setPhase(sql, date, "publish");
        return next;
      case "publish": {
        publishDigest(d, date);
        const cutMs = Date.parse(date) - 90 * DAY_MS;
        prune(sql, new Date(cutMs).toISOString().slice(0, 10), cutMs);
        setPhase(sql, date, "done");
        return undefined;
      }
      case "done":
        return undefined;
    }
  } catch (e) {
    if (isSubrequestLimit(e)) return next; // ends the chunk; not an attempt
    throw e;
  }
}

export class DailyRun extends LifecycleCapability {
  private io?: Io;
  private readonly host: Signal;

  constructor(host: Signal) {
    super("daily-run");
    this.host = host;
  }

  /** Returns false when the date already has a Daily Run: a repeated trigger is a no-op. */
  async start(date: string, interests: string) {
    const now = this.host.io().now();
    const inserted = this.host.sql
      .exec("INSERT OR IGNORE INTO digests (date, interests, started_at) VALUES (?, ?, ?) RETURNING date", date, interests, now)
      .toArray().length;
    if (!inserted) return false;
    // maxAttempts 1: the default 3 retries inside one invocation and overruns the chunk's budget.
    // No singleflight: a crashed dispatch must be able to run again.
    await this.lifecycle.jobs.push({
      id: `digest-${date}`, fn: "daily_step", time: now, retry: { maxAttempts: 1 }, hungTimeoutSeconds: 300,
    });
    return true;
  }

  async onJob(ctx: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const io = (this.io = this.host.io()); // once per dispatch
    const date = ctx.job.id.slice("digest-".length);
    const sql = this.host.sql;
    const { phase, chunk_stop } = sql.exec<{ phase: Phase; chunk_stop: string | null }>(
      "SELECT phase, chunk_stop FROM digests WHERE date = ?", date,
    ).one();
    // Deadline and neuron guard: go to publish. #32 aborts a live session first.
    if ((phase !== "publish" && phase !== "done") && (io.now() >= utc(date, "07:50") || chunk_stop === "neurons")) {
      setPhase(sql, date, "publish");
    }
    return this.host.dailyStep(date, io);
  }

  /** Without it, one throw with maxAttempts 1 ends the job and no Digest appears (measured). */
  onJobError(ctx: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    console.error("daily run dispatch failed", ctx.job.id, error);
    const now = (this.io ?? this.host.io()).now();
    if (now >= utc(ctx.job.id.slice("digest-".length), "08:30")) return undefined;
    return { rescheduleAt: now + 60_000 };
  }
}
