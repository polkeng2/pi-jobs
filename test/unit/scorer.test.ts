import { expect, test } from "vitest";
import { createBudget } from "../../src/budget.ts";
import { migrate } from "../../src/schema.ts";
import { SCORER, scoreStories, signalScore } from "../../src/scorer.ts";
import { makeSql } from "../sql.ts";

const D = "2026-11-03";
const tech = (rel: number, sub: number, news = 0.97) => ({
  relevance: { type: "score", score: rel }, substance: { type: "score", score: sub }, is_news: { type: "noul", noul: news },
});
const mkt = (m: number, s: number) => ({ materiality: { type: "score", score: m }, substance: { type: "score", score: s } });

function setup() {
  const { sql, transactionSync } = makeSql();
  migrate(sql, transactionSync);
  sql.exec("INSERT INTO digests (date, interests, started_at) VALUES (?, '## Topics', 0)", D);
  const add = (o: { section?: string; ticker?: string | null; kind?: string; status?: string } = {}) =>
    sql.exec(
      `INSERT INTO stories (digest_date, section, feed, ticker, kind, url, article_url, feed_heading, status)
       VALUES (?, ?, 'f', ?, ?, 'u', 'u', 'h' || (SELECT COALESCE(MAX(id), 0) + 1 FROM stories), ?) RETURNING id`,
      D, o.section ?? "tech", o.ticker ?? null, o.kind ?? "news", o.status ?? "new",
    ).toArray()[0].id as number;
  const row = (id: number) => sql.exec("SELECT * FROM stories WHERE id = ?", id).toArray()[0];
  const budget = createBudget(fetch);
  return { sql, add, row, budget, run: (clef: any) => scoreStories({ sql, clef, budget, now: () => 0 }, D) };
}
const sid = (state: any) => Number(state.story.heading.slice(1));
const reply = (answers: object, input_tokens = 1000) => async () => ({ answers, usage: { input_tokens } });

test("signalScore: weighted mean of levels scaled to 0-100, gate and thresholds", () => {
  // relevance 4/4 -> 100, substance 2/4 -> 50: 0.6*100 + 0.4*50
  expect(signalScore(SCORER, "tech", tech(4, 2), false)).toEqual({ score: 80, passes: true });
  expect(signalScore(SCORER, "tech", tech(4, 4, 0.1), false).passes).toBe(false); // is_news gate
  expect(signalScore(SCORER, "tech", tech(2, 2), false)).toEqual({ score: 50, passes: false }); // under 55
  // materiality 1/4 -> 25, substance 2/4 -> 50: 0.7*25 + 0.3*50 = 32.5
  expect(signalScore(SCORER, "markets", mkt(1, 2), false)).toEqual({ score: 32.5, passes: false });
  expect(signalScore(SCORER, "markets", mkt(1, 2), true).passes).toBe(false); // 32.5 < 35
  expect(signalScore(SCORER, "markets", mkt(2, 1), true).passes).toBe(true); // 0.7*50+0.3*25 = 42.5
  expect(signalScore(SCORER, "markets", mkt(2, 1), false).passes).toBe(false);
});

test("signalScore throws on a malformed answer", () => {
  expect(() => signalScore(SCORER, "tech", { ...tech(4, 4), relevance: { type: "score", score: 5 } }, false)).toThrow();
  expect(() => signalScore(SCORER, "tech", { ...tech(4, 4), is_news: { type: "noul", noul: 1.5 } }, false)).toThrow();
  expect(() => signalScore(SCORER, "markets", { materiality: { type: "score", score: 1 } }, false)).toThrow();
});

test("scores a Story: answers, score and version stored, shortlist or below, neurons logged", async () => {
  const t = setup();
  const a = t.add(), b = t.add();
  const answers = new Map([[a, tech(4, 4)], [b, tech(0, 0)]]);
  const r = await t.run(async (state: any) => ({ answers: answers.get(sid(state)), usage: { input_tokens: 1000 } }));
  expect(r).toEqual({ done: true, scored: 2, failed: 0 });
  expect(t.row(a)).toMatchObject({ status: "shortlist", signal_score: 100, scorer_version: SCORER.version });
  expect(JSON.parse(t.row(a).clef_answers)).toEqual(tech(4, 4));
  expect(t.row(b).status).toBe("below");
  const log = t.sql.exec("SELECT calls, input_tokens, neurons FROM usage_log WHERE phase = 'score'").toArray()[0];
  expect(log.calls).toBe(2);
  expect(log.input_tokens).toBe(2000);
  expect(log.neurons).toBeCloseTo(2 * 21.818, 3);
});

test("state carries interests, cut snippet, feed and ticker", async () => {
  const t = setup();
  const id = t.add({ section: "markets", ticker: "ACME" });
  t.sql.exec("UPDATE stories SET feed_snippet = ? WHERE id = ?", "x".repeat(SCORER.snippetChars + 50), id);
  let seen: any, qs: any;
  await t.run(async (state: any, q: any) => ((seen = state), (qs = q), { answers: mkt(4, 4), usage: { input_tokens: 1 } }));
  expect(seen).toEqual({ interests: "## Topics", story: { heading: `h${id}`, snippet: "x".repeat(SCORER.snippetChars), feed: "f", ticker: "ACME" } });
  expect(Object.keys(qs)).toEqual(["materiality", "substance"]);
});

test("earnings skip Clef: score 100, no answers, shortlist", async () => {
  const t = setup();
  const id = t.add({ section: "markets", ticker: "ACME", kind: "earnings" });
  let calls = 0;
  await t.run(async () => (calls++, { answers: {}, usage: { input_tokens: 1 } }));
  expect(calls).toBe(0);
  expect(t.row(id)).toMatchObject({ status: "shortlist", signal_score: 100, clef_answers: null });
});

test("a Strong move lowers the Markets threshold", async () => {
  const t = setup();
  const id = t.add({ section: "markets", ticker: "ACME" });
  t.sql.exec("INSERT INTO position_quotes (digest_date, ticker, close, change_pct, strong_move) VALUES (?, 'ACME', 1, 9, 1)", D);
  await t.run(reply(mkt(2, 1)));
  expect(t.row(id).status).toBe("shortlist");
});

test("failed or malformed call: attempts + 1, score_failed at 2, other Stories carry on", async () => {
  const t = setup();
  const bad = t.add(), ok = t.add();
  const clef = async (state: any) => {
    if (sid(state) === bad) throw new Error("boom");
    return { answers: tech(4, 4), usage: { input_tokens: 10 } };
  };
  expect(await t.run(clef)).toEqual({ done: false, scored: 1, failed: 1 }); // bad still new: not done
  expect(t.row(bad)).toMatchObject({ status: "new", score_attempts: 1 });
  expect(t.row(ok).status).toBe("shortlist");
  expect(await t.run(reply({ relevance: { type: "score", score: 9 } }))).toMatchObject({ done: true, failed: 1 });
  expect(t.row(bad)).toMatchObject({ status: "score_failed", score_attempts: 2 });
});

test("a subrequest limit is not an attempt and propagates", async () => {
  const t = setup();
  const id = t.add();
  await expect(t.run(async () => { throw new Error("Too many subrequests"); })).rejects.toThrow(/subrequests/);
  expect(t.row(id).score_attempts).toBe(0);
});

test("takes at most 40 - budget.used Stories and reports not done", async () => {
  const t = setup();
  for (let i = 0; i < 10; i++) t.add();
  t.budget.used = 35;
  const r = await t.run(reply(tech(4, 4)));
  expect(r).toEqual({ done: false, scored: 5, failed: 0 });
});

test("neuron guard: no calls and chunk_stop set when the day's neurons are spent", async () => {
  const t = setup();
  const id = t.add();
  t.sql.exec("INSERT INTO usage_log (digest_date, phase, model, neurons) VALUES (?, 'writer', 'm', 9000)", D);
  let calls = 0;
  const r = await t.run(async () => (calls++, { answers: tech(4, 4), usage: { input_tokens: 1 } }));
  expect(calls).toBe(0);
  expect(r.done).toBe(false);
  expect(t.row(id).status).toBe("new");
  expect(t.sql.exec("SELECT chunk_stop FROM digests").toArray()[0].chunk_stop).toBe("neurons");
});

test("trim: when none is new, Stories past the caps go back to below; earnings stay", async () => {
  const t = setup();
  const techIds = Array.from({ length: SCORER.tech.cap + 2 }, () => t.add());
  const m = Array.from({ length: SCORER.markets.cap + 1 }, () => t.add({ section: "markets", ticker: "ACME" }));
  const other = t.add({ section: "markets", ticker: "ZZZT" });
  const earn = t.add({ section: "markets", ticker: "ACME", kind: "earnings" });
  // The first two Tech and the first ACME score lower, so those are the ones trimmed
  const clef = async (state: any) => {
    const low = techIds.slice(0, 2).includes(sid(state)) || sid(state) === m[0];
    const lvl = low ? 3 : 4;
    return { answers: state.story.ticker ? mkt(lvl, 4) : tech(lvl, 4), usage: { input_tokens: 1 } };
  };
  await t.run(clef);
  const st = (ids: number[]) => ids.map((i) => t.row(i).status);
  expect(st(techIds).filter((s) => s === "shortlist")).toHaveLength(SCORER.tech.cap);
  expect(st(techIds.slice(0, 2))).toEqual(["below", "below"]);
  expect(t.row(m[0]!).status).toBe("below");
  expect(st(m).filter((s) => s === "shortlist")).toHaveLength(SCORER.markets.cap);
  expect(t.row(other).status).toBe("shortlist");
  expect(t.row(earn).status).toBe("shortlist");
});

test("trim: a Strong move Position keeps up to its larger cap", async () => {
  const t = setup();
  t.sql.exec("INSERT INTO position_quotes (digest_date, ticker, close, change_pct, strong_move) VALUES (?, 'ACME', 1, 9, 1)", D);
  const ids = Array.from({ length: SCORER.markets.strongCap + 2 }, () => t.add({ section: "markets", ticker: "ACME" }));
  await t.run(reply(mkt(4, 4)));
  expect(ids.filter((i) => t.row(i).status === "shortlist")).toHaveLength(SCORER.markets.strongCap);
});
