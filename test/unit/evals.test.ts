import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SCORER } from "../../src/scorer.ts";
import { allowance, metrics, readCases, record, replay, spentToday } from "../../evals/lib.ts";
import { pickWriterSet, writerFail } from "../../evals/writer.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "evals-"));
const jl = (dir: string, f: string, rows: object[]) => writeFileSync(join(dir, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const at = (h: number) => new Date(Date.UTC(2026, 10, 3, h, 0));

test("metrics: pairAuc counts ties half, upLost and downCaught use passes", () => {
  const items = [
    { vote: 1 as const, date: "d", score: 80, passes: true },
    { vote: 1 as const, date: "d", score: 40, passes: false },
    { vote: -1 as const, date: "d", score: 40, passes: false },
    { vote: -1 as const, date: "d", score: 20, passes: false },
  ];
  const m = metrics(items);
  expect(m.pairAuc).toBe((1 + 1 + 0.5 + 1) / 4);
  expect(m.upLost).toBe(0.5);
  expect(m.downCaught).toBe(1);
  expect(m.p10).toBeNull(); // no day has more than 10 votes
});

test("metrics: p@10 averages the Upvote share in the top 10 of days with more than 10 votes", () => {
  // day a: 12 votes, the top 5 are up, the 7 below are down -> 5 up in the top 10 -> 0.5
  // day b: the top 10 are 9 up and 1 down -> 0.9
  const a = Array.from({ length: 12 }, (_, i) => ({ vote: (i < 5 ? 1 : -1) as 1 | -1, date: "a", score: 100 - i, passes: true }));
  const b = Array.from({ length: 12 }, (_, i) => ({ vote: (i === 3 || i > 9 ? -1 : 1) as 1 | -1, date: "b", score: 100 - i, passes: true }));
  expect(metrics([...a, ...b]).p10).toBeCloseTo(0.7);
});

test("allowance: nothing before 08:00 UTC, nothing at the 3,000 cap", () => {
  expect(allowance(at(7), 0)).toMatch(/08:00/);
  expect(allowance(at(8), 2999)).toBeNull();
  expect(allowance(at(8), 3000)).toMatch(/3,000/);
});

test("spentToday sums only today's UTC date", () => {
  const dir = tmp();
  jl(dir, "spend.jsonl", [{ utc_date: "2026-11-03", neurons: 100 }, { utc_date: "2026-11-03", neurons: 50 }, { utc_date: "2026-11-02", neurons: 999 }]);
  expect(spentToday(dir, at(9))).toBe(150);
});

test("readCases: newest export wins per id, first interests snapshot is kept", () => {
  const dir = tmp();
  jl(dir, "export-2026-11-01.jsonl", [{ type: "interests", date: "2026-10-30", interests: "old" }, { type: "story", id: 1, vote: 1 }]);
  jl(dir, "export-2026-11-02.jsonl", [{ type: "interests", date: "2026-10-30", interests: "new" }, { type: "story", id: 1, vote: -1 }]);
  const c = readCases(dir);
  expect(c.stories.map((s: any) => s.vote)).toEqual([-1]);
  expect(c.interests.get("2026-10-30")).toBe("old");
});

// Synthetic cases: per Section, n Upvotes with high answers and n Downvotes with low ones.
function fixture(dir: string, sections = ["tech", "markets"], n = 15) {
  const rows: any[] = [];
  const answers: any[] = [];
  let id = 0;
  for (const section of sections) {
    for (const vote of [1, -1]) {
      for (let i = 0; i < n; i++) {
        id++;
        rows.push({ type: "story", id, digest_date: "2026-11-03", section, kind: "news", feed: "f", ticker: "ZZZT", strong_move: false, feed_heading: "h", feed_snippet: "s", vote, clef_answers: {} });
        const hi = vote === 1;
        answers.push({
          story_id: id, answers_key: "q1", input_tokens: 1000, ms: 100 + id,
          answers: section === "tech"
            ? { relevance: { score: hi ? 4 : 0 }, substance: { score: hi ? 4 : 1 }, is_news: { noul: 0.9 } }
            : { materiality: { score: hi ? 4 : 0 }, substance: { score: hi ? 4 : 1 } },
        });
      }
    }
  }
  jl(dir, "export-2026-11-04.jsonl", [{ type: "interests", date: "2026-11-03", interests: "## Topics\n- high: ai" }, ...rows]);
  jl(dir, "answers.jsonl", answers);
}

test("replay: same scorer as baseline passes with 0 and prints per-Section tables", () => {
  const dir = tmp();
  fixture(dir);
  const r = replay(dir, SCORER, SCORER);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/tech/);
  expect(r.out).toMatch(/markets/);
  expect(r.out).toMatch(/pairAuc/);
});

test("replay: a candidate that loses Upvotes fails with 1", () => {
  const dir = tmp();
  fixture(dir);
  const strict = structuredClone(SCORER);
  strict.tech.threshold = 101;
  expect(replay(dir, strict, SCORER).code).toBe(1);
});

test("replay: a candidate over 5,000 neurons a day fails with 1", () => {
  const dir = tmp();
  fixture(dir);
  const rows = readFileSync(join(dir, "answers.jsonl"), "utf8").trim().split("\n").map((l) => ({ ...JSON.parse(l), input_tokens: 2000 }));
  jl(dir, "answers.jsonl", rows); // 2000 tokens * 21.818/M = 43.6 per call, over 210 calls
  expect(replay(dir, SCORER, SCORER).code).toBe(1);
});

test("replay: missing answers for the candidate's q exits 2 with count and estimate", () => {
  const dir = tmp();
  fixture(dir);
  const q2 = structuredClone(SCORER);
  q2.version = "q2.w1";
  const r = replay(dir, q2, SCORER);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/60 cases/);
  expect(r.out).toMatch(/eval:record/);
});

test("replay: with too few votes no Section gates and it exits 2", () => {
  const dir = tmp();
  fixture(dir, ["tech"], 5);
  const r = replay(dir, SCORER, SCORER);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/insufficient/);
});

test("record: no call before 08:00 UTC", async () => {
  const dir = tmp();
  fixture(dir);
  writeFileSync(join(dir, "answers.jsonl"), "");
  let calls = 0;
  const r = await record({ dir, scorer: SCORER, now: () => at(7), post: async () => (calls++, {}) });
  expect(calls).toBe(0);
  expect(r.stopped).toMatch(/08:00/);
});

test("record: appends answers and spend, stops cleanly at 3,000 neurons", async () => {
  const dir = tmp();
  fixture(dir, ["tech", "markets"], 40);
  writeFileSync(join(dir, "answers.jsonl"), "");
  let calls = 0;
  const post = async () => (calls++, { answers: { x: 1 }, usage: { input_tokens: 1000 } }); // 21.818 neurons a call
  const r = await record({ dir, scorer: SCORER, now: () => at(9), post });
  expect(r.stopped).toMatch(/3,000/);
  expect(calls).toBe(138); // 137 calls = 2,989; the 138th crosses the cap; the 139th is refused
  expect(readFileSync(join(dir, "answers.jsonl"), "utf8").trim().split("\n")).toHaveLength(138);
  expect(spentToday(dir, at(9))).toBeCloseTo(138 * 21.818);
});

test("record: skips a case without an interests snapshot and counts it", async () => {
  const dir = tmp();
  jl(dir, "export-2026-11-04.jsonl", [{ type: "story", id: 1, digest_date: "2026-11-03", section: "tech", kind: "news", feed_heading: "h", feed_snippet: "s", vote: 1, clef_answers: {} }]);
  appendFileSync(join(dir, "answers.jsonl"), "");
  let calls = 0;
  const r = await record({ dir, scorer: SCORER, now: () => at(9), post: async () => (calls++, {}) });
  expect(calls).toBe(0);
  expect(r.skipped).toBe(1);
});

test("writer set: 5 tech, 3 markets, 2 earnings, newest first, shortfall filled by the nearest", () => {
  const mk = (id: number, section: string, kind = "news") => ({ id, section, kind, digest_date: `2026-11-${String((id % 28) + 1).padStart(2, "0")}`, vote: 1 });
  const all = [...Array.from({ length: 8 }, (_, i) => mk(i + 1, "tech")), ...Array.from({ length: 2 }, (_, i) => mk(i + 20, "markets")), mk(40, "markets", "earnings")];
  const ids = pickWriterSet(all as any);
  expect(ids).toHaveLength(10);
  expect(new Set(ids).size).toBe(10);
  expect(ids).toContain(40);
  expect(ids.filter((i) => i >= 20 && i < 30)).toHaveLength(2);
});

test("writer fail: a Headline under 3 words, or no valid WriteUp", () => {
  expect(writerFail({ ok: { headline: "Meta despide" } } as any)).toMatch(/3 words/);
  expect(writerFail({ error: "bad" } as any)).toBe("bad");
  expect(writerFail({ ok: { headline: "Meta despide a 3.000" } } as any)).toBeNull();
});
