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
