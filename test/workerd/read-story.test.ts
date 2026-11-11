import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { SCHEMA } from "../fixtures.ts";

const harness = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});
beforeAll(() => harness.listen());
afterAll(() => harness.close());

const call = async (kind: string, args: unknown) =>
  (await harness.fetch("/fake", { method: "POST", body: JSON.stringify({ kind, args }) })).json() as Promise<any>;
const DATE = "2026-11-11";
let db: any;

const story = (id: number, o: Record<string, unknown> = {}) => {
  const s = { id, section: "tech", kind: "news", ticker: null, status: "shortlist", feed_heading: "Acme raises guidance", feed_snippet: "", article_url: "https://example.com/long", feed_published_at: null, ...o };
  return db.exec(
    `INSERT INTO stories (id, digest_date, section, feed, ticker, kind, url, article_url, feed_heading, feed_snippet, feed_published_at, status)
     VALUES (?, ?, ?, 'hn', ?, ?, 'u', ?, ?, ?, ?, ?)`,
    s.id, DATE, s.section, s.ticker, s.kind, s.article_url, s.feed_heading, s.feed_snippet, s.feed_published_at, s.status,
  );
};
const row = async (id: number) => (await db.exec("SELECT * FROM stories WHERE id = ?", id))[0];
const calls = async () => (await db.exec("SELECT kind, target FROM fake_calls ORDER BY rowid")) as { kind: string; target: string }[];

beforeEach(async () => {
  await call("now", null); // wakes the Durable Object: its constructor migrates
  db = await harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });
  await db.exec(SCHEMA);
  for (const t of ["stories", "digests", "usage_log", "positions", "position_quotes", "fake_calls", "fake_rules"]) await db.exec(`DELETE FROM ${t}`);
  await db.exec(`INSERT INTO digests (date, interests, started_at) VALUES (?, '## Topics\n- high: IA, Cloud\n', 1)`, DATE);
});

test("article text is stripped of page furniture, decoded and capped at 12,000 chars", async () => {
  const a = await call("article", { kind: "news", article_url: "https://example.com/long", feed_snippet: "" });
  expect(a.basis).toBe("article");
  expect(a.text).toContain("raised its guidance");
  expect(a.text).toContain("Fish & chips");
  expect(a.text).not.toMatch(/JUNK|junk\(\)/);
  expect((await call("article", { kind: "news", article_url: "https://example.com/huge", feed_snippet: "" })).text).toHaveLength(12_000);
});

test("a paywall stub, a 404 or a thrown fetch falls back to the snippet; no snippet means nothing", async () => {
  const snippet = "Acme Corp raised its guidance after a strong quarter, said a short note.";
  expect(await call("article", { kind: "news", article_url: "https://example.com/paywall", feed_snippet: snippet })).toEqual({ basis: "snippet", text: snippet });
  await db.exec("INSERT INTO fake_rules VALUES ('/long', 404)");
  expect((await call("article", { kind: "news", article_url: "https://example.com/long", feed_snippet: snippet })).basis).toBe("snippet");
  expect((await call("article", { kind: "news", article_url: "https://example.com/long", feed_snippet: "short" })).basis).toBeNull();
  expect((await call("article", { kind: "news", article_url: "https://nope.invalid/", feed_snippet: snippet })).basis).toBe("snippet");
});

test("earnings read index.json then exhibit 99.1; a filing without it uses the snippet", async () => {
  const a = await call("article", { kind: "earnings", article_url: "https://sec.example/f1/", feed_snippet: "" });
  expect(a.basis).toBe("article");
  expect(a.text).toContain("$57.0 billion");
  expect((await calls()).map((c) => c.target)).toEqual(["https://sec.example/f1/index.json", "https://sec.example/f1/x-ex991.htm"]);
  const snippet = "8-K Item 2.02: Results of Operations and Financial Condition for the quarter.";
  expect(await call("article", { kind: "earnings", article_url: "https://sec.example/f2/", feed_snippet: snippet })).toEqual({ basis: "snippet", text: snippet });
});

test("read_story writes the Story up, stores it, ends the run, and a replay is free", async () => {
  await story(1);
  const r = await call("read_story", { id: 1 });
  expect(r.result).toEqual({ story_id: 1, status: "written", basis: "article", headline: "Acme eleva su previsión de ingresos" });
  expect(r.control).toEqual({ terminate: true });
  expect(r.usage).toBeDefined();
  expect(await row(1)).toMatchObject({ status: "written", write_basis: "article", subject: "Acme", summary: expect.stringContaining("previsión") });
  expect((await row(1)).article_chars).toBeGreaterThan(400);
  expect((await db.exec("SELECT calls FROM usage_log WHERE phase = 'writer'"))[0].calls).toBe(1);
  expect((await db.exec("SELECT chunk_reads FROM digests"))[0].chunk_reads).toBe(1);

  const before = (await calls()).length;
  const again = await call("read_story", { id: 1 });
  expect(again.result).toEqual(r.result);
  expect(again.control).toEqual({ terminate: true });
  expect(await calls()).toHaveLength(before); // no fetch, no model call
  expect((await db.exec("SELECT chunk_reads FROM digests"))[0].chunk_reads).toBe(2);
});

test("a Markets Story takes its subject from positions, never from the model", async () => {
  await db.exec("INSERT INTO positions (ticker, name) VALUES ('ACME', 'Acme Corp')");
  await story(2, { section: "markets", ticker: "ACME" });
  expect((await call("read_story", { id: 2 })).result.status).toBe("written");
  expect((await row(2)).subject).toBe("ACME · Acme Corp");
});

test("an unreadable Article with no usable snippet is marked unreadable with no model call", async () => {
  await story(3, { article_url: "https://example.com/paywall", feed_snippet: "tiny" });
  expect((await call("read_story", { id: 3 })).result).toEqual({ story_id: 3, status: "unreadable" });
  expect((await row(3)).status).toBe("unreadable");
  expect((await calls()).filter((c) => c.kind === "ai")).toHaveLength(0);
});

test("a snippet-only Story is written with basis snippet", async () => {
  await story(4, { article_url: "https://example.com/paywall", feed_snippet: "Acme Corp raised its guidance after a strong quarter, said a short note." });
  expect((await call("read_story", { id: 4 })).result).toMatchObject({ status: "written", basis: "snippet" });
  expect((await row(4)).article_chars).toBeNull();
});

test("invalid writer output twice throws write_up_invalid and parks the Story as write_failed", async () => {
  await story(5, { feed_heading: "[badjson] Acme" });
  const r = await call("read_story", { id: 5 });
  expect(r.error).toMatch(/write_up_invalid/);
  expect((await row(5)).status).toBe("write_failed");
  expect((await calls()).filter((c) => c.kind === "ai")).toHaveLength(2);
  expect((await call("read_story", { id: 5 })).result).toEqual({ story_id: 5, status: "write_failed" }); // not retried
});

test("not_on_shortlist: unknown id or a Story that is not shortlisted", async () => {
  await story(6, { status: "new" });
  expect((await call("read_story", { id: 99 })).error).toMatch(/not_on_shortlist/);
  expect((await call("read_story", { id: 6 })).error).toMatch(/not_on_shortlist/);
});

test("past 34 subrequests the chunk stops: chunk_budget_spent, chunk_stop set, still terminates", async () => {
  await story(7);
  const r = await call("read_story", { id: 7, used: 35 });
  expect(r.result).toEqual({ story_id: 7, status: "chunk_budget_spent" });
  expect(r.control).toEqual({ terminate: true });
  expect((await db.exec("SELECT chunk_stop FROM digests"))[0].chunk_stop).toBe("budget");
  expect((await row(7)).status).toBe("shortlist");
  expect(await calls()).toHaveLength(0);
});

test("a spent neuron budget stops the chunk with chunk_stop neurons", async () => {
  await db.exec("INSERT INTO usage_log (digest_date, phase, model, neurons) VALUES (?, 'score', 'm', 9000)", DATE);
  await story(8);
  expect((await call("read_story", { id: 8 })).result.status).toBe("chunk_budget_spent");
  expect((await db.exec("SELECT chunk_stop FROM digests"))[0].chunk_stop).toBe("neurons");
});
