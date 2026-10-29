// The diagnostic report: the one output format every spike check returns
// (issue #2 sets it; #3, #4, #5 reuse it). A check is judged from this JSON
// alone, without reading code.
//
//   {
//     "check":    "turn",                         // which check ran
//     "worker":   "job-scout-spike",              // which deployed Worker answered
//     "verdict":  "pass" | "fail",
//     "evidence": { ... },                        // raw facts: replies, errors, counts
//     "versions": { "@earendil-works/pi-ai": "1.4.0", ..., "agents": "0.31.0" },
//     "neurons":  { "total": 12.3, "source": "...", "calls": [ { model, inputTokens, outputTokens, neurons } ] },
//     "startedAt": "2026-10-29T...Z",
//     "durationMs": 1234
//   }
//
// Neurons are not returned by Workers AI per request. They are computed from
// the token counts the model reports and the published per-model rates below.
import pkg from "../package.json";

export type Verdict = "pass" | "fail";

export type ModelCall = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly neurons: number;
};

export type Report = {
  readonly check: string;
  readonly worker: string;
  readonly verdict: Verdict;
  readonly evidence: Record<string, unknown>;
  readonly versions: Record<string, string>;
  readonly neurons: {
    readonly total: number;
    readonly source: string;
    readonly calls: readonly ModelCall[];
  };
  readonly startedAt: string;
  readonly durationMs: number;
};

/** What a check hands back; `report()` adds the rest. */
export type CheckResult = {
  readonly verdict: Verdict;
  readonly evidence: Record<string, unknown>;
  readonly calls?: readonly ModelCall[];
};

/** Neurons per million tokens, from https://developers.cloudflare.com/workers-ai/platform/pricing/ (read 2026-10-29). */
export const NEURON_RATES: Record<string, { input: number; output: number }> = {
  "@cf/zai-org/glm-4.7-flash": { input: 5500, output: 36400 },
  "@cf/meta/llama-3.2-1b-instruct": { input: 2457, output: 18252 },
  "@cf/cloudflare/clef": { input: 21818, output: 0 },
};

const NEURON_SOURCE =
  "computed: reported tokens x published neurons-per-M rates (workers-ai pricing page, 2026-10-29)";

export function modelCall(model: string, inputTokens: number, outputTokens: number): ModelCall {
  const rate = NEURON_RATES[model];
  const neurons = rate ? (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000 : Number.NaN;
  return { model, inputTokens, outputTokens, neurons: round(neurons) };
}

/** The exact pins this Worker was built with: every @earendil-works/* dependency plus `agents`. */
export function pinnedVersions(): Record<string, string> {
  const deps: Record<string, string> = pkg.dependencies;
  return Object.fromEntries(
    Object.entries(deps).filter(([name]) => name.startsWith("@earendil-works/") || name === "agents"),
  );
}

export function report(check: string, worker: string, startedAt: number, result: CheckResult): Report {
  const calls = result.calls ?? [];
  return {
    check,
    worker,
    verdict: result.verdict,
    evidence: result.evidence,
    versions: pinnedVersions(),
    neurons: { total: round(calls.reduce((sum, c) => sum + c.neurons, 0)), source: NEURON_SOURCE, calls },
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** A failing result carrying the exact error, for checks that throw. */
export function failure(error: unknown, extra: Record<string, unknown> = {}): CheckResult {
  const e = error instanceof Error ? error : new Error(String(error));
  return { verdict: "fail", evidence: { ...extra, error: { name: e.name, message: e.message, stack: e.stack } } };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
