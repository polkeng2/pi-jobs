// Invented text and tickers only. Nothing here comes from the owner's interests.md.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS fake_rules (pattern TEXT, status INTEGER);
CREATE TABLE IF NOT EXISTS fake_now (ms INTEGER);
CREATE TABLE IF NOT EXISTS fake_calls (dispatch TEXT, kind TEXT, target TEXT);
`;

export const FEEDS: Record<string, string> = {
  "https://example.com/feed.xml": `<rss><channel><item><title>Acme raises guidance</title><link>https://example.com/a</link></item></channel></rss>`,
};

export const ARTICLES: Record<string, string> = {
  "https://example.com/a": `<html><body><article><p>Acme Corp (ACME) raised its guidance. Zenith Labs (ZZZT) was unchanged.</p></article></body></html>`,
};
