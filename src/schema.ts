// Ordered migrations as SQL strings. The version lives in `meta` because PRAGMA user_version is refused.
// Append only: never edit a migration that has run.
export const MIGRATIONS: string[] = [
  `
CREATE TABLE digests (
  date         TEXT PRIMARY KEY,
  phase        TEXT NOT NULL DEFAULT 'fetch'
               CHECK (phase IN ('fetch','score','write','publish','done')),
  interests    TEXT NOT NULL,
  session_id   TEXT,
  write_chunk  INTEGER NOT NULL DEFAULT 0,
  write_failed INTEGER NOT NULL DEFAULT 0,
  chunk_reads  INTEGER NOT NULL DEFAULT 0,
  chunk_stop   TEXT CHECK (chunk_stop IN ('budget','neurons')),
  started_at   INTEGER NOT NULL,
  published_at INTEGER,
  status       TEXT CHECK (status IN ('complete','partial')),
  notice       TEXT,
  db_bytes     INTEGER
) WITHOUT ROWID;

CREATE TABLE feed_fetches (
  digest_date TEXT NOT NULL,
  feed_key    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  story_count INTEGER,
  error       TEXT,
  PRIMARY KEY (digest_date, feed_key)
) WITHOUT ROWID;

CREATE TABLE seen_urls (
  url_key       TEXT PRIMARY KEY,
  feed          TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE stories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_date    TEXT NOT NULL,
  section        TEXT NOT NULL CHECK (section IN ('tech','markets')),
  feed           TEXT NOT NULL,
  ticker         TEXT,
  kind           TEXT NOT NULL DEFAULT 'news' CHECK (kind IN ('news','earnings')),
  url            TEXT NOT NULL,
  article_url    TEXT NOT NULL,
  feed_heading   TEXT NOT NULL,
  feed_snippet   TEXT NOT NULL DEFAULT '',
  feed_published_at INTEGER,
  consensus      TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','below','shortlist','written',
                                   'score_failed','unreadable','write_failed')),
  score_attempts INTEGER NOT NULL DEFAULT 0,
  clef_answers   TEXT,
  signal_score   REAL,
  scorer_version TEXT,
  headline       TEXT,
  summary        TEXT,
  why_it_matters TEXT,
  subject        TEXT,
  write_basis    TEXT CHECK (write_basis IN ('article','snippet')),
  article_chars  INTEGER,
  published_at   INTEGER,
  display_order  INTEGER,
  vote           INTEGER CHECK (vote IN (1,-1)),
  voted_at       INTEGER
);
CREATE INDEX stories_by_day ON stories (digest_date, status);

CREATE VIRTUAL TABLE story_search USING fts5(
  headline, summary, why_it_matters, subject,
  content='stories', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER story_search_publish AFTER UPDATE OF published_at ON stories
WHEN old.published_at IS NULL AND new.published_at IS NOT NULL BEGIN
  INSERT INTO story_search (rowid, headline, summary, why_it_matters, subject)
  VALUES (new.id, new.headline, new.summary, new.why_it_matters, new.subject);
END;
CREATE TRIGGER story_search_delete AFTER DELETE ON stories
WHEN old.published_at IS NOT NULL BEGIN
  INSERT INTO story_search (story_search, rowid, headline, summary, why_it_matters, subject)
  VALUES ('delete', old.id, old.headline, old.summary, old.why_it_matters, old.subject);
END;

CREATE TABLE clicks (
  id       INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories (id),
  at       INTEGER NOT NULL
);

CREATE TABLE positions (
  ticker             TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  cik                TEXT,
  logo_url           TEXT,
  profile_checked_at INTEGER
) WITHOUT ROWID;

CREATE TABLE position_quotes (
  digest_date TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  close       REAL NOT NULL,
  change_pct  REAL NOT NULL,
  strong_move INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (digest_date, ticker)
) WITHOUT ROWID;

CREATE TABLE usage_log (
  digest_date   TEXT NOT NULL,
  phase         TEXT NOT NULL,
  model         TEXT NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  neurons       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (digest_date, phase, model)
) WITHOUT ROWID;
`,
];

type Sql = { exec(q: string, ...p: any[]): { toArray(): any[] } };

/** Runs pending migrations synchronously in one transaction. Safe to call on every construction. */
export function migrate(sql: Sql, transactionSync: <T>(fn: () => T) => T) {
  transactionSync(() => {
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    const row = sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    for (let v = Number(row?.value ?? 0); v < MIGRATIONS.length; v++) {
      sql.exec(MIGRATIONS[v]);
      sql.exec("INSERT OR REPLACE INTO meta VALUES ('schema_version', ?)", String(v + 1));
    }
  });
}
