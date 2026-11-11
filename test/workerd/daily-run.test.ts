// The Daily Run driver end to end: cron, phases, deadline. Chunks are stubs until #28-#33.
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { SCHEMA } from "../fixtures.ts";

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
  throw new Error("no Digest");
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

test("past 07:50 UTC the phase jumps to publish and the Digest is partial", async () => {
  await setNow(at("07:55"));
  await (await storage()).exec("INSERT INTO fake_rules VALUES ('throw:fetch', 0)"); // fires only if fetch runs
  await trigger();
  const row = await digest();
  expect(row).toMatchObject({ phase: "done", status: "partial" });
  expect(row.notice).toBeTruthy();
  expect(await (await storage()).exec("SELECT * FROM fake_calls WHERE dispatch = 'hook'")).toEqual([]);
});
