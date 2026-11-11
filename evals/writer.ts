// Writer eval: real GLM calls via the eval worker's POST /write, on a fixed set of voted Stories. The owner reads the report; there is no judge.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { neurons } from "../src/budget.ts";
import { parseInterests } from "../src/interests.ts";
import { writerSystem, writerUser, WRITER_SYSTEM, type WriterInput } from "../src/prompts.ts";
import { GLM } from "../src/read-story.ts";
import type { WriteUp } from "../src/writer.ts";
import { addSpend, allowance, PRIVATE, readCases, spentToday, workerPost, type Post, type Row } from "./lib.ts";

const QUOTA = { tech: 5, markets: 3, earnings: 2 };
const bucket = (s: Row): keyof typeof QUOTA => (s.kind === "earnings" ? "earnings" : s.section);

/** The 10 newest voted Stories as 5 Tech, 3 Markets, 2 earnings; a short bucket is filled with the next newest. */
export function pickWriterSet(stories: Row[]): number[] {
  const voted = stories.filter((s) => s.vote === 1 || s.vote === -1).toSorted((a, b) => b.digest_date.localeCompare(a.digest_date) || b.id - a.id);
  const left = { ...QUOTA };
  const picked = voted.filter((s) => left[bucket(s)]-- > 0);
  const rest = voted.filter((s) => !picked.includes(s));
  return [...picked, ...rest].slice(0, 10).map((s) => s.id);
}

type Result = ({ ok: WriteUp } | { error: string }) & { usage: { input: number; output: number; calls: number } };

/** Why a case fails, or null: no valid WriteUp within 2 calls, or a Headline under 3 words. */
export function writerFail(r: Result) {
  if ("error" in r) return r.error;
  return r.ok.headline.trim().split(/\s+/).length < 3 ? "headline under 3 words" : null;
}

export async function run(o: { dir: string; post: Post; now: () => Date }) {
  const { dir } = o;
  const { stories, interests } = readCases(dir);
  const setFile = join(dir, "writer-set.json");
  if (!existsSync(setFile)) writeFileSync(setFile, JSON.stringify(pickWriterSet(stories)));
  mkdirSync(join(dir, "articles"), { recursive: true });
  mkdirSync(join(dir, "runs"), { recursive: true });
  const cases: { id: number; heading: string; start: string; result?: Result; fail: string | null; first: boolean }[] = [];
  let neuronTotal = 0, stopped: string | null = null;

  for (const id of JSON.parse(readFileSync(setFile, "utf8")) as number[]) {
    const s = stories.find((s) => s.id === id);
    const snapshot = s && interests.get(s.digest_date);
    if (!s || snapshot === undefined) { cases.push({ id, heading: "?", start: "", fail: "no story or interests snapshot", first: false }); continue; }

    // The Article is saved once, so reruns compare the prompt and not a changed page.
    const file = join(dir, "articles", `${id}.txt`);
    let text = s.write_basis === "snippet" ? s.feed_snippet : existsSync(file) ? readFileSync(file, "utf8") : null;
    if (text === null) {
      const a = await o.post("/article", { kind: s.kind, article_url: s.article_url, feed_snippet: s.feed_snippet });
      text = a?.text ?? null;
      if (text !== null) writeFileSync(file, text);
    }
    if (text === null) { cases.push({ id, heading: s.feed_heading, start: "", fail: "Article could not be fetched", first: false }); continue; }

    const { topics, positions } = parseInterests(snapshot);
    const pos = positions.find((p) => p.ticker === s.ticker);
    const input: WriterInput = {
      section: s.section, kind: s.kind, basis: s.write_basis === "snippet" ? "snippet" : "article", heading: s.feed_heading, text,
      topics: topics.map((t) => t.name), position: s.section === "markets" ? `${s.ticker} · ${pos?.name ?? s.ticker}` : undefined,
      changePct: null, // the export carries strong_move but not change_pct
    };
    stopped = allowance(o.now(), spentToday(dir, o.now()));
    if (stopped) break;
    const user = writerUser(input);
    const result: Result = await o.post("/write", { system: writerSystem(input), user, section: s.section, sent: user, isEarnings: s.kind === "earnings" && input.basis === "article" });
    const n = neurons(GLM, result.usage.input, result.usage.output);
    addSpend(dir, o.now(), n);
    neuronTotal += n;
    cases.push({ id, heading: s.feed_heading, start: text.slice(0, 200), result, fail: writerFail(result), first: result.usage.calls === 1 && !("error" in result) });
  }

  const ran = cases.filter((c) => c.result);
  const mean = ran.length ? neuronTotal / ran.length : 0;
  const fails = cases.filter((c) => c.fail).length + (mean > 50 ? 1 : 0);
  const version = createHash("sha1").update(WRITER_SYSTEM + GLM).digest("hex").slice(0, 7);
  const stamp = o.now().toISOString().replace(/[:.]/g, "-");
  const prev = readdirSync(join(dir, "runs")).filter((f) => f.endsWith(".json")).sort().at(-1);
  const before: Record<number, any> = prev ? Object.fromEntries(JSON.parse(readFileSync(join(dir, "runs", prev), "utf8")).map((c: any) => [c.id, c])) : {};
  const view = cases.map((c) => ({ id: c.id, fail: c.fail, ...(c.result && "ok" in c.result ? c.result.ok : {}) }));
  const md = [
    `# Writer eval ${stamp} (${version})`,
    `mean neurons per case ${mean.toFixed(1)} (fail over 50), first-try valid ${ran.filter((c) => c.first).length}/${ran.length}${stopped ? `, stopped: ${stopped}` : ""}`,
    ...cases.map((c) => {
      const p = before[c.id];
      const w: any = c.result && "ok" in c.result ? c.result.ok : null;
      return [
        `\n## ${c.id} ${c.fail ? `FAIL: ${c.fail}` : "ok"}`, `Article start: ${c.start}`,
        `| | now | previous |`, `|---|---|---|`,
        ...(["headline", "summary", "why_it_matters"] as const).map((k) => `| ${k} | ${w?.[k] ?? ""} | ${p?.[k] ?? ""} |`),
      ].join("\n");
    }),
  ].join("\n");
  writeFileSync(join(dir, "runs", `${stamp}-${version}.md`), md);
  writeFileSync(join(dir, "runs", `${stamp}-${version}.json`), JSON.stringify(view));
  return { code: fails ? 1 : 0, out: md };
}

if (import.meta.main) {
  const { code, out } = await run({ dir: PRIVATE, post: workerPost, now: () => new Date() });
  console.log(out);
  process.exit(code);
}
