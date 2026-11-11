// Test Worker: Signal with every outside call faked. All fakes are stateless: they decide from their
// input and from rows the test seeded, never from memory, so a crash cannot make them re-issue calls.
import type { Io } from "../src/daily-run.ts";
import app from "../src/index.ts";
import { Signal as Base } from "../src/signal.ts";
import { createAI } from "agents/models/pi-ai";
import { getArticleText } from "../src/article.ts";
import { createBudget } from "../src/budget.ts";
import { readStoryTool } from "../src/read-story.ts";
import { ARTICLES, FEEDS, QUIET_FEEDS, READ_STORY_ARTICLES, SCHEMA } from "./fixtures.ts";

// Workers AI's stream: OpenAI-style deltas, then a native `{ response: "", usage }` tail with the usage, then [DONE]
// (the shape agents' normalizeChatCompletionsStream documents from live captures).
const sse = (chunks: object[]) =>
  new Response(
    [...chunks, { response: "", usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } }]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const chunk = (delta: object, finish: string | null = null) => ({
  id: "fake", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }],
});

function fakeAI(o: Base, log: (kind: string, target: string) => void) {
  return {
    async run(model: string, input: any, opts?: any) {
      log("ai", input.tools?.length ? `${model} +tools` : model); // "+tools": an orchestrator call
      const text = JSON.stringify(input);
      if (model.includes("clef")) {
        if (text.includes("[fail]")) throw new Error("fake clef failure");
        const answers: Record<string, unknown> = {};
        for (const [k, q] of Object.entries<any>(input.questions ?? {})) {
          answers[k] = q.type === "noul"
            ? { type: "noul", noul: text.includes("[gate]") ? 0.05 : 0.98 }
            : { type: "score", score: text.includes("[up]") ? 3.8 : text.includes("[down]") ? 0.4 : 2 };
        }
        return { answers, usage: { input_tokens: 100, output_tokens: 0 } };
      }
      const raw = opts?.returnRawResponse;
      if (input.tools?.length) {
        // ponytail: ids are matched from the rendered <shortlist> JSON lines
        const list = text.match(/<shortlist>([\s\S]*?)<\/shortlist>/)?.[1].split("\\n") ?? [];
        const ids = list.flatMap((l) => (l.match(/"id\\?":(\d+)/) ? [Number(l.match(/"id\\?":(\d+)/)![1])] : []));
        if (text.includes("[nopick]") || !ids.length) {
          const r = [chunk({ role: "assistant", content: "Nothing to read." }), chunk({}, "stop")];
          return raw ? sse(r) : { response: "Nothing to read." };
        }
        const calls = ids.map((id, index) => ({
          index, id: `call_${id}`, type: "function", function: { name: "read_story", arguments: JSON.stringify({ story_id: id }) },
        }));
        return sse([chunk({ role: "assistant", tool_calls: calls }), chunk({}, "tool_calls")]);
      }
      const write = text.includes("[badjson]")
        ? "{not json"
        : JSON.stringify({ headline: "Acme eleva su previsión de ingresos", summary: "Acme ha elevado su previsión de ingresos para el año, según un comunicado de la empresa.", why_it_matters: "Acme gana margen en la nube.", subject: "Acme" });
      return raw ? sse([chunk({ role: "assistant", content: write }), chunk({}, "stop")]) : { response: write };
    },
  };
}

function fakeFetch(o: Base, log: (kind: string, target: string) => void) {
  return async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    log("fetch", url);
    const rule = o.ctx.storage.sql
      .exec<{ status: number }>("SELECT status FROM fake_rules WHERE ? LIKE '%' || pattern || '%' LIMIT 1", url)
      .toArray()[0];
    if (rule) return new Response("fake failure", { status: rule.status });
    const quiet = Object.entries(QUIET_FEEDS).find(([p]) => url.startsWith(p))?.[1];
    const body = FEEDS[url] ?? ARTICLES[url] ?? READ_STORY_ARTICLES[url] ?? quiet;
    if (body === undefined) throw new Error(`fakeFetch: unknown URL ${url}`);
    return new Response(body, { headers: { "content-type": url.endsWith(".json") ? "application/json" : "text/html" } });
  };
}

const fakeNow = (o: Base) => () =>
  o.ctx.storage.sql.exec<{ ms: number }>("SELECT ms FROM fake_now LIMIT 1").toArray()[0]?.ms ?? Date.now();

export class Signal extends Base {
  io() {
    this.ctx.storage.sql.exec(SCHEMA);
    // One id per io() call, shared by the three fakes: the dispatch their calls are logged under.
    const dispatch = crypto.randomUUID();
    const log = (kind: string, target: string) =>
      this.ctx.storage.sql.exec("INSERT INTO fake_calls VALUES (?, ?, ?)", dispatch, kind, target);
    return { ai: fakeAI(this, log) as unknown as Ai, fetch: fakeFetch(this, log) as typeof fetch, now: fakeNow(this), secrets: {}, chunkDelayMs: 5, pollDelayMs: 50 };
  }

  /** Rule `crash:<phase>` aborts the object, `throw:<phase>` throws, inside that phase's dispatch. Logged first. */
  async dailyStep(date: string, io: Io) {
    const sql = this.ctx.storage.sql;
    const phase = sql.exec<{ phase: string }>("SELECT phase FROM digests WHERE date = ?", date).one().phase;
    const rule = sql
      .exec<{ pattern: string }>("SELECT pattern FROM fake_rules WHERE pattern IN (?, ?)", `crash:${phase}`, `throw:${phase}`)
      .toArray()[0]?.pattern;
    if (rule) {
      sql.exec("INSERT INTO fake_calls VALUES ('hook', ?, ?)", rule.split(":")[0], phase);
      await this.ctx.storage.sync();
      if (rule.startsWith("crash")) this.ctx.abort("fake crash");
      throw new Error("fake dispatch failure");
    }
    return super.dailyStep(date, io);
  }

  /** Rule `crash:read_story` aborts the object once, after the write-up is stored. The rule is deleted first. */
  async readStory(id: number) {
    const r = await super.readStory(id);
    const sql = this.ctx.storage.sql;
    if (sql.exec("DELETE FROM fake_rules WHERE pattern = 'crash:read_story' RETURNING pattern").toArray().length) {
      sql.exec("INSERT INTO fake_calls VALUES ('hook', 'crash', 'read_story')");
      await this.ctx.storage.sync();
      this.ctx.abort("fake crash");
    }
    return r;
  }

  /** Test-only RPC: runs one fake and returns JSON, so a test can exercise io() from outside. */
  async callFake(kind: string, args: any) {
    const io = this.io();
    try {
      if (kind === "now") return { now: io.now() };
      if (kind === "article" || kind === "read_story") {
        const budget = createBudget(io.fetch);
        budget.used = args.used ?? 0;
        if (kind === "article") return (await getArticleText(budget.fetch, args)) ?? { basis: null };
        const ai = createAI({ binding: budget.countAI(io.ai) });
        const r = await readStoryTool(() => ({ sql: this.ctx.storage.sql, budget, ai: ai as any })).execute({ story_id: args.id }, null as any, null as any);
        return { result: JSON.parse((r.output as any)[0].text), control: r.control, usage: r.usage, used: budget.used };
      }
      if (kind === "fetch") return { status: (await io.fetch(args)).status };
      return await io.ai.run(args.model ?? "@cf/cloudflare/clef", args);
    } catch (e) {
      return { error: String(e) };
    }
  }
}

export default {
  scheduled: app.scheduled,
  async fetch(req: Request, env: Env) {
    const { kind, args } = (await req.json()) as any;
    return Response.json(await (env.SIGNAL.getByName("signal") as any).callFake(kind, args));
  },
} satisfies ExportedHandler<Env>;
