// String-only parsers (no DOM, no dependencies). Each returns Items; none throws on a missing field.
/** `articleUrl` (default `url`) and `kind` (default news) are set by EDGAR: the filing folder is what read_story resolves `index.json` against. */
export type Item = {
  url: string; heading: string; snippet: string; publishedAt: number | null;
  articleUrl?: string; kind?: "news" | "earnings";
};

/** 8-K Items, constant: Clef and the orchestrator see only this text. 9.01 (exhibits only) is left out on purpose. */
const EDGAR_ITEMS: Record<string, string> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting or Failure to Satisfy a Continued Listing Rule",
  "4.01": "Changes in Registrant's Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financial Statements",
  "5.01": "Changes in Control of Registrant",
  "5.02": "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
};

/** `data.sec.gov/submissions` JSON: 8-Ks with a known Item, one Item per filing (2.02 wins). */
export function parseEdgar(json: string): Item[] {
  const r = JSON.parse(json);
  const f = r.filings?.recent;
  if (!f) return [];
  const items: Item[] = [];
  (f.form as string[]).forEach((form, i) => {
    const nums = String(f.items[i] ?? "").split(",").map((s) => s.trim()).filter((n) => n in EDGAR_ITEMS);
    if (form !== "8-K" || !nums.length) return;
    const n = nums.includes("2.02") ? "2.02" : nums[0]!;
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(r.cik)}/${String(f.accessionNumber[i]).replaceAll("-", "")}/`;
    items.push({
      url, articleUrl: url, kind: n === "2.02" ? "earnings" : "news", heading: `8-K Item ${n}: ${EDGAR_ITEMS[n]}`,
      snippet: "", publishedAt: date(f.acceptanceDateTime[i]),
    });
  });
  return items;
}

/** Finnhub `/company-news`. */
export function parseFinnhubNews(json: string): Item[] {
  const rows: any[] = JSON.parse(json);
  return rows.filter((r) => r.headline && r.url).map((r) => ({
    url: r.url, heading: String(r.headline), snippet: String(r.summary ?? "").slice(0, SNIPPET_CHARS),
    publishedAt: r.datetime ? r.datetime * 1000 : null,
  }));
}

const SNIPPET_CHARS = 600;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ENTITIES[e]!); // amp last-in-pattern, single pass: no double decode

/** CDATA unwrapped, entities decoded, tags dropped, whitespace collapsed. */
const text = (s: string) =>
  decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const date = (s: string | undefined | null) => {
  const t = s ? Date.parse(s.trim()) : NaN;
  return Number.isNaN(t) ? null : t;
};

const tag = (block: string, names: string[]) => {
  for (const n of names) {
    const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`).exec(block);
    if (m) return m[1]!;
  }
  return undefined;
};

function link(block: string) {
  for (const m of block.matchAll(/<link\b([^>]*)>(?:([^<]*)<\/link>)?/g)) {
    const href = /href="([^"]*)"/.exec(m[1]!)?.[1];
    const rel = /rel="([^"]*)"/.exec(m[1]!)?.[1];
    if (href && (!rel || rel === "alternate")) return decode(href);
    if (m[2]?.trim()) return text(m[2]);
  }
  return "";
}

/** RSS 2.0 and Atom. */
export function parseFeed(xml: string): Item[] {
  const items: Item[] = [];
  for (const [block] of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const url = link(block);
    const heading = text(tag(block, ["title"]) ?? "");
    if (!url || !heading) continue;
    items.push({
      url, heading,
      snippet: text(tag(block, ["description", "summary", "content:encoded", "content"]) ?? "").slice(0, SNIPPET_CHARS),
      publishedAt: date(text(tag(block, ["pubDate", "published", "updated", "dc:date"]) ?? "")),
    });
  }
  return items;
}

/** Algolia search response. Ask HN style posts have no url: they point at the HN item page. */
export function parseHn(json: string): Item[] {
  const hits: any[] = JSON.parse(json).hits ?? [];
  return hits.filter((h) => h.title).map((h) => ({
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    heading: String(h.title), snippet: "", publishedAt: h.created_at_i ? h.created_at_i * 1000 : null,
  }));
}

/** `hottest.json`. */
export function parseLobsters(json: string): Item[] {
  const rows: any[] = JSON.parse(json);
  return rows.filter((r) => r.title).map((r) => ({
    url: r.url || r.comments_url, heading: String(r.title), snippet: "", publishedAt: date(r.created_at),
  }));
}

/** Sitemap URLs under /news/ and /research/. The sitemap has no titles: the heading is the slug. */
export function parseAnthropic(xml: string): Item[] {
  const items: Item[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = decode(m[1]!);
    const slug = /^https:\/\/www\.anthropic\.com\/(?:news|research)\/([^/?#]+)/.exec(url)?.[1];
    if (slug) items.push({ url, heading: slug.replace(/-/g, " "), snippet: "", publishedAt: null });
  }
  return items;
}

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|ref_src$)/;

/** The key `seen_urls` dedups on: no tracking params, fragment, `www.` or trailing slash. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = "";
  u.hostname = u.hostname.replace(/^www\./, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href.replace(/\/$/, "");
}
