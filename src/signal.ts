import { DurableObject } from "cloudflare:workers";

import { migrate } from "./schema.ts";

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
}
