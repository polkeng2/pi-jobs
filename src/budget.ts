/** Free plan: 50 subrequests per invocation (fetch hops and AI calls). */
export const SUBREQUEST_LIMIT = 50;
/** Fetch and score chunks stop starting calls here, leaving room for hops and the chunk's own bookkeeping. */
export const CHUNK_CALLS = SUBREQUEST_LIMIT - 10;
/** read_story refuses to start past this: 34 + at most 5 calls of its own = 39. */
export const READ_STORY_GUARD = 34;

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

/** Adds one phase's model usage to usage_log; neurons are computed here. */
export function logUsage(
  sql: { exec(q: string, ...p: any[]): unknown }, date: string, phase: string, model: string,
  u: { calls: number; input: number; output: number },
) {
  sql.exec(
    `INSERT INTO usage_log (digest_date, phase, model, calls, input_tokens, output_tokens, neurons) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (digest_date, phase, model) DO UPDATE SET calls = calls + excluded.calls, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens, neurons = neurons + excluded.neurons`,
    date, phase, model, u.calls, u.input, u.output, neurons(model, u.input, u.output),
  );
}

export const isSubrequestLimit = (e: unknown) => /too many subrequests/i.test(String((e as Error)?.message ?? e));

/** `used` counts subrequests (fetch hops and AI calls) in memory. */
export function createBudget(rawFetch: typeof fetch) {
  let live = 0;
  const waiting: (() => void)[] = [];
  const b = {
    used: 0,
    async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
      // A freed slot goes straight to the oldest waiter (live stays), so a new caller cannot jump in.
      if (live >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
      else live++;
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
        const next = waiting.shift();
        if (next) next();
        else live--;
      }
    },
    /** Returns the binding's result untouched. */
    countAI<T extends { run: (...a: any[]) => any }>(ai: T) {
      return { run: ((...a: any[]) => (b.used++, ai.run(...a))) as T["run"] };
    },
  };
  return b;
}

/** "neurons" once the date's usage_log has reached the daily allowance. */
export const neuronGuard = (sql: { exec(q: string, ...p: any[]): { toArray(): any[] } }, date: string) =>
  sql.exec("SELECT COALESCE(SUM(neurons), 0) AS n FROM usage_log WHERE digest_date = ?", date).toArray()[0].n >= NEURON_LIMIT ? "neurons" : "ok";
