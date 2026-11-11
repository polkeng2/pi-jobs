// Crash and throw inside a code dispatch. Slow (a crash recovers ~30 s later), so kept apart.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage = () => harness.getWorker().getDurableObjectStorage("SIGNAL", { name: "signal" });

beforeEach(async () => {
  await harness.reset();
  const env: any = await harness.getWorker().getEnv();
  await env.KV.put("interests.md", "## Positions\n- ACME | Acme Corp\n");
});

async function arm(rule: string) {
  const db = await storage();
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

test("a dispatch that keeps throwing still ends in a Digest, through the deadline", async () => {
  await arm("throw:fetch");
  await hooked("throw");
  // onJobError rescheduled it; the rule stays, so only the 07:50 deadline gets past fetch.
  await (await storage()).exec("UPDATE fake_now SET ms = ?", at("07:55"));
  expect(await digest(100_000)).toMatchObject({ phase: "done", status: "partial" });
}, 150_000);
