import { expect, test } from "vitest";
import { migrate } from "../../src/schema.ts";
import { prune, search, searchQuery, vote } from "../../src/storage.ts";
import { makeSql } from "../sql.ts";

const db = () => {
  const { sql, transactionSync } = makeSql();
  migrate(sql, transactionSync);
  return { sql, transactionSync };
};
const story = (sql: any, id: number, date: string, headline: string, published: number | null) => {
  sql.exec(
    `INSERT INTO stories (id, digest_date, section, feed, url, article_url, feed_heading, headline, summary, why_it_matters, subject)
     VALUES (?, ?, 'tech', 'hn', 'https://example.com/' || ?, 'https://example.com/' || ?, 'h', ?, 'resumen', 'importa', 'sujeto')`,
    id, date, id, id, headline,
  );
  if (published) sql.exec("UPDATE stories SET published_at = ? WHERE id = ?", published, id);
};

test("migrate is idempotent and records the version in meta", () => {
  const { sql, transactionSync } = db();
  migrate(sql, transactionSync);
  expect(sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").one()).toEqual({ value: "1" });
});

test("searchQuery splits tokens, quotes them, caps at 8, never passes raw text", () => {
  expect(searchQuery('  nvidia  "chips" ')).toBe('"nvidia"* "chips"*');
  expect(searchQuery("a b c d e f g h i j")).toBe('"a"* "b"* "c"* "d"* "e"* "f"* "g"* "h"*');
  expect(searchQuery('" ""')).toBeNull();
});

test("search finds only published Stories, accents folded, newest first", () => {
  const { sql } = db();
  story(sql, 1, "2026-01-01", "Inversión en chips", 1);
  story(sql, 2, "2026-01-02", "Inversión sin publicar", null);
  story(sql, 3, "2026-01-03", "Otra inversión", 1);
  expect(search(sql, 'inversion OR "x').map((r: any) => r.id)).toEqual([]);
  expect(search(sql, "inversion").map((r: any) => r.id)).toEqual([3, 1]);
  expect(search(sql, "   ")).toEqual([]);
});

test("vote toggles, returns the state after, and ignores unpublished Stories", () => {
  const { sql } = db();
  story(sql, 1, "2026-01-01", "a", 1);
  story(sql, 2, "2026-01-01", "b", null);
  expect(vote(sql, 1, 1, 10)).toBe(1);
  expect(vote(sql, 1, -1, 11)).toBe(-1);
  expect(vote(sql, 1, -1, 12)).toBeNull();
  expect(vote(sql, 2, 1, 10)).toBeNull();
  expect(sql.exec("SELECT vote FROM stories WHERE id = 2").one()).toEqual({ vote: null });
  // a vote must not disturb the FTS index
  expect(search(sql, "a").map((r: any) => r.id)).toEqual([1]);
});

test("prune drops old unpublished data, keeps published Stories and Anthropic seen_urls", () => {
  const { sql } = db();
  story(sql, 1, "2025-01-01", "viejo publicado", 1);
  story(sql, 2, "2025-01-01", "viejo sin publicar", null);
  story(sql, 3, "2026-06-01", "nuevo sin publicar", null);
  sql.exec("INSERT INTO seen_urls VALUES ('a', 'anthropic', 1), ('b', 'hn', 1), ('c', 'hn', 9999999999999)");
  sql.exec("INSERT INTO position_quotes VALUES ('2025-01-01', 'ACME', 1, 1, 0), ('2026-06-01', 'ACME', 1, 1, 0)");
  sql.exec("INSERT INTO feed_fetches (digest_date, feed_key) VALUES ('2025-01-01', 'hn'), ('2026-06-01', 'hn')");
  sql.exec("INSERT INTO digests (date, interests, started_at) VALUES ('2025-01-01', '', 1), ('2026-06-01', '', 1)");
  prune(sql, "2026-03-01", 1000);
  const keys = (t: string, c: string) => sql.exec(`SELECT ${c} AS k FROM ${t} ORDER BY 1`).toArray().map((r: any) => r.k);
  expect(keys("stories", "id")).toEqual([1, 3]);
  expect(keys("seen_urls", "url_key")).toEqual(["a", "c"]);
  expect(keys("position_quotes", "digest_date")).toEqual(["2026-06-01"]);
  expect(keys("feed_fetches", "digest_date")).toEqual(["2026-06-01"]);
  expect(keys("digests", "date")).toEqual(["2026-06-01"]);
  expect(search(sql, "viejo").map((r: any) => r.id)).toEqual([1]);
});
