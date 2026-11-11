// read_story: reads a shortlisted Story's Article and writes it up. The Article never reaches the orchestrator.
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { getArticleText } from "./article.ts";
import { logUsage, neuronGuard, READ_STORY_GUARD, type createBudget } from "./budget.ts";
import { parseInterests } from "./interests.ts";
import { afterCloseCutoff, writerSystem, writerUser } from "./prompts.ts";
import { writeUp } from "./writer.ts";
import type { Sql } from "./storage.ts";

export const GLM = "@cf/zai-org/glm-4.7-flash";
const SETTLED = ["written", "unreadable", "write_failed"];

export type ReadStoryDeps = {
  sql: Sql;
  budget: ReturnType<typeof createBudget>; // its fetch is the countedFetch
  ai: { (model: any): any; complete(model: any, ctx: any, opts?: any): Promise<any> }; // createAI over the counted binding
};

const result = (r: Record<string, unknown>, usage?: unknown) => ({
  output: [{ type: "text" as const, text: JSON.stringify(r) }],
  control: { terminate: true },
  ...(usage ? { usage: usage as any } : {}),
});

/** The tool body, exported so the driver's code fallback can call it without a model. */
export async function readStory({ sql, budget, ai }: ReadStoryDeps, id: number) {
  const q = (s: string, ...p: any[]) => sql.exec(s, ...p).toArray();
  q("UPDATE digests SET chunk_reads = chunk_reads + 1 WHERE date = (SELECT MAX(date) FROM digests)");
  const s = q("SELECT * FROM stories WHERE id = ?", id)[0];
  if (!s || !["shortlist", ...SETTLED].includes(s.status))
    throw new Error("not_on_shortlist: use a story_id from the shortlist in the user message");

  // Replay path: settled Stories answer from our tables.
  if (SETTLED.includes(s.status)) {
    return result({ story_id: id, status: s.status, ...(s.status === "written" && { basis: s.write_basis, headline: s.headline }) });
  }

  const date: string = s.digest_date;
  const stop = budget.used > READ_STORY_GUARD ? "budget" : neuronGuard(sql, date) === "neurons" ? "neurons" : null;
  if (stop) {
    q("UPDATE digests SET chunk_stop = ? WHERE date = ?", stop, date);
    return result({ story_id: id, status: "chunk_budget_spent" });
  }

  const article = await getArticleText(budget.fetch, s);
  if (!article) {
    q("UPDATE stories SET status = 'unreadable' WHERE id = ? AND status = 'shortlist'", id);
    return result({ story_id: id, status: "unreadable" });
  }

  const markets = s.section === "markets";
  const digest = q("SELECT interests FROM digests WHERE date = ?", date)[0];
  const pos = markets ? q("SELECT name FROM positions WHERE ticker = ?", s.ticker)[0] : undefined;
  const subject = markets ? `${s.ticker} · ${pos?.name ?? s.ticker}` : undefined;
  const quote = markets ? q("SELECT change_pct FROM position_quotes WHERE digest_date = ? AND ticker = ? AND strong_move = 1", date, s.ticker)[0] : undefined;
  const afterClose = s.kind === "earnings" && s.feed_published_at > afterCloseCutoff(date);
  const input = {
    section: s.section, kind: s.kind, basis: article.basis, heading: s.feed_heading, text: article.text,
    topics: parseInterests(digest?.interests ?? "").topics.map((t) => t.name),
    position: subject, changePct: quote && !afterClose ? quote.change_pct : null,
  };
  const user = writerUser(input);
  const r = await writeUp(ai, {
    model: ai(GLM), system: writerSystem(input), user, section: s.section, sent: user,
    isEarnings: s.kind === "earnings" && article.basis === "article",
  });
  logUsage(sql, date, "writer", GLM, r.usage);

  if ("error" in r) {
    q("UPDATE stories SET status = 'write_failed' WHERE id = ? AND status = 'shortlist'", id);
    throw new Error(`write_up_invalid: this Story could not be written up (${r.error}); leave it out`);
  }
  const w = r.ok;
  q(
    `UPDATE stories SET headline = ?, summary = ?, why_it_matters = ?, subject = ?, write_basis = ?, article_chars = ?, status = 'written'
     WHERE id = ? AND status = 'shortlist'`,
    w.headline, w.summary, w.why_it_matters, subject ?? w.subject, article.basis, article.basis === "article" ? article.text.length : null, id,
  );
  const usage = { input: r.usage.input, output: r.usage.output, cacheRead: 0, cacheWrite: 0, totalTokens: r.usage.input + r.usage.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return result({ story_id: id, status: "written", basis: article.basis, headline: w.headline }, usage);
}

/** `run` is the Worker's method, which builds its budget and counted AI binding per chunk. */
export const readStoryTool = (run: (id: number) => ReturnType<typeof readStory>) =>
  defineTool({
    name: "read_story",
    description:
      "Read a shortlisted Story's Article and write its Headline, Summary and Why It Matters, in Spanish. Call it once per Story you want in the Digest. Stories you do not read are left out.",
    parameters: Type.Object({
      story_id: Type.Integer({ minimum: 1, description: "A story id from the shortlist" }),
    }),
    replay: "safe",
    executionMode: "sequential",
    outputLimits: { maxBytes: 1024 },
    execute: (args) => run(args.story_id),
  });
