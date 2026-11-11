// The Daily Run driver end to end: cron, phases, write chunks, deadline. Fetch is a stub until #28.
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { SCHEMA, shortlistStory } from "../fixtures.ts";

const harness = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});
beforeAll(() => harness.listen());
afterAll(() => harness.close());

const DATE = "2026-03-02";
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);

beforeEach(async () => {
  await harness.reset();
  const env: any = await harness.getWorker().getEnv();
  await env.KV.put("interests.md", "## Positions\n- ACME | Acme Corp\n");
});

const storage = () => harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });
async function setNow(ms: number) {
  const db = await storage();
  await db.exec(SCHEMA);
  await db.exec("DELETE FROM fake_now");
  await db.exec("INSERT INTO fake_now VALUES (?)", ms);
}
const trigger = () => harness.getWorker().scheduled({ cron: "0 7 * * *", scheduledTime: new Date(at("07:00")) });

/** Polls until the Digest for DATE is published, then returns its row. */
async function digest(timeoutMs = 20_000) {
  const db = await storage();
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const [row] = await db.exec("SELECT * FROM digests WHERE date = ? AND published_at IS NOT NULL", DATE);
    if (row) return row as any;
  }
  throw new Error(`no Digest: ${JSON.stringify(await db.exec("SELECT phase, write_chunk, write_failed, chunk_reads, chunk_stop FROM digests"))}`);
}

test("cron to Digest: every phase runs, at most 40 calls per dispatch", async () => {
  await setNow(at("07:00"));
  await trigger();
  const row = await digest();
  expect(row).toMatchObject({ phase: "done", status: "complete" });
  expect(row.db_bytes).toBeGreaterThan(0);
  const db = await storage();
  const perDispatch = await db.exec(
    "SELECT dispatch, COUNT(*) AS n FROM fake_calls WHERE kind IN ('ai','fetch') GROUP BY dispatch ORDER BY n DESC LIMIT 1",
  );
  expect((perDispatch[0] as any)?.n ?? 0).toBeLessThanOrEqual(40);
});

test("a second trigger for the same date is a no-op", async () => {
  await setNow(at("07:00"));
  await trigger();
  const first = await digest();
  await trigger();
  await new Promise((r) => setTimeout(r, 1000));
  const db = await storage();
  expect(await db.exec("SELECT published_at, started_at FROM digests")).toEqual([
    { published_at: first.published_at, started_at: first.started_at },
  ]);
});

/** Wakes the object (its constructor migrates), then shortlists Stories for DATE. */
async function seed(stories: Parameters<typeof shortlistStory>[1][]) {
  await harness.fetch("/fake", { method: "POST", body: JSON.stringify({ kind: "now" }) });
  const db = await storage();
  for (const s of stories) await db.exec(...shortlistStory(DATE, s));
}
const aiCalls = async () =>
  (await (await storage()).exec("SELECT target FROM fake_calls WHERE kind = 'ai'")).map((r: any) => r.target as string);

test("the orchestrator picks from the shortlist and read_story writes each Story", async () => {
  await setNow(at("07:00"));
  await seed([{ id: 1, heading: "Acme ships a thing" }, { id: 2, heading: "Acme raises guidance" }]);
  await trigger();
  expect(await digest(30_000)).toMatchObject({ status: "complete", write_chunk: 1, write_failed: 0 });
  const db = await storage();
  expect(await db.exec("SELECT status FROM stories ORDER BY id")).toEqual([{ status: "written" }, { status: "written" }]);
  expect((await aiCalls()).filter((t) => t.endsWith("+tools"))).toHaveLength(1);
  expect((await db.exec("SELECT calls, input_tokens FROM usage_log WHERE phase = 'orchestrator'"))[0]).toEqual({ calls: 1, input_tokens: 500 });
});

test("[nopick] in chunk 1: the retry reads nothing too, code reads the list, earnings included, Digest partial", async () => {
  await setNow(at("07:00"));
  await seed([
    { id: 1, heading: "[nopick] Acme ships a thing" },
    { id: 2, heading: "8-K Item 2.02: Results", section: "markets", ticker: "ACME", kind: "earnings", url: "https://sec.example/f1/", score: 100 },
  ]);
  await trigger();
  expect(await digest(30_000)).toMatchObject({ status: "partial", write_chunk: 1, write_failed: 2 });
  expect(await (await storage()).exec("SELECT id, status FROM stories ORDER BY id")).toEqual([
    { id: 1, status: "written" }, { id: 2, status: "written" },
  ]);
  expect((await aiCalls()).filter((t) => t.endsWith("+tools"))).toHaveLength(2); // the chunk and its retry
});

test("past 07:50 UTC the phase jumps to publish and the Digest is partial", async () => {
  await setNow(at("07:55"));
  await (await storage()).exec("INSERT INTO fake_rules VALUES ('throw:fetch', 0)"); // fires only if fetch runs
  await trigger();
  const row = await digest();
  expect(row).toMatchObject({ phase: "done", status: "partial" });
  expect(row.notice).toBeTruthy();
  expect(await (await storage()).exec("SELECT * FROM fake_calls WHERE dispatch = 'hook'")).toEqual([]);
});

test("the 07:50 deadline aborts a live write session, then the partial Digest is published", async () => {
  await setNow(at("07:00"));
  await seed([{ id: 1, heading: "[hang] Acme ships a thing" }]);
  await trigger();
  const db = await storage();
  const pending = async (session: string) =>
    (await (await harness.fetch("/fake", { method: "POST", body: JSON.stringify({ kind: "pending", args: session }) })).json()) as any[];
  let session = "";
  for (const end = Date.now() + 20_000; !session && Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    session = ((await db.exec("SELECT session_id FROM digests"))[0] as any)?.session_id ?? "";
  }
  expect(session).not.toBe("");
  await new Promise((r) => setTimeout(r, 500));
  expect(await pending(session)).toHaveLength(1); // the run is live and unanswered
  await setNow(at("07:55")); // the next dispatch finds the deadline passed
  const row = await digest(30_000);
  expect(row).toMatchObject({ phase: "done", status: "partial" });
  expect(await pending(session)).toEqual([]); // aborted
  expect(await db.exec("SELECT status FROM stories")).toEqual([{ status: "shortlist" }]);
});

test("a failed Feed, an unreadable Article and [badjson] together: partial Digest, Stories settle as the tool contract says", async () => {
  await setNow(at("07:00"));
  await seed([
    { id: 1, heading: "Acme ships a thing" },
    { id: 2, heading: "Acme paywalled" },
    { id: 3, heading: "[badjson] Acme" },
  ]);
  const db = await storage();
  await db.exec("UPDATE stories SET article_url = 'https://example.com/paywall' WHERE id = 2");
  await db.exec("INSERT INTO feed_fetches (digest_date, feed_key, status, attempts, error) VALUES (?, 'hn', 'failed', 2, 'http 500')", DATE);
  await trigger();
  const row = await digest(30_000);
  expect(row).toMatchObject({ status: "partial", phase: "done" });
  expect(row.notice).toMatch(/fuente/);
  expect(row.notice).toMatch(/redactar/);
  expect(await db.exec("SELECT id, status, published_at IS NOT NULL AS pub FROM stories ORDER BY id")).toEqual([
    { id: 1, status: "written", pub: 1 }, { id: 2, status: "unreadable", pub: 0 }, { id: 3, status: "write_failed", pub: 0 },
  ]);
});
