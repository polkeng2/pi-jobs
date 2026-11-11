import { expect, test } from "vitest";
import { route } from "../../src/router.ts";
import { html, safeHttpUrl } from "../../src/html.ts";
import { migrate } from "../../src/schema.ts";
import { search, vote } from "../../src/storage.ts";
import * as view from "../../src/view.ts";
import { makeSql } from "../sql.ts";

// A Signal look-alike over node:sqlite, so routes run the real SQL. calls records every RPC.
function setup() {
  const { sql, transactionSync } = makeSql();
  migrate(sql, transactionSync);
  const calls: string[] = [];
  const rpc = {
    digestView: (d: string | null) => (calls.push("digestView"), view.digestView(sql, d)),
    searchStories: (q: string) => (calls.push("searchStories"), search(sql, q)),
    vote: (id: number, v: 1 | -1) => {
      calls.push("vote");
      const r = vote(sql, id, v, 1);
      return r === null && !view.openStory(sql, id, false, 1) ? null : { vote: r };
    },
    openStory: (id: number, log: boolean) => (calls.push("openStory"), view.openStory(sql, id, log, 1)),
    exportVotes: () => (calls.push("exportVotes"), view.exportVotes(sql)),
    exportNearMiss: () => (calls.push("exportNearMiss"), view.exportNearMiss(sql)),
  };
  const env = { ACCESS_AUD: "aud1", SIGNAL: { getByName: () => rpc } };
  const ctx = { access: { aud: "aud1" } };
  const get = (path: string, init: RequestInit = {}, c: any = ctx, e: any = env) =>
    route(new Request(`https://signal.test${path}`, init), e, c);
  return { sql, calls, env, ctx, get };
}

const digest = (sql: any, date = "2026-11-03", interests = "## Positions\n- ACME | Acme Corp") =>
  sql.exec("INSERT INTO digests (date, interests, started_at, published_at, status, phase) VALUES (?, ?, 0, 1, 'complete', 'done')", date, interests);
const story = (sql: any, id: number, o: { headline?: string; url?: string; section?: string; ticker?: string | null; published?: boolean; date?: string } = {}) => {
  sql.exec(
    `INSERT INTO stories (id, digest_date, section, feed, ticker, url, article_url, feed_heading, feed_snippet, headline, summary, why_it_matters, subject, display_order, status)
     VALUES (?, ?, ?, 'hn', ?, ?, ?, 'FEEDHEAD', 'FEEDSNIP', ?, 'Resumen de prueba', 'Importa', 'Chips', ?, 'written')`,
    id, o.date ?? "2026-11-03", o.section ?? "tech", o.ticker ?? null, o.url ?? "https://example.com/a", "https://example.com/a", o.headline ?? "Titular", id,
  );
  if (o.published !== false) sql.exec("UPDATE stories SET published_at = 1 WHERE id = ?", id);
};
const voteReq = (o: Record<string, string> = {}, body = '{"vote":1}') => ({
  method: "POST",
  headers: { Origin: "https://signal.test", "Content-Type": "application/json", ...o },
  body,
});

const ROUTES: [string, RequestInit][] = [
  ["/", {}], ["/d/2026-11-03", {}], ["/search?q=a", {}], ["/stories/1/vote", voteReq()],
  ["/go/1", {}], ["/export/votes.jsonl", {}], ["/export/near-miss.jsonl", {}],
];

test("guard: no ctx.access, wrong aud or missing secret gives 403 on each route with no RPC", async () => {
  const t = setup();
  for (const [path, init] of ROUTES) {
    expect((await t.get(path, init, {})).status, path).toBe(403);
    expect((await t.get(path, init, { access: { aud: "other" } })).status, path).toBe(403);
    expect((await t.get(path, init, t.ctx, { ...t.env, ACCESS_AUD: undefined })).status, path).toBe(403);
    expect((await t.get(path, init, { access: {} }, { ...t.env, ACCESS_AUD: undefined })).status, path).toBe(403);
  }
  expect(t.calls).toEqual([]);
});

test("vote: foreign, absent Origin or wrong content type is 403 with no RPC", async () => {
  const t = setup();
  digest(t.sql);
  story(t.sql, 1);
  for (const o of [{ Origin: "https://evil.test" }, { Origin: "" }, { "Content-Type": "text/plain" }]) {
    const r = await t.get("/stories/1/vote", voteReq(o));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden" });
  }
  const noOrigin = voteReq();
  delete (noOrigin.headers as any).Origin;
  expect((await t.get("/stories/1/vote", noOrigin)).status).toBe(403);
  expect(t.calls).toEqual([]);
});

test("vote toggles, rejects bad bodies, and 404s unknown or unpublished Stories", async () => {
  const t = setup();
  digest(t.sql);
  story(t.sql, 1);
  story(t.sql, 2, { published: false });
  const post = async (id: string, body: string) => {
    const r = await t.get(`/stories/${id}/vote`, voteReq({}, body));
    return [r.status, await r.json()];
  };
  expect(await post("1", '{"vote":1}')).toEqual([200, { vote: 1 }]);
  expect(await post("1", '{"vote":1}')).toEqual([200, { vote: null }]);
  expect(await post("1", '{"vote":-1}')).toEqual([200, { vote: -1 }]);
  expect(await post("1", '{"vote":2}')).toEqual([400, { error: "invalid_vote" }]);
  expect(await post("1", "nope")).toEqual([400, { error: "invalid_vote" }]);
  expect(await post("2", '{"vote":1}')).toEqual([404, { error: "not_found" }]);
  expect(await post("99", '{"vote":1}')).toEqual([404, { error: "not_found" }]);
  const n = t.calls.length;
  expect(await post("01", '{"vote":1}')).toEqual([404, { error: "not_found" }]);
  expect(t.calls.length).toBe(n);
  expect((await t.get("/stories/1/vote")).status).toBe(405);
});

test("/go: cross-site redirects without logging; same-origin and none log; javascript: URL is 404", async () => {
  const t = setup();
  digest(t.sql);
  story(t.sql, 1);
  story(t.sql, 2, { url: "javascript:alert(1)" });
  const clicks = () => t.sql.exec("SELECT count(*) AS n FROM clicks").toArray()[0].n;
  const go = (h: Record<string, string>, id = 1) => t.get(`/go/${id}`, { headers: h });

  let r = await go({ "Sec-Fetch-Site": "cross-site" });
  expect([r.status, r.headers.get("Location")]).toEqual([302, "https://example.com/a"]);
  expect((await go({})).status).toBe(302);
  expect((await go({ "Sec-Fetch-Site": "same-origin", "Sec-Purpose": "prefetch" })).status).toBe(302);
  expect(clicks()).toBe(0);
  await go({ "Sec-Fetch-Site": "same-origin" });
  await go({ "Sec-Fetch-Site": "none" });
  expect(clicks()).toBe(2);
  r = await go({ "Sec-Fetch-Site": "same-origin" }, 2);
  expect(r.status).toBe(404);
  expect(r.headers.get("Location")).toBeNull();
  expect((await go({}, 99)).status).toBe(404);
  expect((await t.get("/go/abc")).status).toBe(404);
});

test("a <script> Headline renders escaped and a javascript: URL gets no link", async () => {
  const t = setup();
  digest(t.sql);
  story(t.sql, 1, { headline: "<script>alert(1)</script>" });
  story(t.sql, 2, { headline: "Sin enlace", url: "javascript:alert(1)" });
  const body = await (await t.get("/")).text();
  expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(body).not.toContain("<script>alert");
  expect(body).toContain('href="/go/1"');
  expect(body).not.toContain('href="/go/2"');
  expect(body).not.toContain("javascript:");
  expect(body).not.toMatch(/FEEDHEAD|FEEDSNIP/);
  expect(body).toContain("No es una recomendación de inversión.");
});

test("security headers carry a fresh nonce on every HTML response", async () => {
  const t = setup();
  const a = await t.get("/");
  const b = await t.get("/");
  const csp = a.headers.get("Content-Security-Policy")!;
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  expect(nonce).not.toBe(/script-src 'nonce-([^']+)'/.exec(b.headers.get("Content-Security-Policy")!)![1]);
  expect(csp).toContain(`style-src 'nonce-${nonce}'`);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(a.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(a.headers.get("Cache-Control")).toBe("no-store");
  expect(a.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const body = await a.text();
  expect(body).toContain("Todavía no hay ningún Digest");
  expect(body).not.toMatch(/ style=| on\w+=/);
});

test("routing: methods, paths, dates, ids, search", async () => {
  const t = setup();
  digest(t.sql);
  story(t.sql, 1, { headline: "Nvidia sube" });
  expect((await t.get("/", { method: "POST" })).status).toBe(405);
  expect((await t.get("/nope")).status).toBe(404);
  expect((await t.get("/favicon.ico")).status).toBe(404);
  expect((await t.get("/d/20261103")).status).toBe(404);
  expect((await t.get("/d/2026-11-04")).status).toBe(404);
  expect((await t.get("/d/2026-11-03")).status).toBe(200);
  expect(t.calls).toEqual(["digestView", "digestView"]);
  t.calls.length = 0;
  expect(await (await t.get("/search?q=%20%22")).text()).not.toContain("Sin resultados");
  expect(t.calls).toEqual([]);
  t.sql.exec("SELECT 1");
  expect(await (await t.get("/search?q=zzz")).text()).toContain("Sin resultados para «zzz».");
  const r = await t.get("/export/votes.jsonl");
  expect(r.headers.get("Content-Disposition")).toContain("attachment");
});

test("an RPC that throws gives 500 with no internals", async () => {
  const t = setup();
  const env = { ...t.env, SIGNAL: { getByName: () => ({ digestView: () => { throw new Error("secret boom"); } }) } };
  const r = await t.get("/", {}, t.ctx, env);
  expect(r.status).toBe(500);
  const body = await r.text();
  expect(body).toContain("Signal no responde");
  expect(body).not.toContain("secret boom");
});

test("digestView: cards from the day's interests, quote, status, nav, published only", () => {
  const { sql } = setup();
  digest(sql, "2026-11-01");
  digest(sql, "2026-11-03", "## Positions\n- ACME | Acme Corp\n- ZZZT | Zenith");
  digest(sql, "2026-11-05");
  sql.exec("UPDATE digests SET published_at = NULL WHERE date = '2026-11-05'");
  story(sql, 1, { section: "markets", ticker: "ACME" });
  story(sql, 2, { section: "markets", ticker: "ACME", published: false });
  sql.exec("INSERT INTO position_quotes VALUES ('2026-11-03', 'ACME', 12.5, 4.2, 1)");
  sql.exec("INSERT INTO feed_fetches (digest_date, feed_key, status) VALUES ('2026-11-03', 'news:ZZZT', 'done')");
  const v = view.digestView(sql, null)!;
  expect([v.date, v.prev, v.next]).toEqual(["2026-11-03", "2026-11-01", null]);
  expect(v.cards.map((c) => [c.ticker, c.newsStatus, c.stories.length])).toEqual([["ACME", "failed", 1], ["ZZZT", "done", 0]]);
  expect(v.cards[0]!.quote).toEqual({ close: 12.5, changePct: 4.2, strongMove: true });
  expect(view.digestView(sql, "2026-11-05")).toBeNull();
});

test("exports: votes carry strong_move and interests; near-miss picks below Stories", () => {
  const { sql } = setup();
  digest(sql);
  story(sql, 1, { section: "markets", ticker: "ACME" });
  sql.exec("INSERT INTO position_quotes VALUES ('2026-11-03', 'ACME', 1, 1, 1)");
  sql.exec("UPDATE stories SET vote = 1, clef_answers = '{\"a\":1}' WHERE id = 1");
  const lines = view.exportVotes(sql).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(["interests", "story"]);
  expect(lines[1]).toMatchObject({ id: 1, strong_move: true, vote: 1, clef_answers: { a: 1 } });
  story(sql, 2);
  story(sql, 3);
  sql.exec(`UPDATE stories SET status = 'below', signal_score = 45, clef_answers = '{"is_news":{"noul":0.9}}' WHERE id = 2`);
  sql.exec(`UPDATE stories SET status = 'below', signal_score = 10, clef_answers = '{"is_news":{"noul":0.9}}' WHERE id = 3`);
  expect(view.exportNearMiss(sql).trim().split("\n").map((l) => JSON.parse(l).id)).toEqual([2]);
});

test("html escapes interpolations, raw passes; safeHttpUrl rejects credentials and other schemes", () => {
  expect(String(html`<p>${'<b>"&\''}</p>`.s)).toBe("<p>&lt;b&gt;&quot;&amp;&#39;</p>");
  expect(html`${html`<i>x</i>`}`.s).toBe("<i>x</i>");
  expect(safeHttpUrl("https://u:p@example.com/")).toBeNull();
  expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  expect(safeHttpUrl("data:text/html,x")).toBeNull();
  expect(safeHttpUrl("http://example.com/a")?.hostname).toBe("example.com");
});
