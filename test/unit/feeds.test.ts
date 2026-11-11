import { expect, test } from "vitest";
import { createBudget } from "../../src/budget.ts";
import { fetchFeeds } from "../../src/feeds.ts";
import { normalizeUrl, parseAnthropic, parseFeed, parseHn, parseLobsters } from "../../src/parsers.ts";
import { migrate } from "../../src/schema.ts";
import { makeSql } from "../sql.ts";

const NOW = Date.parse("2026-11-03T07:00:00Z");

test("parseFeed reads RSS items: CDATA, entities, tags stripped, dates", () => {
  const xml = `<rss><channel><title>Site</title>
  <item><title><![CDATA[Acme &amp; Zenith ship]]></title><link>https://example.com/a?utm_source=x</link>
  <description>&lt;p&gt;Big &lt;b&gt;news&lt;/b&gt; today&lt;/p&gt;</description><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>
  <item><title>No date</title><link>https://example.com/b</link></item></channel></rss>`;
  expect(parseFeed(xml)).toEqual([
    { url: "https://example.com/a?utm_source=x", heading: "Acme & Zenith ship", snippet: "Big news today", publishedAt: Date.parse("2026-11-02T10:00:00Z") },
    { url: "https://example.com/b", heading: "No date", snippet: "", publishedAt: null },
  ]);
});

test("parseFeed reads Atom entries and takes the alternate link href", () => {
  const xml = `<feed><title>Blog</title><entry><title>Post one</title>
  <link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/p1"/>
  <published>2026-11-02T08:30:00Z</published><summary>Short text</summary></entry></feed>`;
  expect(parseFeed(xml)).toEqual([
    { url: "https://example.com/p1", heading: "Post one", snippet: "Short text", publishedAt: Date.parse("2026-11-02T08:30:00Z") },
  ]);
});

test("parseHn uses the story url, falls back to the HN item page, and keeps created time", () => {
  const json = JSON.stringify({ hits: [
    { objectID: "1", title: "Show: a thing", url: "https://example.com/t", created_at_i: 1_700_000_000, points: 150 },
    { objectID: "2", title: "Ask: why?", url: null, created_at_i: 1_700_000_100, points: 120 },
  ] });
  expect(parseHn(json)).toEqual([
    { url: "https://example.com/t", heading: "Show: a thing", snippet: "", publishedAt: 1_700_000_000_000 },
    { url: "https://news.ycombinator.com/item?id=2", heading: "Ask: why?", snippet: "", publishedAt: 1_700_000_100_000 },
  ]);
});

test("parseLobsters keeps the link and falls back to the comments page", () => {
  const json = JSON.stringify([
    { title: "A", url: "https://example.com/l", comments_url: "https://lobste.rs/s/x", created_at: "2026-11-02T09:00:00.000-05:00" },
    { title: "B", url: "", comments_url: "https://lobste.rs/s/y", created_at: "2026-11-02T09:00:00.000-05:00" },
  ]);
  const r = parseLobsters(json);
  expect(r.map((i) => i.url)).toEqual(["https://example.com/l", "https://lobste.rs/s/y"]);
  expect(r[0]!.publishedAt).toBe(Date.parse("2026-11-02T14:00:00Z"));
});

test("parseAnthropic keeps only /news/ and /research/ URLs and titles them from the slug", () => {
  const xml = `<urlset>
  <url><loc>https://www.anthropic.com/news/claude-gets-faster</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://www.anthropic.com/research/tracing-thoughts</loc></url>
  <url><loc>https://www.anthropic.com/careers</loc></url></urlset>`;
  expect(parseAnthropic(xml)).toEqual([
    { url: "https://www.anthropic.com/news/claude-gets-faster", heading: "claude gets faster", snippet: "", publishedAt: null },
    { url: "https://www.anthropic.com/research/tracing-thoughts", heading: "tracing thoughts", snippet: "", publishedAt: null },
  ]);
});

test("normalizeUrl drops tracking params, fragment, www and trailing slash", () => {
  expect(normalizeUrl("https://WWW.Example.com/a/?utm_source=x&id=2#top")).toBe("https://example.com/a?id=2");
});

// ---- fetchFeeds ----
const rss = (...items: string[]) => `<rss><channel>${items.join("")}</channel></rss>`;
const item = (t: string, link: string, hoursAgo: number, desc = "") =>
  `<item><title>${t}</title><link>${link}</link><description>${desc}</description><pubDate>${new Date(NOW - hoursAgo * 3_600_000).toUTCString()}</pubDate></item>`;

function setup(routes: Record<string, string | number>, interests = "## Anti-topics\n- crypto\n") {
  const { sql, transactionSync } = makeSql();
  migrate(sql, transactionSync);
  sql.exec("INSERT INTO digests (date, interests, started_at) VALUES ('2026-11-03', ?, 0)", interests);
  const calls: string[] = [];
  const budget = createBudget(async (url) => {
    const u = String(url);
    calls.push(u);
    const hit = Object.entries(routes).find(([k]) => u.startsWith(k));
    const v = hit?.[1] ?? 404;
    return typeof v === "number" ? new Response("", { status: v }) : new Response(v);
  });
  return { sql, budget, calls, d: { sql: sql as any, budget, ai: { run: (() => {}) as any }, now: () => NOW, secrets: {}, transactionSync } };
}
const stories = (sql: any) => sql.exec("SELECT feed, url, feed_heading FROM stories ORDER BY id").toArray();

test("prefilter drops stale and anti-topic items, writes Stories once, replay adds nothing", async () => {
  const feed = rss(
    item("Fresh thing", "https://example.com/fresh", 5),
    item("Old thing", "https://example.com/old", 100),
    item("Crypto boom", "https://example.com/c", 2),
    item("Undated", "https://example.com/u", 1).replace(/<pubDate>.*<\/pubDate>/, ""),
  );
  const { sql, d } = setup({ "https://simonwillison.net/": feed });
  const r = await fetchFeeds(d, "2026-11-03");
  expect(stories(sql).map((s: any) => s.url)).toEqual(["https://example.com/fresh", "https://example.com/u"]);
  expect(r.storiesAdded).toBe(2);
  await fetchFeeds(d, "2026-11-03");
  expect(stories(sql)).toHaveLength(2);
});

test("a URL already seen (from another Feed) creates no second Story", async () => {
  const same = rss(item("Shared", "https://example.com/s?utm_source=a", 1));
  const { sql, d } = setup({ "https://simonwillison.net/": same, "https://www.techmeme.com/": same });
  await fetchFeeds(d, "2026-11-03");
  expect(stories(sql)).toHaveLength(1);
});

test("per-Feed cap is 20", async () => {
  const feed = rss(...Array.from({ length: 30 }, (_, i) => item(`T${i}`, `https://example.com/${i}`, 1)));
  const { sql, d } = setup({ "https://simonwillison.net/": feed });
  await fetchFeeds(d, "2026-11-03");
  expect(stories(sql)).toHaveLength(20);
});

test("a failing Feed gets 2 attempts then fails, never throws; done once nothing is pending", async () => {
  const { sql, d } = setup({});
  const a = await fetchFeeds(d, "2026-11-03");
  expect(a.done).toBe(false);
  const b = await fetchFeeds(d, "2026-11-03");
  expect(b.done).toBe(true);
  expect([...b.failed].sort()).toEqual(["anthropic", "deepmind", "github", "hn", "lobsters", "openai", "techmeme", "willison"]);
  const row = sql.exec("SELECT status, attempts, error FROM feed_fetches WHERE feed_key = 'hn'").one();
  expect(row).toMatchObject({ status: "failed", attempts: 2 });
  expect(row.error).toMatch(/404/);
});

test("stops starting Feeds at 40 subrequests", async () => {
  const { d, calls, budget } = setup({});
  budget.used = 40;
  const r = await fetchFeeds(d, "2026-11-03");
  expect(calls).toEqual([]);
  expect(r.done).toBe(false);
});

test("Anthropic: first run seeds seen_urls with no Stories, later runs add only new URLs, no window", async () => {
  const map = (...slugs: string[]) =>
    `<urlset>${slugs.map((s) => `<url><loc>https://www.anthropic.com/news/${s}</loc><lastmod>2020-01-01</lastmod></url>`).join("")}</urlset>`;
  const routes: Record<string, string> = { "https://www.anthropic.com/sitemap.xml": map("old-one", "old-two") };
  const { sql, d } = setup(routes);
  await fetchFeeds(d, "2026-11-03");
  expect(stories(sql)).toEqual([]);
  expect(sql.exec("SELECT COUNT(*) AS n FROM seen_urls WHERE feed = 'anthropic'").one().n).toBe(2);

  routes["https://www.anthropic.com/sitemap.xml"] = map("old-one", "old-two", "brand-new");
  sql.exec("INSERT INTO digests (date, interests, started_at) VALUES ('2026-11-04', '', 0)");
  await fetchFeeds(d, "2026-11-04");
  expect(stories(sql)).toEqual([{ feed: "anthropic", url: "https://www.anthropic.com/news/brand-new", feed_heading: "brand new" }]);
});
