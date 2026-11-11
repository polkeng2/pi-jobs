import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";

import { createBudget } from "./budget.ts";
import { DailyRun, runChunk, type Deps, type Io } from "./daily-run.ts";
import { ORCHESTRATOR_SYSTEM } from "./prompts.ts";
import { GLM, readStory, readStoryTool } from "./read-story.ts";
import { migrate } from "./schema.ts";
import { search, vote } from "./storage.ts";
import * as view from "./view.ts";

export class Signal extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  /** The budget and counted binding of the write chunk's pi run. Set when a chunk is submitted, never by a poll. */
  private run?: Pick<Deps, "budget" | "ai">;
  /** After a restart pi resumes with no dispatch: a fresh budget, since a restart is a new invocation. */
  private chunkRun() {
    if (!this.run) {
      const io = this.io();
      const budget = createBudget(io.fetch);
      this.run = { budget, ai: budget.countAI(io.ai) };
    }
    return this.run;
  }
  setRunBudget(d: Pick<Deps, "budget" | "ai">) {
    this.run = { budget: d.budget, ai: d.ai };
  }
  /** pi's model calls and read_story's writer both go through the current chunk's counted binding. */
  ai = createAI({ binding: { run: (...a: Parameters<Ai["run"]>) => this.chunkRun().ai.run(...a) } as Ai });

  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const registry = createRegistry();
      registry.install(defineExtension({
        name: "signal",
        tools: [readStoryTool((id) => this.readStory(id))],
        sections: [{ key: "orchestrator", tag: false, render: () => ORCHESTRATOR_SYSTEM }],
      }));
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry, onWake }, context);
    },
    defaults: { model: this.ai(GLM) },
  });
  dailyRun = new DailyRun(this);
  lifecycle = Lifecycle.install(this).use(this.harness).use(this.dailyRun);

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
      secrets: { finnhubKey: this.env.FINNHUB_API_KEY, edgarContact: this.env.EDGAR_CONTACT },
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
    return runChunk(this.sql, io, date, (fn) => this.ctx.storage.transactionSync(fn), this);
  }

  /** read_story's body for the model's tool. Tests override it to crash inside the tool. */
  readStory(id: number) {
    return readStory({ sql: this.sql, budget: this.chunkRun().budget, ai: this.ai }, id);
  }

  // --- Page RPCs: plain SQL, no pi, no fetch, no AI (docs/spec.md, Page) ---
  digestView(date: string | null) { return view.digestView(this.ctx.storage.sql, date); }
  searchStories(q: string) { return search(this.ctx.storage.sql, q); }
  vote(id: number, v: 1 | -1) {
    const r = vote(this.ctx.storage.sql, id, v, this.io().now());
    return r === null && !this.openStory(id, false) ? null : { vote: r };
  }
  openStory(id: number, log: boolean) { return view.openStory(this.ctx.storage.sql, id, log, this.io().now()); }
  exportVotes() { return view.exportVotes(this.ctx.storage.sql); }
  exportNearMiss() { return view.exportNearMiss(this.ctx.storage.sql); }
  // --- end Page RPCs ---
}
