// publish_digest: plain code, no calls. One transaction picks the Stories, stamps them and the Digest.
type Deps = { sql: SqlStorage; now: () => number; transactionSync: <T>(fn: () => T) => T };

const MB = 1024 * 1024;
const n = (sql: SqlStorage, q: string, ...p: unknown[]) => sql.exec<{ n: number }>(q, ...p).one().n;

export function publishDigest(d: Deps, date: string): { status: "complete" | "partial"; tech: number; markets: number } {
  const { sql, now } = d;
  return d.transactionSync(() => {
    const at = now();
    // Tech: top 20 by score. Markets: per Position earnings first, then score, at most 3; Positions in ticker order.
    const tech = sql.exec<{ id: number }>(
      `SELECT id FROM stories WHERE digest_date = ? AND section = 'tech' AND status = 'written' AND published_at IS NULL
       ORDER BY signal_score DESC, id LIMIT 20`, date,
    ).toArray();
    const markets = sql.exec<{ id: number }>(
      `SELECT id FROM (
         SELECT id, ticker, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY kind = 'earnings' DESC, signal_score DESC, id) AS rk
         FROM stories WHERE digest_date = ? AND section = 'markets' AND status = 'written' AND published_at IS NULL)
       WHERE rk <= 3 ORDER BY ticker, rk`, date,
    ).toArray();
    for (const list of [tech, markets])
      list.forEach(({ id }, i) =>
        sql.exec("UPDATE stories SET published_at = ?, display_order = ? WHERE id = ? AND published_at IS NULL", at, i + 1, id));

    const failedFeeds = n(sql, "SELECT COUNT(*) AS n FROM feed_fetches WHERE digest_date = ? AND status = 'failed'", date);
    const { scoreFailed, writeFailed } = sql.exec<{ scoreFailed: number; writeFailed: number }>(
      "SELECT COALESCE(SUM(status = 'score_failed'), 0) AS scoreFailed, COALESCE(SUM(status = 'write_failed'), 0) AS writeFailed FROM stories WHERE digest_date = ?", date).one();
    const { wf, stop } = sql.exec<{ wf: number; stop: string | null }>(
      "SELECT write_failed AS wf, chunk_stop AS stop FROM digests WHERE date = ?", date).one();
    const late = at >= Date.parse(`${date}T07:50:00Z`);
    const bytes = sql.databaseSize;

    const notice = [
      failedFeeds && `No se pudieron leer ${failedFeeds} fuentes.`,
      scoreFailed && `${scoreFailed} noticias no se pudieron puntuar.`,
      writeFailed && `${writeFailed} noticias no se pudieron redactar.`,
      wf >= 2 && "La redacción con el modelo falló y el resto se leyó sin él.",
      stop === "neurons" && "Se agotó el presupuesto diario de IA.",
      late && "Se alcanzó la hora límite: este Digest está incompleto.",
      bytes >= 800 * MB && `La base de datos ocupa ${Math.round(bytes / MB)} MB (límite 1 GB).`,
    ].filter(Boolean);
    const partial = failedFeeds + scoreFailed + writeFailed > 0 || wf >= 2 || stop === "neurons" || late;
    const status = partial ? "partial" : "complete";
    sql.exec(
      "UPDATE digests SET published_at = ?, status = ?, notice = ?, db_bytes = ? WHERE date = ? AND published_at IS NULL",
      at, status, notice.length ? notice.join(" ") : null, bytes, date,
    );
    return { status, tech: tech.length, markets: markets.length };
  });
}
