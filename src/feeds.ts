// fetch_feeds: one feed_fetches row per Feed, one fetch each, prefilter, then Stories. Plain code, no model.
import { isSubrequestLimit } from "./budget.ts";
import type { Deps } from "./daily-run.ts";
import { parseInterests } from "./interests.ts";
import { type Item, normalizeUrl, parseAnthropic, parseEdgar, parseFeed, parseFinnhubNews, parseHn, parseLobsters } from "./parsers.ts";

const CALL_LIMIT = 40;
const WINDOW_MS = 48 * 3_600_000;
const FEED_CAP = 20;
const MAX_ATTEMPTS = 2;

const POSITION_CAP = 10;
const PROFILE_TTL_MS = 30 * 86_400_000;
const FH = "https://finnhub.io/api/v1";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One Feed. Markets specs carry a `ticker`; `apply` writes what is not a Story (quote, logo, CIKs, consensus). */
export type FeedSpec = {
  key: string;
  section: "tech" | "markets";
  ticker?: string;
  url: (now: number) => string;
  parse?: (body: string) => Item[];
  headers?: Record<string, string>;
  /** Runs inside the row's transaction. A throw is an attempt. */
  apply?: (body: string) => void;
  /** Anthropic: the first run only seeds `seen_urls`, and the 48 h window does not apply. */
  diff?: boolean;
};

export const TECH_FEEDS: FeedSpec[] = [
  {
    key: "hn", section: "tech", parse: parseHn,
    url: (now) =>
      "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=50&numericFilters=" +
      encodeURIComponent(`points>100,created_at_i>${Math.floor((now - 86_400_000) / 1000)}`),
  },
  { key: "lobsters", section: "tech", parse: parseLobsters, url: () => "https://lobste.rs/hottest.json" },
  { key: "willison", section: "tech", parse: parseFeed, url: () => "https://simonwillison.net/atom/everything/" },
  { key: "techmeme", section: "tech", parse: parseFeed, url: () => "https://www.techmeme.com/feed.xml" },
  { key: "github", section: "tech", parse: parseFeed, url: () => "https://github.blog/feed/" },
  { key: "openai", section: "tech", parse: parseFeed, url: () => "https://openai.com/news/rss.xml" },
  { key: "deepmind", section: "tech", parse: parseFeed, url: () => "https://deepmind.google/blog/rss.xml" },
  { key: "anthropic", section: "tech", parse: parseAnthropic, diff: true, url: () => "https://www.anthropic.com/sitemap.xml" },
];

type Position = { ticker: string; cik: string | null; logo_url: string | null; profile_checked_at: number | null };

/**
 * Feeds in run order, recomputed from our tables each time (profile, tickers and consensus depend on state).
 * Markets Feeds go first, so a URL in both Sections lands on its Position's card; seen_urls does the rest.
 * Without a Finnhub key there are no Finnhub Feeds; without an EDGAR contact, no EDGAR ones.
 */
function feedList({ sql, now, secrets }: Deps, date: string, tickers: string[]): FeedSpec[] {
  const { finnhubKey, edgarContact } = secrets;
  const known = new Map(
    sql.exec<Position>("SELECT ticker, cik, logo_url, profile_checked_at FROM positions").toArray().map((p) => [p.ticker, p]),
  );
  const fh = (key: string, ticker: string, path: (t: number) => string, rest: Partial<FeedSpec>): FeedSpec => ({
    key, section: "markets", ticker, url: (t) => FH + path(t), headers: { "x-finnhub-token": finnhubKey! }, ...rest,
  });
  const edgarHeaders = { "user-agent": `Signal ${edgarContact}` };
  const markets: FeedSpec[] = [];
  const noCik = tickers.filter((t) => !known.get(t)?.cik);
  if (edgarContact && noCik.length) {
    markets.push({
      key: "tickers", section: "markets", url: () => "https://www.sec.gov/files/company_tickers.json", headers: edgarHeaders,
      apply(body) {
        const byTicker = new Map((Object.values(JSON.parse(body)) as any[]).map((e) => [e.ticker, String(e.cik_str).padStart(10, "0")]));
        for (const t of noCik) if (byTicker.has(t)) sql.exec("UPDATE positions SET cik = ? WHERE ticker = ?", byTicker.get(t), t);
      },
    });
  }
  for (const t of tickers) {
    const p = known.get(t);
    if (finnhubKey) {
      markets.push(fh(`quote:${t}`, t, () => `/quote?symbol=${t}`, {
        apply(body) {
          const q = JSON.parse(body);
          if (!(q.c > 0)) throw new Error("no quote"); // 0 or missing: no row, the Feed fails
          const dp = Number(q.dp) || 0;
          sql.exec("INSERT OR REPLACE INTO position_quotes (digest_date, ticker, close, change_pct, strong_move) VALUES (?, ?, ?, ?, ?)", date, t, q.c, dp, Math.abs(dp) >= 4 ? 1 : 0);
        },
      }));
    }
    // EDGAR before news: the earnings Story takes its place under the per-Position cap first.
    if (edgarContact && p?.cik) {
      markets.push({
        key: `edgar:${t}`, section: "markets", ticker: t, parse: parseEdgar, headers: edgarHeaders,
        url: () => `https://data.sec.gov/submissions/CIK${p.cik}.json`,
      });
    }
    if (finnhubKey) {
      markets.push(fh(`news:${t}`, t, (n) => `/company-news?symbol=${t}&from=${day(n - WINDOW_MS)}&to=${day(n)}`, { parse: parseFinnhubNews }));
      if (p && (!p.logo_url || !p.profile_checked_at || p.profile_checked_at < now() - PROFILE_TTL_MS)) {
        markets.push(fh(`profile:${t}`, t, () => `/stock/profile2?symbol=${t}`, {
          apply: (body) => void sql.exec("UPDATE positions SET logo_url = ?, profile_checked_at = ? WHERE ticker = ?", JSON.parse(body).logo || null, now(), t),
        }));
      }
      const e = sql
        .exec<{ id: number; feed_published_at: number }>(
          "SELECT id, feed_published_at FROM stories WHERE digest_date = ? AND ticker = ? AND kind = 'earnings' AND consensus IS NULL AND feed_published_at IS NOT NULL ORDER BY id LIMIT 1",
          date, t,
        ).toArray()[0];
      if (e) {
        const filed = e.feed_published_at;
        markets.push(fh(`consensus:${t}`, t, () => `/calendar/earnings?symbol=${t}&from=${day(filed - 86_400_000)}&to=${day(filed + 86_400_000)}`, {
          apply(body) {
            const rows: any[] = JSON.parse(body).earningsCalendar ?? [];
            const gap = (r: any) => Math.abs(Date.parse(r.date) - filed);
            const row = rows.filter((r) => !Number.isNaN(gap(r))).sort((a, b) => gap(a) - gap(b))[0];
            const c = { epsEstimate: row?.epsEstimate ?? undefined, revenueEstimate: row?.revenueEstimate ?? undefined };
            if (c.epsEstimate !== undefined || c.revenueEstimate !== undefined) {
              sql.exec("UPDATE stories SET consensus = ? WHERE id = ?", JSON.stringify(c), e.id);
            }
          },
        }));
      }
    }
  }
  return [...markets, ...TECH_FEEDS];
}

/** Window, anti-topics, cap. Items without a date stay. */
function prefilter(items: Item[], now: number, antiTopics: string[], windowed: boolean, cap: number) {
  const anti = antiTopics.map((a) => a.toLowerCase());
  return items
    .filter((i) => !windowed || i.publishedAt === null || i.publishedAt >= now - WINDOW_MS)
    .filter((i) => !anti.some((a) => `${i.heading} ${i.snippet}`.toLowerCase().includes(a)))
    .slice(0, cap);
}

/**
 * Works through pending rows while `budget.used < 40`. A failed call is an attempt; the second one fails the row.
 * Errors do not throw, except the subrequest limit, which the driver turns into the end of the chunk.
 */
export async function fetchFeeds(d: Deps, date: string) {
  const { sql, budget, now, transactionSync } = d;
  const interests = parseInterests(sql.exec<{ interests: string }>("SELECT interests FROM digests WHERE date = ?", date).one().interests);
  // The Positions table is a copy of interests.md; rewriting it every call is idempotent. cik and logo stay.
  for (const p of interests.positions) {
    sql.exec("INSERT INTO positions (ticker, name) VALUES (?, ?) ON CONFLICT (ticker) DO UPDATE SET name = excluded.name", p.ticker, p.name);
  }
  const tickers = interests.positions.map((p) => p.ticker);
  // Rebuilt only when a done `tickers` or `edgar:<T>` row adds Feeds (`edgar`, `consensus`), and once at the end for `done`.
  // Between rebuilds a finished Feed stays in `todo`, but `tried` skips it.
  const next = () => {
    const feeds = feedList(d, date, tickers);
    for (const f of feeds) sql.exec("INSERT OR IGNORE INTO feed_fetches (digest_date, feed_key) VALUES (?, ?)", date, f.key);
    const pending = new Set(
      sql.exec<{ feed_key: string }>("SELECT feed_key FROM feed_fetches WHERE digest_date = ? AND status = 'pending'", date)
        .toArray().map((r) => r.feed_key),
    );
    return { feeds: feeds.filter((f) => pending.has(f.key)) };
  };
  const tried = new Set<string>(); // one attempt per Feed per call
  let storiesAdded = 0;
  let todo = next().feeds;
  for (let f = todo.find((f) => !tried.has(f.key)); f && budget.used < CALL_LIMIT; f = todo.find((f) => !tried.has(f.key))) {
    tried.add(f.key);
    try {
      const res = await budget.fetch(f.url(now()), { headers: f.headers ?? { "user-agent": "signal-feed-reader" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const items = f.parse?.(body) ?? [];
      // One transaction per Feed row: prefilter, seen_urls, stories, and the row's own side effect.
      storiesAdded += transactionSync(() => {
        const added = store(sql, f, date, items, now(), interests.antiTopics);
        f.apply?.(body);
        sql.exec("UPDATE feed_fetches SET status = 'done', story_count = ?, error = NULL WHERE digest_date = ? AND feed_key = ?", added, date, f.key);
        return added;
      });
      if (f.key === "tickers" || f.key.startsWith("edgar:")) todo = next().feeds;
    } catch (e) {
      if (isSubrequestLimit(e)) throw e;
      sql.exec(
        "UPDATE feed_fetches SET attempts = attempts + 1, error = ?1, status = CASE WHEN attempts + 1 >= ?2 THEN 'failed' ELSE 'pending' END WHERE digest_date = ?3 AND feed_key = ?4",
        String((e as Error)?.message ?? e), MAX_ATTEMPTS, date, f.key,
      );
    }
  }
  todo = next().feeds;
  const failed = sql
    .exec<{ feed_key: string }>("SELECT feed_key FROM feed_fetches WHERE digest_date = ? AND status = 'failed'", date)
    .toArray().map((r) => r.feed_key);
  return { done: todo.length === 0, storiesAdded, failed };
}

/** `seen_urls` first; a Story only when that insert wrote a row. Returns the number of Stories. */
function store(sql: SqlStorage, f: FeedSpec, date: string, items: Item[], now: number, antiTopics: string[]) {
  const seed = f.diff && sql.exec("SELECT 1 FROM seen_urls WHERE feed = ? LIMIT 1", f.key).toArray().length === 0;
  // Per-Position cap is shared by all of the Position's Feeds, so news cannot crowd out what EDGAR already stored.
  const cap = f.ticker
    ? POSITION_CAP - sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM stories WHERE digest_date = ? AND ticker = ?", date, f.ticker).one().n
    : FEED_CAP;
  const kept = seed ? items : prefilter(items, now, antiTopics, !f.diff, Math.max(cap, 0));
  let added = 0;
  for (const i of kept) {
    const fresh = sql
      .exec("INSERT OR IGNORE INTO seen_urls (url_key, feed, first_seen_at) VALUES (?, ?, ?) RETURNING url_key", normalizeUrl(i.url), f.key, now)
      .toArray().length;
    if (!fresh || seed) continue;
    sql.exec(
      "INSERT INTO stories (digest_date, section, feed, ticker, kind, url, article_url, feed_heading, feed_snippet, feed_published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      date, f.section, f.key, f.ticker ?? null, i.kind ?? "news", i.url, i.articleUrl ?? i.url, i.heading, i.snippet, i.publishedAt,
    );
    added++;
  }
  return added;
}
