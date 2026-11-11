// Worker fetch router: guard, route, at most one RPC, render. No cloudflare:* imports, so it runs in Node tests.
import { digestPage, emptyPage, messagePage, searchPage } from "./page.ts";
import { safeHttpUrl } from "./html.ts";
import { searchQuery } from "./storage.ts";

type Access = { access?: { aud?: string } };
type PageEnv = { ACCESS_AUD?: string; SIGNAL: { getByName(n: string): any } };

const ID = /^[1-9][0-9]{0,15}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: object, status = 200) => Response.json(body, { status, headers: SAFE });
const madridToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

function htmlResponse(render: (nonce: string) => string, status = 200) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response(render(nonce), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src https:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "same-origin",
      ...SAFE,
    },
  });
}
const page = (text: string, status: number, link = false) => htmlResponse((n) => messagePage(text, n, link), status);
const notFound = () => page("Página no encontrada.", 404);
const jsonl = (body: string, name: string) =>
  new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, ...SAFE },
  });

export async function route(req: Request, env: PageEnv, ctx: Access): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const isVote = /^\/stories\/[^/]+\/vote$/.test(path);
  if (!env.ACCESS_AUD || ctx.access?.aud !== env.ACCESS_AUD) {
    return isVote ? json({ error: "forbidden" }, 403) : new Response("Forbidden", { status: 403, headers: SAFE });
  }
  const m = req.method;
  const stub = () => env.SIGNAL.getByName("signal");
  const wrap = async (fn: () => Promise<Response>, err: () => Response) => {
    try {
      return await fn();
    } catch {
      return err();
    }
  };
  const unavailable = () => page("Signal no responde. Recarga en un momento.", 500);
  const only = (method: string, fn: () => Promise<Response> | Response) =>
    m === method ? wrap(async () => fn(), unavailable) : new Response("Method Not Allowed", { status: 405, headers: { Allow: method, ...SAFE } });
  const today = madridToday();

  if (path === "/") {
    return only("GET", async () => {
      const v = await stub().digestView(null);
      return htmlResponse((n) => (v ? digestPage(v, n, { isLatest: true, today }) : emptyPage(n)));
    });
  }
  const d = /^\/d\/([^/]+)$/.exec(path);
  if (d) {
    return only("GET", async () => {
      const v = DATE.test(d[1]!) ? await stub().digestView(d[1]) : null;
      return v
        ? htmlResponse((n) => digestPage(v, n, { isLatest: false, today }))
        : htmlResponse((n) => messagePage("No hay Digest de este día.", n, true), 404);
    });
  }
  if (path === "/search") {
    return only("GET", async () => {
      const q = (url.searchParams.get("q") ?? "").slice(0, 200);
      const rows = searchQuery(q) ? await stub().searchStories(q) : null;
      return htmlResponse((n) => searchPage(q, rows, n, today));
    });
  }
  if (isVote) {
    if (m !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST", ...SAFE } });
    const id = path.split("/")[2]!;
    if (req.headers.get("Origin") !== url.origin || req.headers.get("Content-Type")?.split(";")[0]!.trim().toLowerCase() !== "application/json") {
      return json({ error: "forbidden" }, 403);
    }
    if (!ID.test(id) || !Number.isSafeInteger(Number(id))) return json({ error: "not_found" }, 404);
    const body = await req.json().catch(() => null);
    const v = (body as { vote?: unknown } | null)?.vote;
    if (v !== 1 && v !== -1) return json({ error: "invalid_vote" }, 400);
    return wrap(async () => {
      const r = await stub().vote(Number(id), v);
      return r ? json(r) : json({ error: "not_found" }, 404);
    }, () => json({ error: "unavailable" }, 500));
  }
  const g = /^\/go\/([^/]+)$/.exec(path);
  if (g) {
    return only("GET", async () => {
      if (!ID.test(g[1]!) || !Number.isSafeInteger(Number(g[1]))) return notFound();
      const site = req.headers.get("Sec-Fetch-Site");
      const log = (site === "same-origin" || site === "none") && !req.headers.has("Sec-Purpose");
      const stored = await stub().openStory(Number(g[1]), log);
      const target = stored && safeHttpUrl(stored);
      return target ? new Response(null, { status: 302, headers: { Location: target.href, ...SAFE } }) : notFound();
    });
  }
  if (path === "/export/votes.jsonl") return only("GET", async () => jsonl(await stub().exportVotes(), "votes.jsonl"));
  if (path === "/export/near-miss.jsonl") return only("GET", async () => jsonl(await stub().exportNearMiss(), "near-miss.jsonl"));
  return notFound();
}
