import { expect, test } from "vitest";
import { createBudget } from "../../src/budget.ts";
import { fetchFeeds } from "../../src/feeds.ts";
import { parseEdgar, parseFinnhubNews } from "../../src/parsers.ts";
import { migrate } from "../../src/schema.ts";
import { makeSql } from "../sql.ts";

test("parseFinnhubNews maps headline, summary, url and unix datetime", () => {
  const json = JSON.stringify([
    { headline: "Acme beats", summary: "Details", url: "https://example.com/n1", datetime: 1_700_000_000 },
    { headline: "", url: "x" },
  ]);
  expect(parseFinnhubNews(json)).toEqual([
    { url: "https://example.com/n1", heading: "Acme beats", snippet: "Details", publishedAt: 1_700_000_000_000 },
  ]);
});

test("parseEdgar: 8-Ks only, one Item per filing, earnings for 2.02, filing folder as url and articleUrl", () => {
  const at = "2026-11-02T21:05:12.000Z";
  const recent = {
    form: ["8-K", "10-Q", "8-K", "8-K", "8-K"],
    items: ["2.02,9.01", "", "9.01", "5.02", "99.99"],
    accessionNumber: ["0000000001-26-000001", "0000000001-26-000002", "0000000001-26-000003", "0000000001-26-000004", "0000000001-26-000005"],
    acceptanceDateTime: Array(5).fill(at),
  };
  const folder = (n: string) => `https://www.sec.gov/Archives/edgar/data/1234567/${n}/`;
  expect(parseEdgar(JSON.stringify({ cik: "0001234567", filings: { recent } }))).toEqual([
    {
      url: folder("000000000126000001"), articleUrl: folder("000000000126000001"), kind: "earnings",
      heading: "8-K Item 2.02: Results of Operations and Financial Condition", snippet: "", publishedAt: Date.parse(at),
    },
    {
      url: folder("000000000126000004"), articleUrl: folder("000000000126000004"), kind: "news",
      heading: "8-K Item 5.02: Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers",
      snippet: "", publishedAt: Date.parse(at),
    },
  ]);
});

// ---- fetchFeeds, Markets ----
const NOW = Date.parse("2026-11-03T07:00:00Z");
const DATE = "2026-11-03";
const FH = "https://finnhub.io/api/v1";
const FOLDER = "https://www.sec.gov/Archives/edgar/data/1234567/000000000126000001/";
const submissions = (items = "2.02,9.01", at = "2026-11-02T21:05:12.000Z") =>
  JSON.stringify({ cik: "0001234567", filings: { recent: { form: ["8-K"], items: [items], accessionNumber: ["0000000001-26-000001"], acceptanceDateTime: [at] } } });
const tickers = JSON.stringify({ 0: { cik_str: 1234567, ticker: "ACME", title: "Acme Corp" }, 1: { cik_str: 7654321, ticker: "ZZZT", title: "Zed" } });
const INTERESTS = "## Positions\n- ACME | Acme Corp\n- ZZZT | Zed Inc\n";

function setup(routes: Record<string, string | number>, { finnhub = "k", interests = INTERESTS } = {}) {
  const { sql, transactionSync } = makeSql();
  migrate(sql, transactionSync);
  sql.exec("INSERT INTO digests (date, interests, started_at) VALUES (?, ?, 0)", DATE, interests);
  const calls: { url: string; headers: any }[] = [];
  const budget = createBudget(async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    const hit = Object.entries(routes).find(([k]) => String(url).startsWith(k));
    const v = hit?.[1] ?? 404;
    return typeof v === "number" ? new Response("", { status: v }) : new Response(v);
  });
  const secrets = { finnhubKey: finnhub || undefined, edgarContact: "me@example.invalid" };
  const d = { sql: sql as any, budget, ai: { run: (() => {}) as any }, now: () => NOW, secrets, transactionSync };
  return { sql, d, calls };
}
const rows = (sql: any, q: string, ...p: any[]) => sql.exec(q, ...p).toArray();
const quote = (c: number, dp: number) => JSON.stringify({ c, dp, pc: 1 });
const happy: Record<string, string> = {
  [`${FH}/quote?symbol=ACME`]: quote(120.5, 4.2),
  [`${FH}/quote?symbol=ZZZT`]: quote(10, -1),
  [`${FH}/company-news?symbol=ACME`]: JSON.stringify([{ headline: "Acme ships", summary: "s", url: "https://example.com/acme", datetime: NOW / 1000 - 3600 }]),
  [`${FH}/company-news?symbol=ZZZT`]: "[]",
  [`${FH}/stock/profile2`]: JSON.stringify({ logo: "https://img.example.invalid/l.png" }),
  [`${FH}/calendar/earnings?symbol=ACME`]: JSON.stringify({ earningsCalendar: [{ date: "2026-10-20", epsEstimate: 9 }, { date: "2026-11-02", epsEstimate: 1.23, revenueEstimate: 45e9 }] }),
  "https://www.sec.gov/files/company_tickers.json": tickers,
  "https://data.sec.gov/submissions/CIK0001234567.json": submissions(),
  "https://data.sec.gov/submissions/CIK0007654321.json": submissions("9.01"),
};

test("Positions are synced from interests.md, idempotently, and renames update the name", async () => {
  const { sql, d } = setup(happy);
  await fetchFeeds(d, DATE);
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT ticker, name FROM positions ORDER BY ticker")).toEqual([{ ticker: "ACME", name: "Acme Corp" }, { ticker: "ZZZT", name: "Zed Inc" }]);
  sql.exec("UPDATE digests SET interests = ? WHERE date = ?", "## Positions\n- ACME | Acme Renamed\n", DATE);
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT name FROM positions WHERE ticker = 'ACME'")).toEqual([{ name: "Acme Renamed" }]);
});

test("quote: c and dp stored, Strong move at abs(dp) >= 4; c of 0 fails the row, no quote row", async () => {
  const { sql, d } = setup({ ...happy, [`${FH}/quote?symbol=ZZZT`]: quote(0, 0) });
  await fetchFeeds(d, DATE);
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT ticker, close, change_pct, strong_move FROM position_quotes")).toEqual([{ ticker: "ACME", close: 120.5, change_pct: 4.2, strong_move: 1 }]);
  expect(rows(sql, "SELECT status FROM feed_fetches WHERE feed_key = 'quote:ZZZT'")).toEqual([{ status: "failed" }]);
});

test("one transactionSync per Feed row that fetched", async () => {
  const { d, sql } = setup(happy);
  let n = 0;
  await fetchFeeds({ ...d, transactionSync: (fn: any) => (n++, d.transactionSync(fn)) }, DATE);
  expect(n).toBe(rows(sql, "SELECT 1 FROM feed_fetches WHERE status = 'done'").length);
});

test("news Stories carry the ticker, empty news is not a failure; Markets goes first so Tech cannot take the URL", async () => {
  const lobsters = JSON.stringify([{ title: "Acme ships", url: "https://example.com/acme", comments_url: "c", created_at: new Date(NOW - 3600e3).toISOString() }]);
  const { sql, d } = setup({ ...happy, "https://lobste.rs/": lobsters });
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT section, feed, ticker, kind, url, article_url, feed_heading FROM stories WHERE kind = 'news'")).toEqual([
    { section: "markets", feed: "news:ACME", ticker: "ACME", kind: "news", url: "https://example.com/acme", article_url: "https://example.com/acme", feed_heading: "Acme ships" },
  ]);
  expect(rows(sql, "SELECT status FROM feed_fetches WHERE feed_key = 'news:ZZZT'")).toEqual([{ status: "done" }]);
});

test("EDGAR: tickers fetched for a missing CIK, earnings Story has the filing folder as article_url, consensus stored", async () => {
  const { sql, d, calls } = setup(happy);
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT ticker, cik FROM positions ORDER BY ticker")).toEqual([{ ticker: "ACME", cik: "0001234567" }, { ticker: "ZZZT", cik: "0007654321" }]);
  expect(rows(sql, "SELECT section, ticker, kind, url, article_url, feed_heading, feed_published_at, consensus FROM stories WHERE kind = 'earnings'")).toEqual([{
    section: "markets", ticker: "ACME", kind: "earnings", url: FOLDER, article_url: FOLDER,
    feed_heading: "8-K Item 2.02: Results of Operations and Financial Condition", feed_published_at: Date.parse("2026-11-02T21:05:12Z"),
    consensus: JSON.stringify({ epsEstimate: 1.23, revenueEstimate: 45e9 }),
  }]);
  expect(JSON.stringify(calls.find((c) => c.url.includes("data.sec.gov"))!.headers)).toContain("me@example.invalid");
  expect(calls.some((c) => /price-target|recommendation/.test(c.url))).toBe(false);
});

test("consensus with no row leaves it null and fails nothing", async () => {
  const { sql, d } = setup({ ...happy, [`${FH}/calendar/earnings?symbol=ACME`]: JSON.stringify({ earningsCalendar: [] }) });
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT consensus FROM stories WHERE kind = 'earnings'")).toEqual([{ consensus: null }]);
  expect(rows(sql, "SELECT 1 FROM feed_fetches WHERE status = 'failed'")).toEqual([]);
});

test("profile stores the logo; a Position checked today is not asked again the next day", async () => {
  const { sql, d, calls } = setup(happy);
  await fetchFeeds(d, DATE);
  expect(rows(sql, "SELECT logo_url, profile_checked_at FROM positions WHERE ticker = 'ACME'")).toEqual([{ logo_url: "https://img.example.invalid/l.png", profile_checked_at: NOW }]);
  sql.exec("INSERT INTO digests (date, interests, started_at) VALUES ('2026-11-04', ?, 0)", INTERESTS);
  const before = calls.filter((c) => c.url.includes("profile2")).length;
  await fetchFeeds(d, "2026-11-04");
  expect(calls.filter((c) => c.url.includes("profile2")).length).toBe(before);
});

test("no Finnhub key: no Finnhub call, no failed rows, EDGAR Stories still arrive", async () => {
  const { sql, d, calls } = setup(happy, { finnhub: "" });
  const r = await fetchFeeds(d, DATE);
  expect(calls.some((c) => c.url.includes("finnhub.io"))).toBe(false);
  expect(r.failed).toEqual([]);
  expect(rows(sql, "SELECT ticker FROM stories WHERE kind = 'earnings'")).toEqual([{ ticker: "ACME" }]);
});

test("Finnhub requests send the key in X-Finnhub-Token", async () => {
  const { d, calls } = setup(happy);
  await fetchFeeds(d, DATE);
  expect(calls.find((c) => c.url.startsWith(FH))!.headers).toMatchObject({ "x-finnhub-token": "k" });
});
