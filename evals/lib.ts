// Eval plumbing: case reader, metrics, replay, recording, neuron allowance. Node only; reads evals/private/ (docs/spec.md, Tests and evals).
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neurons } from "../src/budget.ts";
import { CLEF, SCORER, signalScore } from "../src/scorer.ts";

type Scorer = typeof SCORER;
type Section = "tech" | "markets";
export type Row = Record<string, any>;
export type Item = { vote: 1 | -1; date: string; score: number; passes: boolean };

export const PRIVATE = "evals/private";
const CAP = 3000;
const readJsonl = (file: string): Row[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
export const append = (file: string, row: object) => appendFileSync(file, JSON.stringify(row) + "\n");

/** All export-*.jsonl, oldest first: the newest row wins per id, the first `interests` line per date is never overwritten. */
export function readCases(dir: string) {
  const stories = new Map<number, Row>();
  const interests = new Map<string, string>();
  for (const f of (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^export-.*\.jsonl$/.test(f)).sort())
    for (const r of readJsonl(join(dir, f))) {
      if (r.type === "interests") interests.has(r.date) || interests.set(r.date, r.interests);
      else if (r.type === "story") stories.set(r.id, r);
    }
  return { stories: [...stories.values()], interests };
}

/** Voted Tech and Markets news with Clef answers; earnings and unlabelled Stories are not scorable. */
const scorable = (stories: Row[]) => stories.filter((s) => (s.vote === 1 || s.vote === -1) && s.kind !== "earnings" && s.clef_answers);

export const qOf = (s: Scorer) => s.version.split(".")[0]!;
const answersOf = (dir: string) => new Map(readJsonl(join(dir, "answers.jsonl")).map((a) => [`${a.story_id}:${a.answers_key}`, a]));

/** The Clef call exactly as production makes it. */
export const clefState = (s: Row, interests: string, scorer: Scorer) => ({
  interests,
  story: { heading: s.feed_heading, snippet: s.feed_snippet.slice(0, scorer.snippetChars), feed: s.feed, ticker: s.ticker },
});

export function metrics(items: Item[]) {
  const up = items.filter((i) => i.vote === 1), down = items.filter((i) => i.vote === -1);
  let wins = 0;
  for (const u of up) for (const d of down) wins += u.score > d.score ? 1 : u.score === d.score ? 0.5 : 0;
  const share = (xs: Item[], f: (i: Item) => boolean) => (xs.length ? xs.filter(f).length / xs.length : null);
  const byDay = new Map<string, Item[]>();
  for (const i of items) byDay.set(i.date, [...(byDay.get(i.date) ?? []), i]);
  const shares = [...byDay.values()].filter((d) => d.length > 10).map((d) => d.toSorted((a, b) => b.score - a.score).slice(0, 10).filter((i) => i.vote === 1).length / 10);
  return {
    up: up.length, down: down.length,
    pairAuc: up.length && down.length ? wins / (up.length * down.length) : null,
    upLost: share(up, (i) => !i.passes),
    downCaught: share(down, (i) => !i.passes),
    p10: shares.length ? shares.reduce((a, b) => a + b) / shares.length : null,
  };
}
type Metrics = ReturnType<typeof metrics>;

const items = (cases: Row[], answers: Map<string, Row>, scorer: Scorer, section: Section): Item[] =>
  cases.filter((s) => s.section === section).map((s) => {
    const a = answers.get(`${s.id}:${qOf(scorer)}`)!.answers;
    let r = { score: 0, passes: false };
    try { r = signalScore(scorer, section, a, !!s.strong_move); } catch { /* malformed: counts as below */ }
    return { vote: s.vote, date: s.digest_date, score: r.score, passes: r.passes };
  });

/** Mean recorded input_tokens at the Clef rate, for 100 Tech and 110 Markets Stories a day. */
function neuronsPerDay(cases: Row[], answers: Map<string, Row>, scorer: Scorer) {
  const mean = (section: Section) => {
    const t = cases.filter((s) => s.section === section).map((s) => answers.get(`${s.id}:${qOf(scorer)}`)!.input_tokens ?? 0);
    return t.length ? t.reduce((a, b) => a + b) / t.length : 0;
  };
  return neurons(CLEF, mean("tech") * 100 + mean("markets") * 110, 0);
}

const f = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));
const row = (label: string, m: Metrics) => `  ${label.padEnd(10)} pairAuc ${f(m.pairAuc)}  upLost ${f(m.upLost)}  downCaught ${f(m.downCaught)}  p@10 ${f(m.p10)}`;
const gates = (m: Metrics) => m.up + m.down >= 30 && m.up >= 10 && m.down >= 10;
const SECTIONS: Section[] = ["tech", "markets"];

/** Cases lacking recorded answers for any of these Scorers, with a message for exit 2, or null. */
function missing(cases: Row[], answers: Map<string, Row>, scorers: Scorer[]) {
  const keys = [...new Set(scorers.map(qOf))];
  const n = cases.filter((s) => keys.some((k) => !answers.has(`${s.id}:${k}`))).length;
  if (!n) return null;
  const est = cases.reduce((t, s) => t + (s.section === "tech" ? 22 : 19), 0);
  return `${n} cases have no recorded answers for ${keys.join(", ")}. Run npm run eval:record (about ${est} neurons for all of them).`;
}

/** Replay at 0 neurons. Exit code: 0 pass, 1 fail, 2 insufficient or missing answers. */
export function replay(dir: string, candidate: Scorer, baseline: Scorer) {
  const cases = scorable(readCases(dir).stories);
  const answers = answersOf(dir);
  const gap = missing(cases, answers, [candidate, baseline]);
  if (gap) return { code: 2, out: gap };
  const out: string[] = [];
  let gating = 0, ok = true;
  for (const section of SECTIONS) {
    const c = metrics(items(cases, answers, candidate, section)), b = metrics(items(cases, answers, baseline, section));
    const gate = gates(c);
    out.push(`${section}: ${c.up} up, ${c.down} down${gate ? "" : " (not enough votes, does not gate)"}`, row("candidate", c), row("baseline", b));
    if (gate) {
      gating++;
      if (!(c.pairAuc! >= b.pairAuc! - 0.01 && c.upLost! <= b.upLost!)) ok = false;
    }
  }
  const cn = neuronsPerDay(cases, answers, candidate), bn = neuronsPerDay(cases, answers, baseline);
  out.push(`neuronsPerDay: candidate ${cn.toFixed(0)}, baseline ${bn.toFixed(0)} (gate 5000)`);
  if (cn > 5000) ok = false;
  if (!gating) return { code: 2, out: [...out, "insufficient: no Section has 30 votes with at least 10 of each kind"].join("\n") };
  return { code: ok ? 0 : 1, out: [...out, ok ? "pass" : "fail"].join("\n") };
}

/** Same table over thresholds 40-75 and first-question weights 0.5-0.8. Exit 2 if answers are missing. */
export function sweep(dir: string, scorer: Scorer) {
  const cases = scorable(readCases(dir).stories);
  const answers = answersOf(dir);
  const gap = missing(cases, answers, [scorer]);
  if (gap) return { code: 2, out: gap };
  const out: string[] = [];
  for (const section of SECTIONS) {
    out.push(`${section}:`);
    for (let t = 40; t <= 75; t += 5)
      for (const w of [0.5, 0.6, 0.7, 0.8]) {
        const s = structuredClone(scorer);
        const [first, second] = Object.keys(s[section].weights);
        (s[section] as any).threshold = t;
        (s[section] as any).weights = { [first!]: w, [second!]: +(1 - w).toFixed(1) };
        out.push(row(`t${t} w${w}`, metrics(items(cases, answers, s, section))));
      }
  }
  return { code: 0, out: out.join("\n") };
}

/** Why no model call may be made now, or null. */
export function allowance(now: Date, spent: number) {
  if (now.getUTCHours() < 8) return "no model call before 08:00 UTC: the Daily Run may still be running";
  if (spent >= CAP) return "the 3,000 neurons allowance for this UTC day is spent";
  return null;
}

export const spentToday = (dir: string, now: Date) =>
  readJsonl(join(dir, "spend.jsonl")).filter((r) => r.utc_date === now.toISOString().slice(0, 10)).reduce((t, r) => t + r.neurons, 0);

export const addSpend = (dir: string, now: Date, n: number) => append(join(dir, "spend.jsonl"), { utc_date: now.toISOString().slice(0, 10), neurons: n });

export type Post = (path: string, body: object) => Promise<any>;

/** Records Clef answers for cases that lack them, one call at a time, appending as each arrives. Stops cleanly at the allowance. */
export async function record(o: { dir: string; scorer: Scorer; post: Post; now: () => Date }) {
  const { stories, interests } = readCases(o.dir);
  const cases = scorable(stories);
  const key = qOf(o.scorer);
  const have = answersOf(o.dir);
  let recorded = 0, skipped = 0, stopped: string | null = null;
  for (const s of cases.filter((s) => !have.has(`${s.id}:${key}`))) {
    const snapshot = interests.get(s.digest_date);
    if (snapshot === undefined) { skipped++; continue; }
    stopped = allowance(o.now(), spentToday(o.dir, o.now()));
    if (stopped) break;
    const t0 = Date.now();
    const { answers, usage } = await o.post("/clef", { state: clefState(s, snapshot, o.scorer), questions: o.scorer[s.section as Section].questions });
    append(join(o.dir, "answers.jsonl"), { story_id: s.id, answers_key: key, answers, input_tokens: usage.input_tokens, ms: Date.now() - t0 });
    addSpend(o.dir, o.now(), neurons(CLEF, usage.input_tokens, 0));
    recorded++;
  }
  return { recorded, skipped, stopped };
}

/** p50 and p95 of recorded `ms` for a Scorer's answers key. Shown only. */
export function latency(dir: string, scorer: Scorer) {
  const ms = readJsonl(join(dir, "answers.jsonl")).filter((a) => a.answers_key === qOf(scorer)).map((a) => a.ms).sort((a, b) => a - b);
  const at = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return ms.length ? { p50: at(0.5), p95: at(0.95) } : null;
}
