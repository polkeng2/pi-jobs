// Search, vote and pruning SQL. Takes ctx.storage.sql (or the test look-alike); no state of its own.
type Sql = { exec(q: string, ...p: any[]): { toArray(): any[] } };

/** FTS5 query from user text: whitespace tokens, quotes dropped, each `"tok"*`, max 8. Null when empty. Never raw text. */
export function searchQuery(text: string): string | null {
  const toks = text.replaceAll('"', "").split(/\s+/).filter(Boolean).slice(0, 8);
  return toks.length ? toks.map((t) => `"${t}"*`).join(" ") : null;
}

/** Published Stories only, newest first. */
export function search(sql: Sql, text: string) {
  const q = searchQuery(text);
  if (!q) return [];
  return sql.exec(
    `SELECT s.id, s.digest_date, s.headline, s.summary, s.subject, s.url
     FROM story_search f JOIN stories s ON s.id = f.rowid
     WHERE story_search MATCH ?
     ORDER BY s.digest_date DESC, s.id DESC LIMIT 50`,
    q,
  ).toArray();
}

/** Toggles the vote of a published Story; returns the state after (1, -1, null). Unknown or unpublished gives null. */
export function vote(sql: Sql, id: number, v: 1 | -1, now: number): 1 | -1 | null {
  const row = sql.exec(
    `UPDATE stories SET vote = CASE WHEN vote = ?1 THEN NULL ELSE ?1 END, voted_at = ?2
     WHERE id = ?3 AND published_at IS NOT NULL RETURNING vote`,
    v, now, id,
  ).toArray()[0];
  return row?.vote ?? null;
}

/** cut: Madrid date 90 days back (YYYY-MM-DD); cutMs: the same instant in ms. Published Stories and Anthropic's seen_urls are kept. */
export function prune(sql: Sql, cut: string, cutMs: number) {
  sql.exec("DELETE FROM stories WHERE digest_date < ? AND published_at IS NULL", cut);
  sql.exec("DELETE FROM seen_urls WHERE first_seen_at < ? AND feed <> 'anthropic'", cutMs);
  sql.exec("DELETE FROM position_quotes WHERE digest_date < ?", cut);
  sql.exec("DELETE FROM feed_fetches WHERE digest_date < ?", cut);
  sql.exec("DELETE FROM digests WHERE date < ?", cut);
}
