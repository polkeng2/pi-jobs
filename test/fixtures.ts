// Invented text and tickers only. Nothing here comes from the owner's interests.md.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS fake_rules (pattern TEXT, status INTEGER);
CREATE TABLE IF NOT EXISTS fake_now (ms INTEGER);
CREATE TABLE IF NOT EXISTS fake_calls (dispatch TEXT, kind TEXT, target TEXT);
`;

/** Inserts shortlisted Stories for a Daily Run; the test seeds them through the object's storage. */
export const shortlistStory = (date: string, s: { id: number; heading: string; section?: string; ticker?: string; kind?: string; url?: string; score?: number }) => [
  `INSERT INTO stories (id, digest_date, section, feed, ticker, kind, url, article_url, feed_heading, status, signal_score)
   VALUES (?, ?, ?, 'hn', ?, ?, 'u', ?, ?, 'shortlist', ?)`,
  s.id, date, s.section ?? "tech", s.ticker ?? null, s.kind ?? "news", s.url ?? "https://example.com/long", s.heading, s.score ?? 80,
] as const;

export const FEEDS: Record<string, string> = {
  "https://example.com/feed.xml": `<rss><channel><item><title>Acme raises guidance</title><link>https://example.com/a</link></item></channel></rss>`,
};

export const ARTICLES: Record<string, string> = {
  "https://example.com/a": `<html><body><article><p>Acme Corp (ACME) raised its guidance. Zenith Labs (ZZZT) was unchanged.</p></article></body></html>`,
};

const prose = (n: number) => "Acme Corp (ACME) raised its guidance after a strong quarter and said demand held up. ".repeat(n);
const page = (body: string) =>
  `<html><head><title>T</title></head><body><nav>MENU-JUNK</nav><script>junk()</script><article><p>${body}</p></article><footer>FOOTER-JUNK</footer></body></html>`;

export const READ_STORY_ARTICLES: Record<string, string> = {
  "https://example.com/long": page(prose(6) + "Fish &amp; chips"),
  "https://example.com/huge": page(prose(300)),
  "https://example.com/paywall": page("Subscribe to keep reading."),
  // An earnings filing folder: index.json lists the files, exhibit 99.1 is the press release.
  "https://sec.example/f1/index.json": JSON.stringify({ directory: { item: [{ name: "x-8k.htm" }, { name: "x-ex991.htm" }] } }),
  "https://sec.example/f1/x-ex991.htm": page("Zenith Labs reported revenue of $57.0 billion. " + prose(6)),
  "https://sec.example/f2/index.json": JSON.stringify({ directory: { item: [{ name: "x-8k.htm" }] } }),
};

/** The real Tech Feeds answer with nothing new, so a fake Daily Run's Feeds all succeed. Keyed by URL prefix. */
export const QUIET_FEEDS: Record<string, string> = {
  "https://hn.algolia.com/": JSON.stringify({ hits: [] }),
  "https://lobste.rs/": "[]",
  "https://www.anthropic.com/sitemap.xml": "<urlset></urlset>",
  "https://simonwillison.net/": "<feed></feed>",
  "https://www.techmeme.com/": "<rss><channel></channel></rss>",
  "https://github.blog/": "<rss><channel></channel></rss>",
  "https://openai.com/": "<rss><channel></channel></rss>",
  "https://deepmind.google/": "<rss><channel></channel></rss>",
};
