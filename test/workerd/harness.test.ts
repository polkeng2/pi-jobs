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
