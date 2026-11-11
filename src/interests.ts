// Parses interests.md. Plain code, no model. Runs in Node and workerd: no cloudflare:* or agents imports.
export type Weight = "high" | "medium";
export type Interests = {
  topics: { name: string; weight: Weight }[];
  antiTopics: string[];
  positions: { ticker: string; name: string }[];
};

export function parseInterests(text: string): Interests {
  const out: Interests = { topics: [], antiTopics: [], positions: [] };
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const item = line.slice(2).trim();
    if (section === "topics") {
      const m = /^(high|medium):(.*)$/.exec(item);
      if (!m) continue;
      for (const name of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        out.topics.push({ name, weight: m[1] as Weight });
      }
    } else if (section === "anti-topics") {
      if (item) out.antiTopics.push(item);
    } else if (section === "positions") {
      const [ticker, name] = item.split("|").map((s) => s.trim());
      if (ticker && name) out.positions.push({ ticker, name });
    }
  }
  return out;
}
