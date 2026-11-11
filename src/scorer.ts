// score_stories: one Clef call per Story, a Signal Score, then the shortlist trimmed to caps. Plain code, no model.
import { CHUNK_CALLS, isSubrequestLimit, logUsage, neuronGuard, type createBudget } from "./budget.ts";

export const CLEF = "@cf/cloudflare/clef";
const CONCURRENCY = 6;

const SUBSTANCE = {
  type: "score",
  instructions: "Does state.story report something concrete that happened (a release, data, a result, a decision, a change), or is it opinion, speculation or promotion?",
  criteria: [
    "Promotion, clickbait or empty hype",
    "Opinion or speculation, no new fact",
    "Commentary on a known fact",
    "Reports a concrete fact, few details",
    "Reports a concrete new fact with specifics",
  ],
};

/** Starting values, probed on synthetic text only. Question or legend change bumps q, weight/gate/threshold/cap bumps w. */
export const SCORER = {
  version: "q1.w1",
  snippetChars: 600, // cut in code, for the Clef call only
  tech: {
    questions: {
      relevance: {
        type: "score",
        instructions: "state.interests lists the owner's topics with a weight, and anti-topics. How directly is state.story about those topics?",
        criteria: [
          "Unrelated to every topic",
          "Touches a topic in passing",
          "Adjacent to a topic",
          "Directly about a medium topic",
          "Directly about a high topic",
        ],
      },
      substance: SUBSTANCE,
      is_news: {
        type: "noul",
        instructions: "Does state.story report a recent event, release or finding, rather than being a tutorial, a how-to guide or a listicle?",
      },
    },
    weights: { relevance: 0.6, substance: 0.4 },
    threshold: 55,
    gate: 0.4, // minimum is_news
    cap: 30, // 20 are published; the spare 10 cover repeats and failures
  },
  markets: {
    questions: {
      materiality: {
        type: "score",
        instructions: "state.story.ticker is the company. How much could state.story change an investment thesis on that company?",
        criteria: [
          "Barely about this company",
          "Share-price commentary or stock picks",
          "Minor company news",
          "Significant: big product, contract, lawsuit",
          "Core: results, guidance, M&A, regulation, leadership",
        ],
      },
      substance: SUBSTANCE,
    },
    weights: { materiality: 0.7, substance: 0.3 },
    threshold: 55,
    strongThreshold: 35, // for a Position with strong_move = 1 today
    cap: 4, // per Position; 3 are published, 1 spare
    strongCap: 6,
  },
};
type Scorer = typeof SCORER;

export type ClefClient = (state: object, questions: object) => Promise<{ answers: Record<string, any>; usage: { input_tokens: number } }>;

/** Pure. Throws on a malformed answer, which the caller counts as a failed call. */
export function signalScore(scorer: Scorer, section: "tech" | "markets", answers: Record<string, any>, strongMove: boolean) {
  const s = scorer[section];
  let score = 0;
  for (const [key, weight] of Object.entries(s.weights)) {
    const n = (s.questions as Record<string, { criteria: string[] }>)[key]!.criteria.length;
    const level = answers[key]?.score;
    if (typeof level !== "number" || !(level >= 0 && level <= n - 1)) throw new Error(`malformed answer: ${key}`);
    score += weight * (level / (n - 1)) * 100;
  }
  if (section === "tech") {
    const noul = answers.is_news?.noul;
    if (typeof noul !== "number" || !(noul >= 0 && noul <= 1)) throw new Error("malformed answer: is_news");
    return { score, passes: noul >= scorer.tech.gate && score >= scorer.tech.threshold };
  }
  const m = scorer.markets;
  return { score, passes: score >= (strongMove ? m.strongThreshold : m.threshold) };
}

type Sql = { exec(q: string, ...p: any[]): { toArray(): any[] } };
export type ScoreDeps = { sql: Sql; clef: ClefClient; budget: ReturnType<typeof createBudget>; now: () => number };

export async function scoreStories({ sql, clef, budget }: ScoreDeps, date: string) {
  const q = (s: string, ...p: any[]) => sql.exec(s, ...p).toArray();
  const sum = (d: string) => q("SELECT COALESCE(SUM(neurons), 0) AS n FROM usage_log WHERE digest_date = ?", d)[0].n;
  let scored = 0, failed = 0;

  // Earnings make no call: the design always shows them.
  q(
    `UPDATE stories SET status = 'shortlist', signal_score = 100, clef_answers = NULL, scorer_version = ?
     WHERE digest_date = ? AND status = 'new' AND kind = 'earnings'`,
    SCORER.version, date,
  );

  const interests = q("SELECT interests FROM digests WHERE date = ?", date)[0].interests;
  const rows = q(
    `SELECT s.id, s.section, s.feed_heading, s.feed_snippet, s.feed, s.ticker, s.score_attempts, COALESCE(p.strong_move, 0) AS strong
     FROM stories s LEFT JOIN position_quotes p ON p.digest_date = s.digest_date AND p.ticker = s.ticker
     WHERE s.digest_date = ? AND s.status = 'new' AND s.kind = 'news' ORDER BY s.id LIMIT ?`,
    date, Math.max(0, CHUNK_CALLS - budget.used),
  );

  const one = async (r: any) => {
    const questions = SCORER[r.section as "tech" | "markets"].questions;
    const state = {
      interests,
      story: { heading: r.feed_heading, snippet: r.feed_snippet.slice(0, SCORER.snippetChars), feed: r.feed, ticker: r.ticker },
    };
    try {
      const { answers, usage } = await clef(state, questions);
      logUsage(sql, date, "score", CLEF, { calls: 1, input: usage.input_tokens, output: 0 });
      const { score, passes } = signalScore(SCORER, r.section, answers, !!r.strong);
      q(
        "UPDATE stories SET clef_answers = ?, signal_score = ?, scorer_version = ?, status = ? WHERE id = ?",
        JSON.stringify(answers), score, SCORER.version, passes ? "shortlist" : "below", r.id,
      );
      scored++;
    } catch (e) {
      if (isSubrequestLimit(e)) throw e; // ends the chunk, not an attempt
      q("UPDATE stories SET score_attempts = score_attempts + 1, status = CASE WHEN score_attempts + 1 >= 2 THEN 'score_failed' ELSE status END WHERE id = ?", r.id);
      failed++;
    }
  };

  let stopped = false;
  for (let i = 0; i < rows.length && !stopped; i += CONCURRENCY) {
    if (neuronGuard(sum, date) === "neurons") {
      q("UPDATE digests SET chunk_stop = 'neurons' WHERE date = ?", date);
      stopped = true;
    } else await Promise.all(rows.slice(i, i + CONCURRENCY).map(one));
  }

  const done = !stopped && q("SELECT 1 FROM stories WHERE digest_date = ? AND status = 'new' LIMIT 1", date).length === 0;
  if (done) trim(q, date);
  return { done, scored, failed };
}

/** Keeps the top Stories by signal_score up to the caps (per Section for Tech, per Position for Markets). Earnings are never trimmed. */
function trim(q: (s: string, ...p: any[]) => any[], date: string) {
  const rows = q(
    `SELECT s.id, s.section, s.ticker, COALESCE(p.strong_move, 0) AS strong
     FROM stories s LEFT JOIN position_quotes p ON p.digest_date = s.digest_date AND p.ticker = s.ticker
     WHERE s.digest_date = ? AND s.status = 'shortlist' AND s.kind = 'news' ORDER BY s.signal_score DESC, s.id`,
    date,
  );
  const kept = new Map<string, number>();
  for (const r of rows) {
    const key = r.section === "tech" ? "tech" : r.ticker;
    const cap = r.section === "tech" ? SCORER.tech.cap : r.strong ? SCORER.markets.strongCap : SCORER.markets.cap;
    const n = kept.get(key) ?? 0;
    if (n >= cap) q("UPDATE stories SET status = 'below' WHERE id = ?", r.id);
    else kept.set(key, n + 1);
  }
}
