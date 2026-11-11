// Article text for read_story. workerd only: HTMLRewriter is native there.
import { isSubrequestLimit } from "./budget.ts";

export const MAX_ARTICLE_CHARS = 12_000;
export const MIN_ARTICLE_CHARS = 400;
const MIN_SNIPPET_CHARS = 40;

const SKIP = "script,style,noscript,svg,nav,header,footer,aside,form";
const BREAK = "p,div,li,br,h1,h2,h3,h4,h5,h6,tr,td,section,article";
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** Visible body text of an HTML response, whitespace collapsed, cut to the cap. */
export async function stripHtml(res: Response): Promise<string> {
  let out = "";
  let skip = 0;
  await new HTMLRewriter()
    .on(SKIP, { element(e) { skip++; e.onEndTag(() => void skip--); } })
    .on(BREAK, { element() { out += " "; } })
    .on("body", { text(t) { if (!skip) out += t.text; } })
    .transform(res)
    .arrayBuffer();
  return out.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]!).replace(/\s+/g, " ").trim().slice(0, MAX_ARTICLE_CHARS);
}

type Get = (url: string) => Promise<Response>;

async function html(get: Get, url: string): Promise<string | null> {
  try {
    const res = await get(url);
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
    return await stripHtml(res);
  } catch (e) {
    if (isSubrequestLimit(e)) throw e;
    return null; // timeout, redirect loop, network error: fall back
  }
}

/** The filing's exhibit 99.1: `index.json` next to the filing's folder URL, then the file whose name says ex99.1. */
async function earningsUrl(get: Get, filing: string): Promise<string | null> {
  try {
    const res = await get(new URL("index.json", filing).href);
    if (!res.ok) return null;
    const items: { name: string }[] = ((await res.json()) as any)?.directory?.item ?? [];
    const hit = items.find((i) => /ex-?99[-_.]?0?1.*\.html?$/i.test(i.name));
    return hit ? new URL(hit.name, filing).href : null;
  } catch (e) {
    if (isSubrequestLimit(e)) throw e;
    return null;
  }
}

export type ArticleText = { basis: "article" | "snippet"; text: string };

/** The Article, or the feed snippet when it cannot be read or is a stub under 400 chars. Null: nothing to write from. */
export async function getArticleText(
  get: Get,
  s: { kind: string; article_url: string; feed_snippet: string },
): Promise<ArticleText | null> {
  const url = s.kind === "earnings" ? await earningsUrl(get, s.article_url) : s.article_url;
  const text = url ? await html(get, url) : null;
  if (text && text.length >= MIN_ARTICLE_CHARS) return { basis: "article", text };
  return s.feed_snippet.length >= MIN_SNIPPET_CHARS ? { basis: "snippet", text: s.feed_snippet } : null;
}
