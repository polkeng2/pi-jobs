import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseInterests } from "../../src/interests.ts";

test("parses the committed example into topics, anti-topics and Positions", () => {
  const parsed = parseInterests(readFileSync("interests.example.md", "utf8"));
  expect(parsed).toEqual({
    topics: [
      { name: "AI agents", weight: "high" },
      { name: "Cloudflare Workers", weight: "high" },
      { name: "open-source models", weight: "medium" },
    ],
    antiTopics: ["crypto", "giveaway"],
    positions: [
      { ticker: "ACME", name: "Acme Corp" },
      { ticker: "ZZZT", name: "Zzzt Holdings" },
    ],
  });
});

test("keeps Position file order, tolerates CRLF, blanks and unknown sections", () => {
  const text = "## Positions\r\n- ZZZT | Zzzt Holdings\r\n\r\n- ACME|Acme Corp\r\n## Notes\r\n- ignored\r\n";
  expect(parseInterests(text)).toEqual({
    topics: [],
    antiTopics: [],
    positions: [
      { ticker: "ZZZT", name: "Zzzt Holdings" },
      { ticker: "ACME", name: "Acme Corp" },
    ],
  });
});

test("skips malformed lines instead of throwing", () => {
  const text = "## Topics\n- urgent: nope\n- high:\nplain text\n## Positions\n- NOBAR\n";
  expect(parseInterests(text)).toEqual({ topics: [], antiTopics: [], positions: [] });
});
