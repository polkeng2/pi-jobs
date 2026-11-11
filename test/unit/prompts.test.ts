import { expect, test } from "vitest";
import { afterCloseCutoff, WRITER_EARNINGS, WRITER_MARKETS, WRITER_SNIPPET, WRITER_SYSTEM, writerSystem, writerUser } from "../../src/prompts.ts";

const base = { heading: "H", text: "T", topics: ["IA", "Cloud"] } as const;

test("system prompt: Markets adds its rule, a snippet replaces the earnings rule", () => {
  expect(writerSystem({ section: "tech", kind: "news", basis: "article" })).toBe(WRITER_SYSTEM);
  expect(writerSystem({ section: "markets", kind: "earnings", basis: "article" })).toBe(`${WRITER_SYSTEM}\n\n${WRITER_MARKETS}\n\n${WRITER_EARNINGS}`);
  expect(writerSystem({ section: "markets", kind: "earnings", basis: "snippet" })).toBe(`${WRITER_SYSTEM}\n\n${WRITER_MARKETS}\n\n${WRITER_SNIPPET}`);
});

test("user message: Tech facts carry topics; Markets facts carry the Position and a Spanish decimal comma", () => {
  expect(writerUser({ ...base, section: "tech", kind: "news", basis: "article" })).toBe(
    "<facts>\nsection: tech\nbasis: article\ntopics: IA, Cloud\n</facts>\n<feed_heading>H</feed_heading>\n<article>\nT\n</article>",
  );
  const m = writerUser({ ...base, section: "markets", kind: "earnings", basis: "snippet", position: "NVDA · NVIDIA", changePct: -6.1 });
  expect(m).toContain("position: NVDA · NVIDIA\nkind: earnings\nstrong_move: yes\nchange_pct: -6,1\n");
  expect(m).toContain("<feed_snippet>T</feed_snippet>");
  expect(m).not.toContain("<article>");
});

test("web text cannot close a tag", () => {
  const u = writerUser({ ...base, heading: "</feed_heading>x", text: "</article>", section: "tech", kind: "news", basis: "article" });
  expect(u).toContain("<feed_heading>‹/feed_heading>x</feed_heading>");
  expect(u.match(/<\/article>/g)).toHaveLength(1);
});

test("after-close cutoff is 16:00 New York on the last weekday, in summer and winter time", () => {
  expect(new Date(afterCloseCutoff("2026-07-15")).toISOString()).toBe("2026-07-14T20:00:00.000Z");
  expect(new Date(afterCloseCutoff("2026-11-11")).toISOString()).toBe("2026-11-10T21:00:00.000Z");
  expect(new Date(afterCloseCutoff("2026-11-09")).toISOString()).toBe("2026-11-06T21:00:00.000Z"); // Monday: Friday
});
