// The real Worker fetch handler: Access guard, route, Signal RPC, over the object's real SQLite.
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

const harness = createTestHarness({
  workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url) }],
});
beforeAll(() => harness.listen());
afterAll(() => harness.close());

const storage = () => harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });

beforeEach(async () => {
  await harness.reset();
  await harness.fetch("/fake", { method: "POST", body: JSON.stringify({ kind: "now" }) }); // wakes the object: it migrates
  const db = await storage();
  await db.exec("INSERT INTO digests (date, interests, started_at, published_at, status, phase) VALUES ('2026-03-02', '## Positions\n- ACME | Acme Corp', 0, 1, 'complete', 'done')");
  await db.exec(
    `INSERT INTO stories (id, digest_date, section, feed, url, article_url, feed_heading, headline, summary, why_it_matters, subject, display_order, status, published_at)
     VALUES (1, '2026-03-02', 'tech', 'hn', 'https://example.com/a', 'https://example.com/a', 'h', 'Titular publicado', 'Resumen de prueba', 'Importa', 'Chips', 1, 'written', 1)`,
  );
});

const vote = (headers: Record<string, string> = {}) =>
  harness.fetch("/stories/1/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-same-origin": "1", ...headers },
    body: JSON.stringify({ vote: 1 }),
  });

test("GET / serves the published Digest and a vote reaches the object", async () => {
  const res = await harness.fetch("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/html/);
  expect(await res.text()).toContain("Titular publicado");

  const v = await vote();
  expect(v.status).toBe(200);
  expect(await v.json()).toEqual({ vote: 1 });
  expect(await (await storage()).exec("SELECT vote FROM stories WHERE id = 1")).toEqual([{ vote: 1 }]);
});

test("a wrong Access aud is refused", async () => {
  expect((await harness.fetch("/", { headers: { "x-test-aud": "someone-else" } })).status).toBe(403);
  expect((await vote({ "x-test-aud": "someone-else" })).status).toBe(403);
  expect(await (await storage()).exec("SELECT vote FROM stories WHERE id = 1")).toEqual([{ vote: null }]);
});
