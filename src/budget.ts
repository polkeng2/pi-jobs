const MAX_HOPS = 2;
const MAX_CONCURRENT = 6;
const TIMEOUT_MS = 8000;
const NEURON_LIMIT = 9000;

// Neurons per 1M tokens (input, output), from the Workers AI pricing page.
const RATES: Record<string, [number, number]> = {
  "@cf/cloudflare/clef": [21_818, 0],
  "@cf/zai-org/glm-4.7-flash": [5_500, 36_400],
};

export const neurons = (model: string, input: number, output: number) => {
  const [i, o] = RATES[model];
  return (input * i + output * o) / 1e6;
};

export const isSubrequestLimit = (e: unknown) => /too many subrequests/i.test(String((e as Error)?.message ?? e));

/** `used` counts subrequests (fetch hops and AI calls) in memory; reset at chunk start. */
export function createBudget(rawFetch: typeof fetch) {
  let live = 0;
  const waiting: (() => void)[] = [];
  const b = {
    used: 0,
    reset() {
      b.used = 0;
    },
    async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
      if (live >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
      live++;
      try {
        let u = String(url);
        for (let hop = 0; ; hop++) {
          b.used++;
          const res = await rawFetch(u, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
          const loc = res.status >= 300 && res.status < 400 && res.headers.get("location");
          if (!loc) return res;
          if (hop === MAX_HOPS) throw new Error(`too many redirects: ${u}`);
          u = new URL(loc, u).href;
        }
      } finally {
        live--;
        waiting.shift()?.();
      }
    },
    /** Returns the binding's result untouched. */
    countAI<T extends { run: (...a: any[]) => any }>(ai: T) {
      return { run: ((...a: any[]) => (b.used++, ai.run(...a))) as T["run"] };
    },
  };
  return b;
}

/** `sumNeurons(date)` is SUM(neurons) FROM usage_log for that date. */
export const neuronGuard = (sumNeurons: (date: string) => number, date: string) =>
  sumNeurons(date) >= NEURON_LIMIT ? "neurons" : "ok";
