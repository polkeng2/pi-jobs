import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

import { DailyRun, runChunk, type Io } from "./daily-run.ts";
import { migrate } from "./schema.ts";

export class Signal extends DurableObject<Env> {
  sql = this.ctx.storage.sql;
  dailyRun = new DailyRun(this);
  lifecycle = Lifecycle.install(this).use(this.dailyRun);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
  }

  /** The only place that touches env.AI, global fetch and Date.now. Tests override it. */
  io() {
    return {
      ai: this.env.AI,
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      chunkDelayMs: 1000,
      pollDelayMs: 30_000,
    };
  }

  /** RPC from the cron. `date` is the Madrid date. A repeated trigger for the same date is a no-op. */
  async startDailyRun(date: string) {
    await this.lifecycle.start(); // native RPC bypasses it
    const interests = await this.env.KV.get("interests.md");
    if (interests === null) throw new Error("interests.md is missing from KV");
    return this.dailyRun.start(date, interests);
  }

  /** One chunk of the Daily Run. Tests override it to crash or throw inside a dispatch. */
  dailyStep(date: string, io: Io) {
    return runChunk(this.sql, io, date);
  }
}
