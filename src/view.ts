// Page RPC data: plain SQL on ctx.storage.sql, no pi, no fetch, no AI. Types follow docs/spec.md, RPC contracts.
import { parseInterests } from "./interests.ts";
import { SCORER } from "./scorer.ts";

type Sql = { exec(q: string, ...p: any[]): { toArray(): any[] } };

export type StoryView = {
  id: number; subject: string | null; headline: string; summary: string;
  whyItMatters: string; url: string; vote: 1 | -1 | null;
  kind: "news" | "earnings"; writeBasis: "article" | "snippet";
  consensus: { epsEstimate?: number; revenueEstimate?: number } | null;
};
export type PositionCard = {
  ticker: string; name: string; logoUrl: string | null;
  quote: { close: number; changePct: number; strongMove: boolean } | null;
  stories: StoryView[];
  newsStatus: "done" | "failed" | "pending";
};
export type DigestView = {
  date: string; status: "complete" | "partial"; notice: string | null;
  prev: string | null; next: string | null;
  tech: StoryView[];
  cards: PositionCard[];
};

const COLS = `id, subject, headline, summary, why_it_matters, url, vote, kind, write_basis, consensus`;
const story = (r: any): StoryView => ({
  id: r.id, subject: r.subject, headline: r.headline, summary: r.summary, whyItMatters: r.why_it_matters ?? "",
  url: r.url, vote: r.vote, kind: r.kind, writeBasis: r.write_basis ?? "article",
  consensus: r.consensus ? JSON.parse(r.consensus) : null,
});

export function digestView(sql: Sql, date: string | null): DigestView | null {
  const d = date
    ? sql.exec("SELECT date, status, notice, interests FROM digests WHERE date = ? AND published_at IS NOT NULL", date)
    : sql.exec("SELECT date, status, notice, interests FROM digests WHERE published_at IS NOT NULL ORDER BY date DESC LIMIT 1");
  const row = d.toArray()[0];
  if (!row) return null;
  const nearest = (op: string, dir: string) =>
    sql.exec(`SELECT date FROM digests WHERE date ${op} ? AND published_at IS NOT NULL ORDER BY date ${dir} LIMIT 1`, row.date).toArray()[0]?.date ?? null;
  const stories = (where: string, limit: number, ...p: any[]) =>
    sql.exec(`SELECT ${COLS} FROM stories WHERE digest_date = ? AND published_at IS NOT NULL AND ${where} ORDER BY display_order LIMIT ${limit}`, row.date, ...p)
      .toArray().map(story);
  const cards = parseInterests(row.interests).positions.map(({ ticker, name }): PositionCard => {
    const q = sql.exec("SELECT close, change_pct, strong_move FROM position_quotes WHERE digest_date = ? AND ticker = ?", row.date, ticker).toArray()[0];
    const logo = sql.exec("SELECT logo_url FROM positions WHERE ticker = ?", ticker).toArray()[0]?.logo_url ?? null;
    const fetchStatus = sql.exec("SELECT status FROM feed_fetches WHERE digest_date = ? AND feed_key = ?", row.date, `news:${ticker}`).toArray()[0]?.status;
    return {
      ticker, name, logoUrl: logo,
      quote: q ? { close: q.close, changePct: q.change_pct, strongMove: !!q.strong_move } : null,
      stories: stories("section = 'markets' AND ticker = ?", 3, ticker),
      newsStatus: fetchStatus ?? "failed",
    };
  });
  return {
    date: row.date, status: row.status, notice: row.notice,
    prev: nearest("<", "DESC"), next: nearest(">", "ASC"),
    tech: stories("section = 'tech'", 20), cards,
  };
}

/** The stored url of a published Story, or null. Logs a click when asked and the row exists. */
export function openStory(sql: Sql, id: number, log: boolean, now: number): string | null {
  const row = sql.exec("SELECT url FROM stories WHERE id = ? AND published_at IS NOT NULL", id).toArray()[0];
  if (row && log) sql.exec("INSERT INTO clicks (story_id, at) VALUES (?, ?)", id, now);
  return row?.url ?? null;
}

const STORY_FIELDS = `s.id, s.digest_date, s.section, s.feed, s.ticker, s.kind, s.url, s.article_url, s.feed_heading, s.feed_snippet,
  s.scorer_version, s.signal_score, s.clef_answers, s.headline, s.summary, s.why_it_matters, s.write_basis, s.vote,
  COALESCE(q.strong_move, 0) AS strong_move`;
const FROM = `FROM stories s LEFT JOIN position_quotes q ON q.digest_date = s.digest_date AND q.ticker = s.ticker`;
const line = (type: string, o: object) => JSON.stringify({ type, ...o });
const storyLine = (r: any) => line("story", { ...r, strong_move: !!r.strong_move, clef_answers: r.clef_answers ? JSON.parse(r.clef_answers) : null });

/** JSONL: one `interests` line per date that has a voted Story, then the voted Stories. */
export function exportVotes(sql: Sql): string {
  const rows = sql.exec(`SELECT ${STORY_FIELDS} ${FROM} WHERE s.vote IS NOT NULL ORDER BY s.digest_date, s.id`).toArray();
  const dates = [...new Set(rows.map((r) => r.digest_date))];
  const ints = dates.flatMap((date) => {
    const i = sql.exec("SELECT interests FROM digests WHERE date = ?", date).toArray()[0]?.interests;
    return i === undefined ? [] : [line("interests", { date, interests: i })];
  });
  return [...ints, ...rows.map(storyLine)].map((l) => l + "\n").join("");
}

const NEAR = 15;
/** JSONL: up to 30 `below` Stories per Section within 15 points under the threshold, plus Tech with is_news in 0.1-0.4. */
export function exportNearMiss(sql: Sql): string {
  const pick = (where: string) =>
    sql.exec(`SELECT ${STORY_FIELDS} ${FROM} WHERE s.status = 'below' AND s.clef_answers IS NOT NULL AND ${where}
              ORDER BY s.signal_score DESC LIMIT 30`).toArray();
  const tech = pick(`s.section = 'tech' AND (s.signal_score >= ${SCORER.tech.threshold - NEAR}
    OR json_extract(s.clef_answers, '$.is_news.noul') BETWEEN 0.1 AND ${SCORER.tech.gate})`);
  const markets = pick(`s.section = 'markets' AND s.signal_score >= (CASE WHEN COALESCE(q.strong_move, 0) = 1 THEN ${SCORER.markets.strongThreshold} ELSE ${SCORER.markets.threshold} END) - ${NEAR}`);
  return [...tech, ...markets].map((r) => storyLine(r) + "\n").join("");
}
