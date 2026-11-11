import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SCHEMA } from "../fixtures.ts";

const harness = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});
beforeAll(() => harness.listen());
afterAll(() => harness.close());

const call = async (kind: string, args: unknown) =>
  (await harness.fetch("/fake", { method: "POST", body: JSON.stringify({ kind, args }) })).json() as Promise<any>;

test("the fakes answer from their input and log every call", async () => {
  const db = await harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });
  await db.exec(SCHEMA);
  await db.exec("INSERT INTO fake_now VALUES (1234)");

  expect((await call("now", null)).now).toBe(1234);
  const clef = await call("clef", {
    state: { story: { heading: "Acme [up] [gate]" } },
    questions: { relevance: { type: "score" }, is_news: { type: "noul" } },
  });
  expect(clef.answers.relevance.score).toBeGreaterThan(3);
  expect(clef.answers.is_news.noul).toBeLessThan(0.4);
  expect((await call("fetch", "https://nope.invalid/")).error).toMatch(/unknown URL/);

  const calls = await db.exec("SELECT kind FROM fake_calls ORDER BY rowid");
  expect(calls.map((r: any) => r.kind)).toEqual(["ai", "fetch"]);
});

test("migrations and FTS triggers run under the real authorizer", async () => {
  await call("now", null); // wakes the Durable Object: its constructor migrates
  const db = await harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });
  const hits = async () => await db.exec(`SELECT rowid FROM story_search WHERE story_search MATCH '"inversion"*'`);
  expect((await db.exec("SELECT value FROM meta WHERE key = 'schema_version'"))[0]).toEqual({ value: "1" });
  await db.exec(`INSERT INTO stories (id, digest_date, section, feed, url, article_url, feed_heading, headline, summary, why_it_matters, subject)
    VALUES (1, '2026-01-01', 'tech', 'hn', 'u', 'u', 'h', 'Inversión en chips', 's', 'w', 'x')`);
  expect(await hits()).toEqual([]);
  await db.exec("UPDATE stories SET published_at = 1 WHERE id = 1");
  expect(await hits()).toEqual([{ rowid: 1 }]);
  await db.exec("DELETE FROM stories WHERE id = 1");
  expect(await hits()).toEqual([]);
});
