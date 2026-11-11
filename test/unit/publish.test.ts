import { expect, test } from "vitest";
import { publishDigest } from "../../src/publish.ts";
import { migrate } from "../../src/schema.ts";
import { makeSql } from "../sql.ts";

const DATE = "2026-03-02";
const EARLY = Date.parse(`${DATE}T07:10:00Z`);
const LATE = Date.parse(`${DATE}T07:50:00Z`);

function setup(o: { now?: number; size?: number; digest?: string } = {}) {
  const { sql, transactionSync } = makeSql();
  migrate(sql, transactionSync);
  sql.exec(`INSERT INTO digests (date, interests, started_at${o.digest ? ", " + o.digest.split("=")[0] : ""}) VALUES (?, '', 0${o.digest ? ", " + o.digest.split("=")[1] : ""})`, DATE);
  const s = Object.assign(sql, { databaseSize: o.size ?? 4096 });
  const run = () => publishDigest({ sql: s, now: () => o.now ?? EARLY, transactionSync }, DATE);
  let n = 0;
  const story = (section: "tech" | "markets", score: number | null, x: { ticker?: string; kind?: string; status?: string } = {}) => {
    const id = ++n;
    sql.exec(
      `INSERT INTO stories (id, digest_date, section, feed, ticker, kind, url, article_url, feed_heading, status, signal_score)
       VALUES (?, ?, ?, 'hn', ?, ?, 'u', 'u', 'h', ?, ?)`,
      id, DATE, section, x.ticker ?? null, x.kind ?? "news", x.status ?? "written", score,
    );
    return id;
  };
  const rows = () => sql.exec("SELECT id, display_order AS o, published_at AS p FROM stories ORDER BY id").toArray();
  const digest = () => sql.exec("SELECT status, notice, published_at AS p, db_bytes AS b FROM digests").one();
  return { run, story, rows, digest, sql };
}

test("Tech: the top 20 written Stories by score, in that display order; the rest stay unpublished", () => {
  const t = setup();
  const ids = Array.from({ length: 22 }, (_, i) => t.story("tech", i)); // score = i
  t.story("tech", 99, { status: "shortlist" });
  expect(t.run()).toEqual({ status: "complete", tech: 20, markets: 0 });
  const pub = t.rows().filter((r) => r.p !== null);
  expect(pub).toHaveLength(20);
  expect(pub.find((r) => r.o === 1)!.id).toBe(ids[21]);
  expect(pub.find((r) => r.o === 20)!.id).toBe(ids[2]);
  expect(t.rows().filter((r) => r.p === null).map((r) => r.id)).toEqual([ids[0], ids[1], 23]);
});

test("Markets: per Position earnings first then score, at most 3", () => {
  const t = setup();
  const a1 = t.story("markets", 90, { ticker: "ACME" });
  const a2 = t.story("markets", 10, { ticker: "ACME", kind: "earnings" });
  const a3 = t.story("markets", 80, { ticker: "ACME" });
  const a4 = t.story("markets", 70, { ticker: "ACME" });
  const z1 = t.story("markets", 5, { ticker: "ZZZT" });
  expect(t.run()).toMatchObject({ tech: 0, markets: 4 });
  const order = (ids: number[]) => ids.map((id) => t.rows().find((r) => r.id === id)!);
  const [r1, r2, r3, r4, rz] = order([a1, a2, a3, a4, z1]);
  expect(r2.o).toBeLessThan(r1.o); // earnings leads
  expect(r1.o).toBeLessThan(r3.o);
  expect(r4.p).toBeNull(); // fourth ACME Story is cut
  expect(rz.p).not.toBeNull();
});

test("an empty day still produces a complete Digest row with db_bytes", () => {
  const t = setup({ size: 12345 });
  expect(t.run()).toEqual({ status: "complete", tech: 0, markets: 0 });
  expect(t.digest()).toEqual({ status: "complete", notice: null, p: EARLY, b: 12345 });
});

test("a second publish changes nothing", () => {
  const t = setup();
  t.story("tech", 1);
  t.run();
  const before = [t.rows(), t.digest()];
  t.run();
  expect([t.rows(), t.digest()]).toEqual(before);
});

test.each([
  ["a failed Feed", (t: ReturnType<typeof setup>) => t.sql.exec("INSERT INTO feed_fetches (digest_date, feed_key, status) VALUES (?, 'hn', 'failed')", DATE), /fuente/],
  ["a score_failed Story", (t: ReturnType<typeof setup>) => t.story("tech", null, { status: "score_failed" }), /puntuar/],
  ["a write_failed Story", (t: ReturnType<typeof setup>) => t.story("tech", 1, { status: "write_failed" }), /redactar/],
])("%s makes the Digest partial, with a Spanish notice", (_n, seed, re) => {
  const t = setup();
  seed(t);
  expect(t.run().status).toBe("partial");
  expect(t.digest().notice).toMatch(re);
});

test("a write chunk that failed twice makes it partial", () => {
  const t = setup({ digest: "write_failed=2" });
  expect(t.run().status).toBe("partial");
  expect(t.digest().notice).toMatch(/modelo/);
});

test("chunk_stop neurons makes it partial; chunk_stop budget alone does not", () => {
  const n = setup({ digest: "chunk_stop='neurons'" });
  expect(n.run().status).toBe("partial");
  expect(n.digest().notice).toMatch(/neuronas|IA/);
  expect(setup({ digest: "chunk_stop='budget'" }).run().status).toBe("complete");
});

test("the deadline: 07:50 UTC or later is partial", () => {
  const t = setup({ now: LATE });
  expect(t.run().status).toBe("partial");
  expect(t.digest().notice).toMatch(/hora límite/);
});

test("at 800 MB the notice gets a line, and the Digest stays complete", () => {
  const t = setup({ size: 800 * 1024 * 1024 });
  expect(t.run().status).toBe("complete");
  expect(t.digest().notice).toMatch(/800 MB/);
  const under = setup({ size: 800 * 1024 * 1024 - 1 });
  under.run();
  expect(under.digest().notice).toBeNull();
});
