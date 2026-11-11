// npm run eval [-- --sweep | --accept | --record]. Replay costs 0 neurons; --record makes real Clef calls through the eval worker.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCORER } from "../src/scorer.ts";
import { latency, PRIVATE, record, replay, sweep, type Post } from "./lib.ts";

const BASELINE = join(import.meta.dirname, "baseline.json");
const args = process.argv.slice(2);

if (args.includes("--record")) {
  const base = process.env.EVAL_WORKER ?? "http://localhost:8799";
  const post: Post = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  };
  const r = await record({ dir: PRIVATE, scorer: SCORER, post, now: () => new Date() });
  console.log(`recorded ${r.recorded}, skipped ${r.skipped} without an interests snapshot${r.stopped ? `, stopped: ${r.stopped}` : ""}`);
  console.log("latency ms", latency(PRIVATE, SCORER));
} else if (args.includes("--sweep")) {
  const { code, out } = sweep(PRIVATE, SCORER);
  console.log(out);
  process.exit(code);
} else {
  const { code, out } = replay(PRIVATE, SCORER, JSON.parse(readFileSync(BASELINE, "utf8")));
  console.log(out);
  if (args.includes("--accept") && code === 0) {
    writeFileSync(BASELINE, JSON.stringify(SCORER, null, 2) + "\n");
    console.log("baseline.json updated");
  }
  process.exit(code);
}
