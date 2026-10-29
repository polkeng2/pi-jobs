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
//
// Ticket #6 (resume) is three checks: resume-start, resume-crash, resume-status.
// The procedure is in spike/RESUME.md.
import { DurableObject } from "cloudflare:workers";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { Compile } from "typebox/compile";
import { Environment } from "typebox/system";
import { type CheckResult, failure, modelCall, type ModelCall, report } from "./report";

/** The reason resumeCrash passes to ctx.abort(); the stub call fails with it (or the platform's abort error). */
const FORCED_CRASH = /spike: forced crash \(ticket #6\)|Durable Object (was )?(reset|aborted)/i;
const WORKER = "job-scout-spike";
// Ticket #5: the cheapest practical model, one token out, for counting runs.
const SUBREQ_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const SUBREQ_FETCH_URL = "https://example.com/";
const ORCHESTRATOR = "@cf/zai-org/glm-4.7-flash";

/** Check name -> the Spike method that runs it. */
const CHECKS = {
  turn: "turn",
  clef: "clef",
  subrequests: "subrequests",
  tool: "tool",
  "resume-start": "resumeStart",
  "resume-status": "resumeStatus",
  "resume-crash": "resumeCrash",
} as const satisfies Record<string, keyof Spike>;

// Ticket #6. Synthetic warehouse: one replay-safe read, one effectful write.
// Each tool holds for `holdMs` so a crash or redeploy can land mid-execution
// (a deploy gives in-flight work ~30 s, so hold longer than that for a redeploy).
const RESUME_PROMPTS = {
  tools:
    'Synthetic test data. Step 1: call check_inventory with item "widget". Step 2: after it returns, call place_order with item "widget" and quantity 2. Call one tool at a time. Step 3: reply with the single word DONE.',
  stream: "Write a plain-text story of about 400 words about a lighthouse keeper. Do not call any tools.",
} as const;
const RESUME_DEFAULT_HOLD_MS = 60_000;

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

/** Parameters of the test tool `add`; probeValidation checks the same schema. */
const ADD_PARAMETERS = Type.Object({ a: Type.Integer(), b: Type.Integer() });

export class Spike extends DurableObject<Env> {
  sql = this.ctx.storage.sql;
  tablesReady = createResumeTables(this.sql);

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
          tools: [
            defineTool({
              name: "add",
              description: "Add two integers a and b and return the sum.",
              parameters: ADD_PARAMETERS,
              execute: async (args) => {
                this.received.push(args);
                return { output: [{ type: "text", text: String(args.a + args.b) }] };
              },
            }),
          ],
        }),
      );
      registry.install(
        defineExtension({
          name: "spike-resume-tools",
          tools: [
            defineTool({
              name: "check_inventory",
              description: "Read how many units of an item are in stock. Read-only.",
              parameters: Type.Object({ item: Type.String({ description: "Item name" }) }),
              replay: "safe",
              executionMode: "sequential",
              execute: async (args, api) => {
                await this.holdTool("check_inventory", api);
                return { output: [{ type: "text", text: `${args.item}: 12 in stock` }] };
              },
            }),
            defineTool({
              name: "place_order",
              description: "Place an order for an item. Each call places a new order.",
              parameters: Type.Object({
                item: Type.String({ description: "Item name" }),
                quantity: Type.Integer({ description: "Units to order" }),
              }),
              executionMode: "sequential",
              execute: async (args, api) => {
                await this.holdTool("place_order", api);
                return { output: [{ type: "text", text: `order ${api.callId} placed: ${args.quantity} x ${args.item}` }] };
              },
            }),
          ],
        }),
      );
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(storage, { models, registry, onWake }, context);
    },
    defaults: { model: this.model },
  });

  /** Arguments the `add` tool received (after validation) in the current tool check. ponytail: one tool check at a time. */
  received: { a: number; b: number }[] = [];

  lifecycle = Lifecycle.install(this).use(this.harness);

  /** RPC entry point. Native RPC bypasses fetch, so Lifecycle must be started by hand. */
  async run(check: CheckName, params: Record<string, string> = {}): Promise<CheckResult> {
    await this.lifecycle.start();
    return (this[CHECKS[check]] as (p: Record<string, string>) => Promise<CheckResult>).call(this, params);
  }

  /** Body of both resume tools: record the execution in our own table, then hold. */
  private async holdTool(tool: string, api: { conversationId: unknown; callId: string }) {
    const session = String(api.conversationId);
    const holdMs =
      this.sql.exec<{ hold_ms: number }>("SELECT hold_ms FROM spike_resume_runs WHERE session = ?", session).toArray()[0]
        ?.hold_ms ?? 0;
    const id = this.sql
      .exec<{ id: number }>(
        "INSERT INTO spike_tool_runs (session, tool, call_id, started_at) VALUES (?, ?, ?, ?) RETURNING id",
        session,
        tool,
        api.callId,
        Date.now(),
      )
      .one().id;
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    this.sql.exec("UPDATE spike_tool_runs SET finished_at = ? WHERE id = ?", Date.now(), id);
  }

  /**
   * Ticket #6, step 1. Start a run in a fresh session with submit(), and return
   * at once: the run goes on in the Lifecycle alarm, where a crash can hit it.
   */
  async resumeStart(params: Record<string, string>): Promise<CheckResult> {
    const mode = params.mode === "stream" ? "stream" : "tools";
    const holdMs = Math.min(Math.max(Number(params.holdMs ?? RESUME_DEFAULT_HOLD_MS) || 0, 0), 180_000);
    const session = await this.harness.sessions.create();
    const operationId = `resume-${mode}-${Date.now()}`;
    // Before submit(), so the tools can read their hold.
    this.sql.exec(
      "INSERT INTO spike_resume_runs (session, operation_id, mode, hold_ms, started_at) VALUES (?, ?, ?, ?, ?)",
      session.id,
      operationId,
      mode,
      holdMs,
      Date.now(),
    );
    const receipt = await session.submit(RESUME_PROMPTS[mode], { operationId });
    return {
      verdict: receipt.accepted ? "pass" : "fail",
      evidence: { ranIn: "durable-object", run: { session: session.id, operationId, mode, holdMs }, receipt },
    };
  }

  /** Ticket #6, the crash: ctx.abort() resets this object at once, like an uncaught crash. */
  async resumeCrash(): Promise<CheckResult> {
    this.sql.exec("INSERT INTO spike_crashes (at) VALUES (?)", Date.now());
    await this.ctx.storage.sync();
    this.ctx.abort("spike: forced crash (ticket #6)");
    return { verdict: "fail", evidence: { crashed: false, error: "ctx.abort() returned" } };
  }

  /**
   * Ticket #6, step 2. Read where a run stands, without waiting: pi's view
   * (pending, result, transcript) next to ours (tool executions, crashes).
   * Poll it until `settled`.
   */
  async resumeStatus(params: Record<string, string>): Promise<CheckResult> {
    // Without `session`, the latest run (handy when repeating the procedure by hand).
    const run = this.sql
      .exec<{ session: string; operation_id: string; mode: string; hold_ms: number; started_at: number }>(
        params.session
          ? "SELECT * FROM spike_resume_runs WHERE session = ?"
          : "SELECT * FROM spike_resume_runs ORDER BY started_at DESC LIMIT 1",
        ...(params.session ? [params.session] : []),
      )
      .toArray()[0];
    if (!run) return { verdict: "fail", evidence: { error: `no resume run for session "${params.session}"` } };
    const operationId = params.op ?? run.operation_id;
    const pending = await this.harness.pending({ session: run.session });
    const mine = pending.find((p) => p.operationId === operationId);
    let result: unknown = null;
    if (!mine) {
      try {
        result = await this.harness.wait(operationId, { session: run.session, signal: AbortSignal.timeout(3000) });
      } catch (error) {
        result = null;
      }
    }
    const settled = !mine && result !== null;
    const operation = result as { status?: string; reason?: string; text?: string } | null;

    const toolRuns = this.sql
      .exec<any>("SELECT * FROM spike_tool_runs WHERE session = ? ORDER BY id", run.session)
      .toArray()
      .map((r) => ({ tool: r.tool, callId: r.call_id, startedAt: r.started_at, finishedAt: r.finished_at }));
    // Crashes since this run started (spike_crashes is the only record of them).
    const crashes = this.sql.exec<{ at: number }>("SELECT at FROM spike_crashes WHERE at >= ? ORDER BY at", run.started_at).toArray();
    const interrupted = crashes.length > 0;

    const entries = await this.harness.messages({ session: run.session });
    const messages = entries.flatMap((e) => e.model ?? []);
    const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
    const toolResults = messages
      .filter((m) => m.role === "toolResult")
      .map((m: any) => ({ tool: m.toolName, callId: m.toolCallId, isError: m.isError, text: m.content?.map((c: any) => c.text ?? "").join("") }));
    const toolCalls = assistants.flatMap((m) =>
      m.content.flatMap((c) => (c.type === "toolCall" ? [{ id: c.id, name: c.name }] : [])),
    );
    const calledIds = toolCalls.map((c) => c.id);
    const conversationIds = [...new Set(entries.map((e) => String(e.conversationId)))];
    const promptKept = messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes(RESUME_PROMPTS[run.mode as "tools"].slice(0, 30)),
    );
    // Tool calls that started before the first crash must still be in the transcript.
    const preCrashCalls = toolRuns.filter((r) => r.startedAt < (crashes[0]?.at ?? 0)).map((r) => r.callId);
    const sameConversation = promptKept && conversationIds.length === 1 && preCrashCalls.every((id) => calledIds.includes(id));

    const reRuns = Object.fromEntries(
      (["check_inventory", "place_order"] as const).map((tool) => {
        const executionsPerCall: Record<string, number> = {};
        for (const r of toolRuns.filter((r) => r.tool === tool)) executionsPerCall[r.callId] = (executionsPerCall[r.callId] ?? 0) + 1;
        return [
          tool,
          {
            executionsPerCall,
            // pi ran the same tool call again after the interruption.
            reExecutedSameCall: Object.values(executionsPerCall).some((n) => n > 1),
            // The model issued a new call to the tool (a new call id).
            modelCalledAgain: toolCalls.filter((c) => c.name === tool).length > 1,
            results: toolResults.filter((t) => t.tool === tool),
          },
        ];
      }),
    );

    const done = settled && operation?.status === "done";
    return {
      verdict: done && interrupted && (run.mode === "stream" || sameConversation) ? "pass" : "fail",
      evidence: {
        ranIn: "durable-object",
        run: { session: run.session, operationId, mode: run.mode, holdMs: run.hold_ms },
        settled,
        pending,
        operation,
        interrupted,
        crashes,
        sameConversation,
        conversationIds,
        promptKept,
        reRuns,
        toolRuns,
        transcript: entries.map((e) => ({ id: e.id, kind: e.kind, byTaskId: e.byTaskId })),
        assistantMessages: assistants.map((m) => ({ stopReason: m.stopReason, usage: m.usage, errorMessage: m.errorMessage, textLength: JSON.stringify(m.content).length })),
      },
      // Only the attempts that ended in a message; a cut stream's tokens are not reported.
      calls: assistants.map((m) => modelCall(m.model, m.usage.input, m.usage.output)),
    };
  }

  /**
   * Ticket #5. One invocation (this RPC call) makes `ai` AI binding calls, then `fetches`
   * plain fetches. The verdict is the platform's: the calls it refuses, and its own error.
   */
  async subrequests(params: Record<string, string>): Promise<CheckResult> {
    const counts = [params.ai ?? "0", params.fetches ?? "0"].map(Number);
    if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
      return {
        verdict: "fail",
        evidence: { error: "ai and fetches must be non-negative integers", ai: params.ai, fetches: params.fetches },
      };
    }
    const ai = Math.min(counts[0], 200);
    const fetches = Math.min(counts[1], 200);
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
    // Only the platform's own limit error is the evidence we want; any other error is a real failure.
    const otherErrors = failures.filter((f) => !/Too many subrequests/i.test(f.error));
    return {
      verdict: otherErrors.length === 0 && (failures.length === 0 || total > 50) ? "pass" : "fail",
      evidence: {
        ranIn: "durable-object-rpc",
        attempted: { ai, fetches, total },
        succeeded,
        failures,
        firstFailure: failures[0] ?? null,
        otherErrors,
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

  /** Tool validation: the agent calls `add`, and probeValidation shows how the harness validates its arguments. */
  async tool(): Promise<CheckResult> {
    const validation = probeValidation();
    const session = await this.harness.sessions.create();
    const received = (this.received = []);
    const response = await session.prompt("Call the add tool with a=3 and b=4, then reply with the sum as a number.");
    const messages = response.messages.flatMap((entry) => entry.model ?? []);
    const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
    const toolResults = messages
      .filter((m) => m.role === "toolResult")
      .map((m: any) => ({ tool: m.toolName, isError: m.isError, content: m.content }));
    return {
      verdict: response.status === "done" && received.length >= 1 && validation.badArgsRejected ? "pass" : "fail",
      evidence: {
        ranIn: "durable-object",
        toolCalls: received.length,
        receivedArgs: received,
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

/** Our own tables for ticket #6 (not pi_*): what ran and when. */
function createResumeTables(sql: SqlStorage): true {
  sql.exec(`CREATE TABLE IF NOT EXISTS spike_resume_runs (
    session TEXT PRIMARY KEY, operation_id TEXT, mode TEXT, hold_ms INTEGER, started_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS spike_tool_runs (
    id INTEGER PRIMARY KEY, session TEXT, tool TEXT, call_id TEXT, started_at INTEGER, finished_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS spike_crashes (at INTEGER)`);
  return true;
}

/** Direct probe of the validator the harness uses: which typebox path, coercion, rejection. */
function probeValidation() {
  const schema = ADD_PARAMETERS;
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
    if (!Object.hasOwn(CHECKS, check)) {
      const result = { verdict: "fail", evidence: { error: `unknown check "${check}"`, knownChecks: Object.keys(CHECKS) } } as const;
      return Response.json(report(check, WORKER, startedAt, result), { status: 404 });
    }

    let result: CheckResult;
    try {
      result = await env.SPIKE.getByName("spike").run(check as CheckName, Object.fromEntries(url.searchParams));
    } catch (error) {
      // The crash check works by making the object's call fail, and only the forced abort counts.
      result =
        check === "resume-crash" && FORCED_CRASH.test(String(error))
          ? { verdict: "pass", evidence: { crashed: true, method: "ctx.abort()", error: String(error) } }
          : failure(error, { ranIn: "worker" });
    }
    return Response.json(report(check, WORKER, startedAt, result));
  },
} satisfies ExportedHandler<Env>;
