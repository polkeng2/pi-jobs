// Throwaway for issue #22 (spec "Shared alarm, deployed"). Evidence, not v1.
//
// One Durable Object runs a Lifecycle job (our Driver capability) and PiHarness on the
// same alarm. The Driver walks four steps, one chunk per dispatch:
//   s1: 3 dispatches, each 40 fetches            -> each dispatch gets a fresh count
//   s2: submit a real GLM run (read_story x2: 15 fetches + 35 s hold each); poll at +30 s, 0 calls
//   s3: session.reset(), a second run like s2    -> cumulative calls past 50, new invocations
//   s4: FTS5 schema, insert, search              -> FTS5 on a deployed object
// Routes: GET /start (idempotent), GET /status (pass/fail evidence from our own tables).
import { DurableObject } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";

const FETCH_URL = "https://example.com/";
const ORCHESTRATOR = "@cf/zai-org/glm-4.7-flash";
const JOB = "shared-alarm";
const PROMPT =
  "Synthetic test. Call the read_story tool twice, one call at a time, with id=1 and then id=2. Never call two tools in one turn. After the second result, reply with the single word DONE.";

interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  SHARED: DurableObjectNamespace<Shared>;
}

class Driver extends LifecycleCapability {
  constructor(private readonly host: Shared) {
    super("shared-alarm-driver");
  }
  begin() {
    return this.lifecycle.jobs.push({
      id: JOB,
      fn: "step",
      time: Date.now(),
      retry: { maxAttempts: 1 },
      hungTimeoutSeconds: 300,
    });
  }
  async onJob(ctx: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.host.step(ctx.job.id);
  }
  onJobError(_ctx: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    // ponytail: a throw ends the job (measured in the spike); record it and stop.
    this.host.note("job-error", "fail", String(error));
    return undefined;
  }
}

export class Shared extends DurableObject<Env> {
  sql = this.ctx.storage.sql;
  ai = createAI({ binding: this.env.AI as never });
  model = this.ai(ORCHESTRATOR, { cost: { input: 0.06, output: 0.4, cacheRead: 0, cacheWrite: 0 } });
  dispatch = 0; // id of the current job dispatch; 0 = made by the pi tool

  harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "shared-alarm-tools",
          tools: [
            defineTool({
              name: "read_story",
              description: "Read story `id`. Read-only; takes a while.",
              parameters: Type.Object({ id: Type.Integer({ description: "Story id" }) }),
              replay: "safe",
              executionMode: "sequential",
              execute: async (args) => {
                for (let i = 0; i < 15; i++) await this.hit(`tool:${this.get("run")}`, 0);
                await new Promise((r) => setTimeout(r, 35_000));
                return { output: [{ type: "text", text: `story ${args.id} read` }] };
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

  driver = new Driver(this);
  lifecycle = Lifecycle.install(this).use(this.harness).use(this.driver);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dispatches (id INTEGER PRIMARY KEY, phase TEXT, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, dispatch INTEGER, step TEXT, ok INTEGER, error TEXT, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, step TEXT, status TEXT, detail TEXT, at INTEGER)`);
  }

  get(k: string) {
    return this.sql.exec<{ v: string }>("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v;
  }
  set(k: string, v: string) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }
  note(step: string, status: "ok" | "fail", detail = "") {
    this.sql.exec("INSERT INTO notes (step, status, detail, at) VALUES (?, ?, ?, ?)", step, status, detail, Date.now());
  }

  /** One counted fetch; the platform's own error text is the evidence. */
  async hit(step: string, dispatch = this.dispatch) {
    let error: string | null = null;
    try {
      const res = await fetch(`${FETCH_URL}?${Date.now()}`);
      await res.body?.cancel();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.sql.exec("INSERT INTO calls (dispatch, step, ok, error, at) VALUES (?, ?, ?, ?, ?)", dispatch, step, error ? 0 : 1, error, Date.now());
  }

  /** RPC entry. Native RPC bypasses fetch, so Lifecycle is started by hand. */
  async start() {
    await this.lifecycle.start();
    if (this.get("phase")) return { started: false, phase: this.get("phase") };
    this.set("phase", "s1");
    this.set("startedAt", String(Date.now()));
    await this.driver.begin();
    return { started: true };
  }

  /** One chunk per dispatch. Returns the Lifecycle outcome. */
  async step(_id: string): Promise<LifecycleJobOutcome> {
    const phase = this.get("phase")!;
    this.dispatch = this.sql
      .exec<{ id: number }>("INSERT INTO dispatches (phase, at) VALUES (?, ?) RETURNING id", phase, Date.now())
      .one().id;
    const soon = { rescheduleAt: Date.now() + 1000 };
    const poll = { rescheduleAt: Date.now() + 30_000 };
    switch (phase) {
      case "s1": {
        for (let i = 0; i < 40; i++) await this.hit("s1");
        const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM dispatches WHERE phase = 's1'").one().n;
        if (n >= 3) this.set("phase", "s2");
        return soon;
      }
      case "s2":
      case "s3": {
        const session = phase === "s2" ? await this.harness.sessions.create() : this.harness.sessions.get(this.get("session")!);
        if (phase === "s3") await session.reset();
        this.set("session", session.id);
        this.set("run", phase);
        const op = `${phase}-${Date.now()}`;
        this.set("op", op);
        const receipt = await session.submit(PROMPT, { operationId: op });
        if (!receipt.accepted) this.note(phase, "fail", "submit not accepted");
        this.set("phase", `w${phase}`);
        return poll;
      }
      case "ws2":
      case "ws3": {
        const session = this.get("session")!;
        if ((await this.harness.pending({ session })).length > 0) return poll; // 0 calls
        const result = await this.harness.wait(this.get("op")!, { session, signal: AbortSignal.timeout(3000) });
        const run = phase === "ws2" ? "s2" : "s3";
        this.note(run, result.status === "done" ? "ok" : "fail", JSON.stringify(result).slice(0, 300));
        this.set("phase", phase === "ws2" ? "s3" : "s4");
        return soon;
      }
      case "s4": {
        try {
          this.sql.exec(`CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='unicode61 remove_diacritics 2')`);
          this.sql.exec(`INSERT INTO fts (body) VALUES ('Inversión en Meta')`);
          const hit = this.sql.exec(`SELECT body FROM fts WHERE fts MATCH '"inversion"*'`).toArray();
          this.note("s4", hit.length === 1 ? "ok" : "fail", JSON.stringify(hit));
        } catch (e) {
          this.note("s4", "fail", String(e));
        }
        this.set("phase", "done");
        this.set("doneAt", String(Date.now()));
        return undefined;
      }
    }
    return undefined;
  }

  status() {
    const calls = this.sql.exec<{ dispatch: number; step: string; ok: number; error: string | null }>("SELECT dispatch, step, ok, error FROM calls").toArray();
    const failures = calls.filter((c) => !c.ok);
    const perDispatch: Record<string, number> = {};
    for (const c of calls) perDispatch[`${c.dispatch}:${c.step}`] = (perDispatch[`${c.dispatch}:${c.step}`] ?? 0) + 1;
    const notes = this.sql.exec<{ step: string; status: string; detail: string }>("SELECT step, status, detail FROM notes").toArray();
    const startedAt = Number(this.get("startedAt") ?? 0);
    const doneAt = Number(this.get("doneAt") ?? 0);
    const tooMany = failures.filter((f) => /Too many subrequests/i.test(f.error ?? ""));
    const done = this.get("phase") === "done";
    const stepsOk = ["s2", "s3", "s4"].every((s) => notes.some((n) => n.step === s && n.status === "ok"));
    return {
      phase: this.get("phase") ?? null,
      done,
      elapsedMs: doneAt ? doneAt - startedAt : startedAt ? Date.now() - startedAt : null,
      verdict: done && stepsOk && tooMany.length === 0 && doneAt - startedAt <= 300_000 ? "pass" : done ? "fail" : "running",
      tooManySubrequests: tooMany.length,
      totalCalls: calls.length,
      callsPerDispatchAndStep: perDispatch,
      failures: failures.slice(0, 5),
      notes,
      dispatches: this.sql.exec<{ id: number; phase: string }>("SELECT id, phase FROM dispatches").toArray(),
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const stub = env.SHARED.getByName("shared");
    const path = new URL(request.url).pathname;
    if (path === "/start") return Response.json(await stub.start());
    if (path === "/status") return Response.json(await stub.status());
    return new Response("GET /start, then GET /status until done\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
