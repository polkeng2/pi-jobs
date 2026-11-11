import { DurableObject } from "cloudflare:workers";

export class Signal extends DurableObject<Env> {
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
