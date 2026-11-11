// Escaping html`` template and URL check. Every interpolated value is escaped unless it came from raw().
export class Raw {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
}
export const raw = (s: string) => new Raw(s);

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ENT[c]!);

const one = (v: unknown): string =>
  v instanceof Raw ? v.s : Array.isArray(v) ? v.map(one).join("") : v == null || v === false ? "" : esc(v);

/** Returns Raw, so templates nest. Arrays are joined; null, undefined and false render nothing. */
export const html = (s: TemplateStringsArray, ...v: unknown[]) =>
  raw(s.reduce((out, part, i) => out + part + (i < v.length ? one(v[i]) : ""), ""));

/** http(s) URL with no credentials, or null. */
export function safeHttpUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}
