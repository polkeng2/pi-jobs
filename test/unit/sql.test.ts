import { expect, test } from "vitest";
import { makeSql } from "../sql.ts";

test("sql runs scripts, params, one(), iteration and rolls back", () => {
  const { sql, transactionSync } = makeSql();
  sql.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);");
  sql.exec("INSERT INTO t VALUES (?)", 2);
  expect(sql.exec("SELECT a FROM t ORDER BY a").toArray()).toEqual([{ a: 1 }, { a: 2 }]);
  expect(sql.exec("SELECT a FROM t WHERE a = ?", 2).one()).toEqual({ a: 2 });
  expect([...sql.exec("SELECT a FROM t")].length).toBe(2);
  expect(() => transactionSync(() => { sql.exec("INSERT INTO t VALUES (3)"); throw new Error("x"); })).toThrow("x");
  expect(sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 2 });
});
