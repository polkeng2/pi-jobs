import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseInterests } from "../../src/interests.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const tracked = git("ls-files").split("\n").filter(Boolean);

test("no private file is tracked", () => {
  const bad = tracked.filter((f) => f === "interests.md" || f === ".dev.vars" || f.startsWith("evals/private/"));
  expect(bad).toEqual([]);
});

test("evals/private is gitignored", () => {
  expect(() => git("check-ignore", "evals/private/x")).not.toThrow();
});

test("pi, agents and typebox versions are exact", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const pinned = Object.entries(deps).filter(([n]) => n.startsWith("@earendil-works/") || n === "agents" || n === "typebox");
  expect(pinned.length).toBeGreaterThan(0);
  for (const [, v] of pinned) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
});

test("local tickers and names do not leak into tracked test, eval or example files", () => {
  if (!existsSync("interests.md")) return;
  const { positions } = parseInterests(readFileSync("interests.md", "utf8"));
  const needles = positions.flatMap((p) => [p.ticker, p.name]).map((s) => s.toLowerCase());
  const files = tracked.filter((f) => /^(test|evals)\//.test(f) || f === "interests.example.md");
  for (const f of files) {
    const body = readFileSync(f, "utf8").toLowerCase();
    for (const n of needles) expect(body, `${f} contains ${n}`).not.toContain(n);
  }
});
