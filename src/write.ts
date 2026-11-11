// The write phase (docs/spec.md, Write phase): one pi run per chunk, submitted by a job dispatch and polled by later ones.
// Every step is re-derived from `digests` and `stories`, so a crashed dispatch just runs again.
import type { PiHarness, PiOperationResult } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";

import type { Deps } from "./daily-run.ts";
import { orchestratorUser, type ShortlistRow, type WrittenRow } from "./prompts.ts";
import { GLM, readStory } from "./read-story.ts";
import { neurons } from "./budget.ts";

const MAX_CHUNKS = 6;
/** What the write phase needs from the host: the harness, and where the next pi run's budget goes. */
export type WriteHost = { harness: PiHarness; setRunBudget(d: Pick<Deps, "budget" | "ai">): void };
type Row = { session_id: string | null; write_chunk: number; write_failed: number; chunk_reads: number; chunk_stop: string | null };

/** Rendered order: earnings; Strong move Positions by score; other Markets by score; Tech by score. */
const shortlist = (sql: SqlStorage, date: string) =>
  sql.exec<ShortlistRow>(
    `SELECT s.id, s.section, s.ticker, s.kind, s.signal_score AS score, s.feed_heading AS heading, p.name, q.change_pct, q.strong_move
     FROM stories s LEFT JOIN positions p ON p.ticker = s.ticker
     LEFT JOIN position_quotes q ON q.digest_date = s.digest_date AND q.ticker = s.ticker
     WHERE s.digest_date = ? AND s.status = 'shortlist'
     ORDER BY s.kind = 'earnings' DESC, COALESCE(q.strong_move, 0) DESC, s.section = 'markets' DESC, s.signal_score DESC, s.id`,
    date,
  ).toArray();
const written = (sql: SqlStorage, date: string) =>
  sql.exec<WrittenRow>("SELECT section, ticker, headline FROM stories WHERE digest_date = ? AND status = 'written' ORDER BY id", date).toArray();
const opId = (date: string, r: Row) => `digest-${date}-w${r.write_chunk}${r.write_failed ? "-r" : ""}`;
const update = (sql: SqlStorage, date: string, set: string) => sql.exec(`UPDATE digests SET ${set} WHERE date = ?`, date);

/** One write dispatch. "poll" while a run is in flight, "next" to run again soon, "publish" when the phase is over. */
export async function writeStep(d: Deps, date: string, host: WriteHost): Promise<"poll" | "next" | "publish"> {
  const { sql } = d;
  let r = sql.exec<Row>("SELECT session_id, write_chunk, write_failed, chunk_reads, chunk_stop FROM digests WHERE date = ?", date).one();
  if (r.write_failed >= 2) return codeReads(d, date, false);
  if (!r.session_id) {
    if (!shortlist(sql, date).length) return "publish";
    const { id } = await host.harness.sessions.create();
    sql.exec("UPDATE digests SET session_id = ?, write_chunk = 1 WHERE date = ?", id, date);
    r = { ...r, session_id: id, write_chunk: 1 };
  }
  const session = host.harness.sessions.get(r.session_id!);
  const op = opId(date, r);
  const pending = (await host.harness.pending({ session: session.id })).find((p) => p.operationId === op);
  if (pending?.status === "parked") {
    await session.abort();
    return settle(d, date, host, r, { operationId: op, session: session.id, status: "unanswered", reason: "parked" });
  }
  if (pending) return "poll";

  // Not pending: never submitted, or settled. submit() is idempotent by operationId, so it tells the two apart.
  // The run's budget is replaced only for a new submission, never by a poll.
  host.setRunBudget(d);
  if ((await session.submit(orchestratorUser(shortlist(sql, date), written(sql, date)), { operationId: op })).accepted) return "poll";
  const result = await session.wait(op, AbortSignal.timeout(3000)).catch((e) => {
    if ((e as Error)?.name === "TimeoutError") return null;
    throw e;
  });
  return result ? settle(d, date, host, r, result) : "poll";
}

async function settle(d: Deps, date: string, host: WriteHost, r: Row, result: PiOperationResult) {
  const { sql } = d;
  const session = host.harness.sessions.get(r.session_id!);
  logUsage(sql, date, await session.messages());  // ponytail: a crash between logUsage and the update below counts this chunk's usage twice; the 9,000 guard has room.
  const failed = result.status === "unanswered" || r.chunk_reads === 0;
  if (failed && r.write_failed === 0) {
    await session.reset();
    update(sql, date, "write_failed = 1, chunk_reads = 0, chunk_stop = NULL");
    return "next";
  }
  if (failed && (r.write_chunk === 1 || result.status === "unanswered")) {
    update(sql, date, "write_failed = 2");
    return codeReads(d, date, false);
  }
  if (!failed && r.chunk_stop === "budget" && r.write_chunk < MAX_CHUNKS && shortlist(sql, date).length) {
    await session.reset();
    update(sql, date, "write_chunk = write_chunk + 1, write_failed = 0, chunk_reads = 0, chunk_stop = NULL");
    return "next";
  }
  return codeReads(d, date, true);
}

/** Orchestrator usage from the chunk's assistant messages. An interrupted stream reports zero (S11). */
function logUsage(sql: SqlStorage, date: string, entries: { model?: readonly any[] }[]) {
  const msgs = entries.flatMap((e) => e.model ?? []).filter((m) => m.role === "assistant" && m.usage);
  if (!msgs.length) return;
  const input = msgs.reduce((n, m) => n + m.usage.input, 0);
  const output = msgs.reduce((n, m) => n + m.usage.output, 0);
  sql.exec(
    `INSERT INTO usage_log (digest_date, phase, model, calls, input_tokens, output_tokens, neurons) VALUES (?, 'orchestrator', ?, ?, ?, ?, ?)
     ON CONFLICT (digest_date, phase, model) DO UPDATE SET calls = calls + excluded.calls, input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens, neurons = neurons + excluded.neurons`,
    date, GLM, msgs.length, input, output, neurons(GLM, input, output),
  );
}

/**
 * Code reads: read_story's body called down the rendered order, within the rules' limits, until the budget guard stops it.
 * `earningsOnly` is the read before publish; otherwise this is the fallback after a chunk failed twice.
 */
async function codeReads(d: Deps, date: string, earningsOnly: boolean): Promise<"next" | "publish"> {
  const { sql } = d;
  sql.exec("UPDATE digests SET chunk_stop = NULL WHERE date = ? AND chunk_stop = 'budget'", date); // a fresh dispatch, a fresh budget
  const deps = { sql, budget: d.budget, ai: createAI({ binding: d.ai as Ai }) };
  const done = written(sql, date);
  const count = (t: string | null) => done.filter((w) => (t ? w.ticker === t : w.section === "tech")).length;
  for (const s of shortlist(sql, date)) {
    if (earningsOnly && s.kind !== "earnings") continue;
    if (s.kind !== "earnings" && count(s.ticker) >= (s.ticker ? (s.strong_move ? 6 : 3) : 20)) continue;
    const res = await readStory(deps, s.id).catch((e) => {
      if (!/write_up_invalid/.test(String(e))) throw e;
      return null;
    });
    const status = res && JSON.parse(res.output[0].text).status;
    // ponytail: the read before publish gets one dispatch; past ~8 earnings Stories the rest wait for no one.
    if (status === "chunk_budget_spent") return earningsOnly ? "publish" : "next";
    if (status === "written") done.push({ section: s.section, ticker: s.ticker, headline: "" });
  }
  return "publish";
}
