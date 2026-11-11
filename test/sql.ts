import { DatabaseSync } from "node:sqlite";

// ctx.storage look-alike over node:sqlite. Not proof of platform behaviour: migrations also run in test/workerd.
export function makeSql() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q: string, ...params: any[]) {
      // ponytail: a ";" inside a string literal is read as a multi-statement script
      const script = !params.length && q.trim().replace(/;$/, "").includes(";");
      if (script) db.exec(q);
      const rows = script ? [] : (db.prepare(q).all(...params) as any[]);
      return Object.assign(rows[Symbol.iterator](), { toArray: () => rows, one: () => rows[0] });
    },
  };
  const transactionSync = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { sql, transactionSync };
}
