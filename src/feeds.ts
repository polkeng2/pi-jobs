// fetch_feeds: one feed_fetches row per Feed, one fetch each, prefilter, then Stories. Plain code, no model.
import { isSubrequestLimit } from "./budget.ts";
import type { Deps } from "./daily-run.ts";
import { parseInterests } from "./interests.ts";
import { type Item, normalizeUrl, parseAnthropic, parseFeed, parseHn, parseLobsters } from "./parsers.ts";

const CALL_LIMIT = 40;
const WINDOW_MS = 48 * 3_600_000;
const FEED_CAP = 20;
const MAX_ATTEMPTS = 2;

/** One Feed. #29 adds Markets specs (`quote:<T>`, `news:<T>`, `edgar:<T>`, section "markets") by extending `feedList`. */
export type FeedSpec = {
  key: string;
  section: "tech" | "markets";
  url: (now: number) => string;
  parse: (body: string) => Item[];
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

/** Feeds in run order. Markets Feeds go first (#29), so a URL in both Sections lands on its Position's card. */
const feedList = (_sql: SqlStorage): FeedSpec[] => TECH_FEEDS;

/** Window, anti-topics, cap. Items without a date stay. */
function prefilter(items: Item[], now: number, antiTopics: string[], windowed: boolean) {
  const anti = antiTopics.map((a) => a.toLowerCase());
  return items
    .filter((i) => !windowed || i.publishedAt === null || i.publishedAt >= now - WINDOW_MS)
    .filter((i) => !anti.some((a) => `${i.heading} ${i.snippet}`.toLowerCase().includes(a)))
    .slice(0, FEED_CAP);
}

/**
 * Works through pending rows while `budget.used < 40`. A failed call is an attempt; the second one fails the row.
 * Errors do not throw, except the subrequest limit, which the driver turns into the end of the chunk.
 */
export async function fetchFeeds({ sql, budget, now }: Deps, date: string) {
  const feeds = feedList(sql);
  const antiTopics = parseInterests(
    sql.exec<{ interests: string }>("SELECT interests FROM digests WHERE date = ?", date).one().interests,
  ).antiTopics;
  for (const f of feeds) {
    sql.exec("INSERT OR IGNORE INTO feed_fetches (digest_date, feed_key) VALUES (?, ?)", date, f.key);
  }
  const pending = new Set(
    sql.exec<{ feed_key: string }>("SELECT feed_key FROM feed_fetches WHERE digest_date = ? AND status = 'pending'", date)
      .toArray().map((r) => r.feed_key),
  );
  let storiesAdded = 0;
  for (const f of feeds.filter((f) => pending.has(f.key))) {
    if (budget.used >= CALL_LIMIT) break;
    try {
      const res = await budget.fetch(f.url(now()), { headers: { "user-agent": "signal-feed-reader" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = f.parse(await res.text());
      // Synchronous from here: no await, so the writes land together.
      const added = store(sql, f, date, items, now(), antiTopics);
      storiesAdded += added;
      sql.exec("UPDATE feed_fetches SET status = 'done', story_count = ?, error = NULL WHERE digest_date = ? AND feed_key = ?", added, date, f.key);
      pending.delete(f.key);
    } catch (e) {
      if (isSubrequestLimit(e)) throw e;
      const row = sql.exec<{ attempts: number }>(
        "UPDATE feed_fetches SET attempts = attempts + 1, error = ?1, status = CASE WHEN attempts + 1 >= ?2 THEN 'failed' ELSE 'pending' END WHERE digest_date = ?3 AND feed_key = ?4 RETURNING attempts",
        String((e as Error)?.message ?? e), MAX_ATTEMPTS, date, f.key,
      ).one();
      if (row.attempts >= MAX_ATTEMPTS) pending.delete(f.key);
    }
  }
  const failed = sql
    .exec<{ feed_key: string }>("SELECT feed_key FROM feed_fetches WHERE digest_date = ? AND status = 'failed'", date)
    .toArray().map((r) => r.feed_key);
  return { done: pending.size === 0, storiesAdded, failed };
}

/** `seen_urls` first; a Story only when that insert wrote a row. Returns the number of Stories. */
function store(sql: SqlStorage, f: FeedSpec, date: string, items: Item[], now: number, antiTopics: string[]) {
  const seed = f.diff && sql.exec("SELECT 1 FROM seen_urls WHERE feed = ? LIMIT 1", f.key).toArray().length === 0;
  const kept = seed ? items : prefilter(items, now, antiTopics, !f.diff);
  let added = 0;
  for (const i of kept) {
    const fresh = sql
      .exec("INSERT OR IGNORE INTO seen_urls (url_key, feed, first_seen_at) VALUES (?, ?, ?) RETURNING url_key", normalizeUrl(i.url), f.key, now)
      .toArray().length;
    if (!fresh || seed) continue;
    sql.exec(
      "INSERT INTO stories (digest_date, section, feed, url, article_url, feed_heading, feed_snippet, feed_published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      date, f.section, f.key, i.url, i.url, i.heading, i.snippet, i.publishedAt,
    );
    added++;
  }
  return added;
}
