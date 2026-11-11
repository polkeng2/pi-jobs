import { DurableObject } from "cloudflare:workers";

import { migrate } from "./schema.ts";
import { search, vote } from "./storage.ts";
import * as view from "./view.ts";

export class Signal extends DurableObject<Env> {
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
