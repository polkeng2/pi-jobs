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
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { Compile } from "typebox/compile";
import { Environment, Settings } from "typebox/system";
import { type CheckResult, failure, modelCall, type ModelCall, report } from "./report";

const WORKER = "job-scout-spike-ajv";
// Ticket #5: the cheapest practical model, one token out, for counting runs.
const SUBREQ_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const SUBREQ_FETCH_URL = "https://example.com/";
const ORCHESTRATOR = "@cf/zai-org/glm-4.7-flash";

/** Check name -> the Spike method that runs it. */
const CHECKS = { turn: "turn", clef: "clef", subrequests: "subrequests", tool: "tool", "tool-interpreted": "toolInterpreted" } as const satisfies Record<string, keyof Spike>;

const CLEF = "@cf/cloudflare/clef";
// Synthetic data only. Nothing here comes from the owner's real profile or job search.
const SYNTHETIC_PROFILE =
  "Candidate: backend engineer, 6 years of TypeScript and Postgres, wants a fully remote role, speaks English.";
const SYNTHETIC_OFFER =
  "Senior Backend Engineer at Acme Cloud. Fully remote. TypeScript, Node.js, Postgres. English-speaking team. 5+ years of experience.";
const CLEF_QUESTIONS = {
  fit: {
    type: "score",
    instructions: "How well do the candidate's skills and experience match the offer?",
    criteria: ["No match", "Weak match", "Partial match", "Strong match", "Excellent match"],
  },
  remote: { type: "noul", instructions: "Is the offer fully remote?" },
} as const;
type CheckName = keyof typeof CHECKS;

/** Two identical tools with separate schemas: validators are cached per schema object,
 *  so the acceleration-off run needs a schema nobody compiled with acceleration on. */
const addParameters = () => Type.Object({ a: Type.Integer(), b: Type.Integer() });

export class Spike extends DurableObject<Env> {
  // Model metadata goes on createAI's model, not per call: per-model options
  // are symbol keys and do not survive into stored sessions.
  ai = createAI({ binding: this.env.AI });
  model = this.ai(ORCHESTRATOR, { cost: { input: 0.06, output: 0.4, cacheRead: 0, cacheWrite: 0 } });

  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "spike-tools",
          tools: ["add", "add_interpreted"].map((name) =>
            defineTool({
              name,
              description: "Add two integers a and b and return the sum.",
              parameters: addParameters(),
              execute: async (args) => {
                this.received.push(args);
                return { output: [{ type: "text", text: String(args.a + args.b) }] };
              },
            }),
          ),
        }),
      );
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry, onWake }, context);
    },
    defaults: { model: this.model },
  });

  /** Arguments the test tools actually received (after validation). Reset per check. */
  received: { a: number; b: number }[] = [];

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

  /** Tool validation with typebox's defaults (evaluated if the runtime allows). */
  tool(): Promise<CheckResult> {
    return this.toolTurn("add");
  }

  /** Same, with typebox acceleration off: forces the interpreted path. */
  async toolInterpreted(): Promise<CheckResult> {
    const before = Settings.Get().useAcceleration;
    Settings.Set({ useAcceleration: false });
    try {
      return await this.toolTurn("add_interpreted");
    } finally {
      Settings.Set({ useAcceleration: before });
    }
  }

  private async toolTurn(toolName: string): Promise<CheckResult> {
    this.received = [];
    const validation = probeValidation();
    const session = await this.harness.sessions.create();
    const response = await session.prompt(
      `Call the ${toolName} tool with a=3 and b=4, then reply with the sum as a number.`,
    );
    const messages = response.messages.flatMap((entry) => entry.model ?? []);
    const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
    const toolResults = messages
      .filter((m) => m.role === "toolResult")
      .map((m: any) => ({ tool: m.toolName, isError: m.isError, content: m.content }));
    return {
      verdict: response.status === "done" && this.received.length >= 1 && validation.badArgsRejected ? "pass" : "fail",
      evidence: {
        ranIn: "durable-object",
        tool: toolName,
        toolCalls: this.received.length,
        receivedArgs: this.received,
        toolResults,
        reply: response.text,
        operation: { id: response.operationId, status: response.status, reason: response.reason },
        validation,
      },
      calls: assistants.map((m) => modelCall(m.model, m.usage.input, m.usage.output)),
    };
  }

  /**
   * Clef takes `state` plus typed `questions`, not chat messages. Path 1: ask pi-ai's
   * Cloudflare provider to call Clef and record what happens. Path 2: call `env.AI.run`
   * directly, which is what `score_offers` would do.
   */
  async clef(): Promise<CheckResult> {
    const state = { profile: SYNTHETIC_PROFILE, offer: SYNTHETIC_OFFER };

    let piAi: Record<string, unknown>;
    try {
      const msg = await this.ai.complete(this.ai(CLEF), {
        messages: [{ role: "user", content: JSON.stringify({ state, questions: CLEF_QUESTIONS }), timestamp: Date.now() }],
      });
      piAi = {
        canCallClef: false,
        reason:
          "pi-ai builds a chat payload (messages/tools) and reads a chat completion back; it has no way to send `state` + `questions` or read `answers`.",
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
        content: msg.content,
        usage: msg.usage,
      };
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      piAi = { canCallClef: false, reason: `pi-ai cannot express Clef's request: ${e.message}` };
    }

    // `model: "clef"` in the body is required by Clef's input schema.
    const raw = (await this.env.AI.run(CLEF as never, { model: "clef", state, questions: CLEF_QUESTIONS } as never)) as unknown as {
      answers?: Record<string, unknown>;
      usage?: Record<string, number>;
    };
    const inputTokens = Number(raw.usage?.prompt_tokens ?? raw.usage?.input_tokens ?? 0);
    const answered = !!raw.answers && "fit" in raw.answers && "remote" in raw.answers;
    return {
      verdict: answered ? "pass" : "fail",
      evidence: { data: "synthetic", piAi, workingPath: "env.AI.run(@cf/cloudflare/clef, { model, state, questions })", raw },
      calls: [modelCall(CLEF, inputTokens, 0)],
    };
  }
}

/** Direct probe of the validator the harness uses: which typebox path, coercion, rejection. */
function probeValidation() {
  const schema = addParameters();
  const compiled = Compile(schema);
  const tool = { name: "probe", description: "probe", parameters: schema };
  const call = (args: unknown) => ({ type: "toolCall" as const, id: "probe", name: "probe", arguments: args as any });
  let badArgsError: string | undefined;
  try {
    validateToolArguments(tool, call({ a: "x", b: 4 }));
  } catch (e) {
    badArgsError = e instanceof Error ? e.message : String(e);
  }
  return {
    canEvaluate: Environment.CanEvaluate(),
    useAcceleration: Settings.Get().useAcceleration,
    path: compiled.IsAccelerated() ? "evaluated" : "interpreted",
    coerced: validateToolArguments(tool, call({ a: "3", b: 4 })),
    badArgsRejected: badArgsError !== undefined,
    badArgsError,
  };
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
