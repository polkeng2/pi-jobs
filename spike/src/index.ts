// Job Scout spike Worker (issue #2, spec #1). Throwaway: it is evidence, not v1.
//
// Diagnostic endpoint, the only interface:
//
//   GET /diag?check=<name>      -> 200 with a Report (src/report.ts) when the check ran,
//                                  404 with a failing Report for an unknown check.
//
// A check's verdict says whether the platform did what we asked; the HTTP
// status only says whether the check could be run. Checks run inside the one
// Durable Object (`Spike`, name "spike"), which hosts Pi Durable through
// PiHarness (ADR 0001). To add a check (#3, #4, #5), add a method to `Spike`
// that returns a CheckResult and list it in CHECKS.
import { DurableObject } from "cloudflare:workers";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { type CheckResult, failure, modelCall, type ModelCall, report } from "./report";

const WORKER = "job-scout-spike-subreq";
// Ticket #5: the cheapest practical model, one token out, for counting runs.
const SUBREQ_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const SUBREQ_FETCH_URL = "https://example.com/";
const ORCHESTRATOR = "@cf/zai-org/glm-4.7-flash";

/** Check name -> the Spike method that runs it. */
const CHECKS = { turn: "turn", subrequests: "subrequests" } as const satisfies Record<string, keyof Spike>;
type CheckName = keyof typeof CHECKS;

export class Spike extends DurableObject<Env> {
  // Model metadata goes on createAI's model, not per call: per-model options
  // are symbol keys and do not survive into stored sessions.
  ai = createAI({ binding: this.env.AI });
  model = this.ai(ORCHESTRATOR, { cost: { input: 0.06, output: 0.4, cacheRead: 0, cacheWrite: 0 } });

  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry: createRegistry(), onWake }, context);
    },
    defaults: { model: this.model },
  });

  lifecycle = Lifecycle.install(this).use(this.harness);

  /** RPC entry point. Native RPC bypasses fetch, so Lifecycle must be started by hand. */
  async run(check: CheckName, params: Record<string, string> = {}): Promise<CheckResult> {
    await this.lifecycle.start();
    return check === "subrequests" ? this.subrequests(params) : this[CHECKS[check] as "turn"]();
  }

  /**
   * Ticket #5. One invocation (this RPC call) makes `ai` AI binding calls, then `fetches`
   * plain fetches. The verdict is the platform's: the calls it refuses, and its own error.
   */
  async subrequests(params: Record<string, string>): Promise<CheckResult> {
    const ai = Math.min(Number(params.ai ?? 0), 200);
    const fetches = Math.min(Number(params.fetches ?? 0), 200);
    const calls: ModelCall[] = [];
    const failures: { index: number; kind: "ai" | "fetch"; error: string }[] = [];
    let succeeded = 0;
    const attempt = async (index: number, kind: "ai" | "fetch", run: () => Promise<void>) => {
      try {
        await run();
        succeeded++;
      } catch (error) {
        failures.push({ index, kind, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      }
    };
    for (let i = 1; i <= ai; i++) {
      await attempt(i, "ai", async () => {
        const out = (await this.env.AI.run(SUBREQ_MODEL, { prompt: "hi", max_tokens: 1 })) as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        calls.push(modelCall(SUBREQ_MODEL, out.usage?.prompt_tokens ?? 1, out.usage?.completion_tokens ?? 1));
      });
    }
    for (let i = 1; i <= fetches; i++) {
      await attempt(ai + i, "fetch", async () => {
        const res = await fetch(`${SUBREQ_FETCH_URL}?n=${i}`);
        await res.body?.cancel();
      });
    }
    const total = ai + fetches;
    return {
      verdict: failures.length === 0 || total > 50 ? "pass" : "fail",
      evidence: {
        ranIn: "durable-object-rpc",
        attempted: { ai, fetches, total },
        succeeded,
        failures,
        firstFailure: failures[0] ?? null,
        // Only decidable when plain fetches alone cannot reach the limit.
        aiCallsCountTowardLimit: fetches <= 50 && total > 50 ? failures.length > 0 : null,
      },
      calls,
    };
  }

  /** One agent turn, no tools: the model must answer through PiHarness. */
  async turn(): Promise<CheckResult> {
    // A fresh session per request keeps each report's transcript to this turn.
    const session = await this.harness.sessions.create();
    const response = await session.prompt("Reply with the single word pong and nothing else.");
    const assistants = response.messages
      .flatMap((entry) => entry.model ?? [])
      .filter((m): m is AssistantMessage => m.role === "assistant");
    const calls: ModelCall[] = assistants.map((m) => modelCall(m.model, m.usage.input, m.usage.output));
    return {
      verdict: response.status === "done" && /\S/.test(response.text ?? "") ? "pass" : "fail",
      evidence: {
        ranIn: "durable-object",
        durableObjectId: this.ctx.id.toString(),
        session: session.id,
        operation: { id: response.operationId, status: response.status, reason: response.reason },
        reply: response.text,
        assistantMessages: assistants.map((m) => ({
          provider: m.provider,
          model: m.model,
          stopReason: m.stopReason,
          usage: m.usage,
          errorMessage: m.errorMessage,
        })),
      },
      calls,
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/diag") return new Response("Not found. Try GET /diag?check=turn\n", { status: 404 });

    const startedAt = Date.now();
    const check = url.searchParams.get("check") ?? "";
    if (!(check in CHECKS)) {
      const result = { verdict: "fail", evidence: { error: `unknown check "${check}"`, knownChecks: Object.keys(CHECKS) } } as const;
      return Response.json(report(check, WORKER, startedAt, result), { status: 404 });
    }

    let result: CheckResult;
    try {
      result = await env.SPIKE.getByName("spike").run(check as CheckName, Object.fromEntries(url.searchParams));
    } catch (error) {
      result = failure(error, { ranIn: "worker" });
    }
    return Response.json(report(check, WORKER, startedAt, result));
  },
} satisfies ExportedHandler<Env>;
