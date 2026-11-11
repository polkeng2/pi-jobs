// Crash and throw inside a dispatch or a tool. Slow (a crash recovers ~30 s later), so kept apart.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage = () => harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });

beforeEach(async () => {
  await harness.reset();
  const env: any = await harness.getWorker().getEnv();
  await env.KV.put("interests.md", "## Positions\n- ACME | Acme Corp\n");
});

async function arm(rule: string, stories: Parameters<typeof shortlistStory>[1][] = []) {
  await harness.fetch("/fake", { method: "POST", body: JSON.stringify({ kind: "now" }) }); // wakes the object: it migrates
  const db = await storage();
  for (const s of stories) await db.exec(...shortlistStory(DATE, s));
  await db.exec(SCHEMA);
  await db.exec("INSERT INTO fake_now VALUES (?)", at("07:00"));
  await db.exec("INSERT INTO fake_rules VALUES (?, 0)", rule);
  await harness.getWorker().scheduled({ cron: "0 7 * * *", scheduledTime: new Date(at("07:00")) });
}

async function until<T>(q: string, timeoutMs: number): Promise<T> {
  const db = await storage();
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(300)) {
    const [row] = await db.exec(q);
    if (row) return row as T;
  }
  throw new Error(`timed out: ${q}`);
}
const hooked = (kind: string) => until(`SELECT * FROM fake_calls WHERE dispatch = 'hook' AND kind = '${kind}'`, 20_000);
const digest = (ms: number) => until<any>(`SELECT * FROM digests WHERE date = '${DATE}' AND published_at IS NOT NULL`, ms);

test("a crash inside a code dispatch: the job runs again and the Digest appears", async () => {
  await arm("crash:fetch");
  await hooked("crash");
  await (await storage()).exec("DELETE FROM fake_rules");
  expect(await digest(100_000)).toMatchObject({ phase: "done", status: "complete" });
}, 150_000);

test("a crash inside read_story: pi re-runs the tool, no second writer call, and the Digest appears", async () => {
  await arm("crash:read_story", [{ id: 1, heading: "Acme ships a thing" }]);
  await hooked("crash");
  // chunk_reads counts read_story executions: the one cut off and pi's re-run.
  expect(await digest(100_000)).toMatchObject({ phase: "done", status: "complete", chunk_reads: 2 });
  const db = await storage();
  expect((await db.exec("SELECT status FROM stories"))[0]).toEqual({ status: "written" });
  const writer = await db.exec("SELECT * FROM fake_calls WHERE kind = 'ai' AND target NOT LIKE '%+tools'");
  expect(writer).toHaveLength(1);
}, 150_000);

test("a dispatch that keeps throwing still ends in a Digest, through the deadline", async () => {
  await arm("throw:fetch");
  await hooked("throw");
  // onJobError rescheduled it; the rule stays, so only the 07:50 deadline gets past fetch.
  await (await storage()).exec("UPDATE fake_now SET ms = ?", at("07:55"));
  expect(await digest(100_000)).toMatchObject({ phase: "done", status: "partial" });
}, 150_000);
