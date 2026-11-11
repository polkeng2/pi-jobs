// Server-rendered pages. Pure: data in, HTML string out. Never renders feed_heading, feed_snippet, clef_answers or signal_score.
import { html, raw, safeHttpUrl, type Raw } from "./html.ts";
import type { DigestView, PositionCard, StoryView } from "./view.ts";

const es = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", ...o });
const day = (d: string, o: Intl.DateTimeFormatOptions) => es(o).format(new Date(`${d}T00:00:00Z`));
const num = (n: number, o: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat("es-ES", o).format(n);

export const FOOTER = "Signal resume noticias. No es una recomendación de inversión.";
export type SearchRow = { id: number; digest_date: string; headline: string; summary: string; subject: string | null; url: string };

const CSS = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.45}
body{margin:0;overflow-wrap:anywhere}
main,header,footer,nav{max-width:44rem;margin:0 auto;padding:.5rem 1rem}
header{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
header a{font-weight:700;font-size:1.3rem;text-decoration:none;color:inherit}
article{border-top:1px solid GrayText;padding:.6rem 0}
article.earnings{border-left:.3rem solid CanvasText;padding-left:.6rem}
.tag{font-size:.8rem;border:1px solid GrayText;border-radius:.3rem;padding:0 .3rem}
.muted{color:GrayText;font-size:.9rem}
.notice{border:1px solid GrayText;padding:.5rem}
button{min-width:44px;min-height:44px;font-size:1.2rem}
.card{border:1px solid GrayText;border-radius:.5rem;padding:.5rem 1rem;margin:1rem 0}
.badge{position:relative;display:inline-block;min-width:2.2rem;text-align:center;font-weight:700;border:1px solid GrayText;border-radius:.3rem;margin-right:.4rem}
.badge img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:Canvas}
@media (min-width:60rem){
  main,header,footer,nav{max-width:72rem}
  .digest{display:grid;grid-template-columns:1fr 1fr;gap:2rem;align-items:start}
}`;

const SCRIPT = `
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-vote]");
  if (!b) return;
  const box = b.closest("article");
  const status = box.querySelector("[role=status]");
  const btns = box.querySelectorAll("button[data-vote]");
  btns.forEach((x) => (x.disabled = true));
  status.textContent = "";
  try {
    const r = await fetch("/stories/" + box.dataset.id + "/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ vote: Number(b.dataset.vote) }),
    });
    if (r.status === 401) status.textContent = "Sesión caducada. Recarga la página.";
    else if (!r.ok) status.textContent = "No se pudo guardar. Inténtalo de nuevo.";
    else {
      const { vote } = await r.json();
      btns.forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.vote) === vote)));
    }
  } catch {
    status.textContent = "No se pudo guardar. Inténtalo de nuevo.";
  }
  btns.forEach((x) => (x.disabled = false));
});`;

export function shell(title: string, body: Raw, nonce: string, q = ""): string {
  return String(html`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style nonce="${nonce}">${raw(CSS)}</style></head>
<body><header><a href="/">Signal</a>
<form method="get" action="/search"><input type="search" name="q" value="${q}" placeholder="Buscar..." aria-label="Buscar"> <button type="submit">Buscar</button></form></header>
${body}
<footer class="muted">${FOOTER}</footer>
<script nonce="${nonce}">${raw(SCRIPT)}</script></body></html>`.s);
}

const consensus = (c: StoryView["consensus"]) => {
  const parts = [
    c?.epsEstimate != null && `BPA ${num(c.epsEstimate, { minimumFractionDigits: 2 })}`,
    c?.revenueEstimate != null && `ingresos ${num(c.revenueEstimate)} M`,
  ].filter(Boolean);
  return parts.length ? `Consenso: ${parts.join(" · ")}` : null;
};

function storyHtml(s: StoryView, tech: boolean): Raw {
  const u = safeHttpUrl(s.url);
  const pressed = (v: number) => String(s.vote === v);
  return html`<article data-id="${s.id}"${raw(s.kind === "earnings" ? ' class="earnings"' : "")}>
${s.kind === "earnings" && html`<span class="tag">Resultados</span> `}${tech && s.subject && html`<span class="tag">${s.subject}</span> `}
<h3>${u ? html`<a href="/go/${s.id}">${s.headline}</a> <span class="muted">(${u.hostname})</span>` : s.headline}</h3>
<p>${s.summary}</p>
${s.whyItMatters && html`<p><strong>Por qué importa:</strong> ${s.whyItMatters}</p>`}
${consensus(s.consensus) && html`<p class="muted">${consensus(s.consensus)}</p>`}
${s.writeBasis === "snippet" && html`<p class="muted">Sin leer el artículo</p>`}
<button type="button" data-vote="1" aria-label="Voto positivo" aria-pressed="${pressed(1)}">👍</button>
<button type="button" data-vote="-1" aria-label="Voto negativo" aria-pressed="${pressed(-1)}">👎</button>
<span role="status" class="muted"></span></article>`;
}

function cardHtml(c: PositionCard): Raw {
  const logo = c.logoUrl && safeHttpUrl(c.logoUrl)?.protocol === "https:" ? c.logoUrl : null;
  const q = c.quote;
  return html`<section class="card"><h3><span class="badge">${c.ticker}${logo && html`<img src="${logo}" alt="" referrerpolicy="no-referrer" loading="lazy">`}</span>${c.ticker} · ${c.name}</h3>
<p class="muted">${q
    ? html`Cierre: ${num(q.close, { minimumFractionDigits: 2 })} $ · ${num(q.changePct, { signDisplay: "always", minimumFractionDigits: 1 })} %${q.strongMove && html` · <strong>Movimiento fuerte</strong>`}`
    : "sin cotización"}</p>
${c.stories.length
    ? c.stories.map((s) => storyHtml(s, false))
    : html`<p class="muted">${c.newsStatus === "done" ? "sin novedades" : "noticias no disponibles"}</p>`}</section>`;
}

/** latestDate: today's Madrid date; the not-yet line shows on `/` when the Digest is not today's. */
export function digestPage(v: DigestView, nonce: string, o: { isLatest: boolean; today: string }): string {
  const arrow = (d: string | null, mark: string) =>
    d && html`<a href="/d/${d}">${mark === "←" ? "← " : ""}${day(d, { day: "numeric", month: "short" })}${mark === "→" ? " →" : ""}</a> `;
  return shell(
    `Signal · ${day(v.date, { dateStyle: "full" })}`,
    html`<nav>${arrow(v.prev, "←")}${arrow(v.next, "→")}</nav>
<main><h1>${day(v.date, { dateStyle: "full" })}</h1>
<nav><a href="#tech">Tech</a> · <a href="#markets">Markets</a></nav>
${v.status === "partial" && v.notice && html`<p class="notice">${v.notice}</p>`}
${o.isLatest && v.date !== o.today && html`<p class="notice">El Digest de hoy aún no está publicado. Este es el de ${day(v.date, { dateStyle: "long" })}.</p>`}
<div class="digest">
<section id="tech"><h2>Tech</h2>
${v.tech.length
    ? [v.tech.slice(0, 10).map((s) => storyHtml(s, true)), v.tech.length > 10 && html`<details><summary>Ver más</summary>${v.tech.slice(10).map((s) => storyHtml(s, true))}</details>`]
    : html`<p>Nada relevante hoy.</p>`}</section>
<section id="markets"><h2>Markets</h2>${v.cards.map(cardHtml)}</section></div></main>`,
    nonce,
  );
}

export const emptyPage = (nonce: string) =>
  shell("Signal", html`<main><p>Todavía no hay ningún Digest. Se publica cada mañana antes de las 10:00.</p></main>`, nonce);

export const messagePage = (text: string, nonce: string, link = false) =>
  shell("Signal", html`<main><p>${text}</p>${link && html`<p><a href="/">Ir al último Digest</a></p>`}</main>`, nonce);

export function searchPage(q: string, rows: SearchRow[] | null, nonce: string, today: string): string {
  const cut = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 864e5).toISOString().slice(0, 10);
  const list = rows && rows.length
    ? html`<ul>${rows.map((r) => {
        const u = safeHttpUrl(r.url);
        const d = day(r.digest_date, { day: "numeric", month: "numeric", year: "2-digit" });
        return html`<li>${r.digest_date >= cut ? html`<a href="/d/${r.digest_date}">${d}</a>` : d} ${r.subject && html`<span class="tag">${r.subject}</span> `}
<a href="/go/${r.id}">${r.headline}</a>${u && html` <span class="muted">(${u.hostname})</span>`}
<details><summary>Resumen</summary><p>${r.summary}</p></details></li>`;
      })}</ul>${rows.length >= 50 && html`<p class="muted">Mostrando los 50 más recientes.</p>`}`
    : rows && html`<p>Sin resultados para «${q}».</p>`;
  return shell("Signal · Búsqueda", html`<main><h1>Búsqueda</h1>${list}</main>`, nonce, q);
}
