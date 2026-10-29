// Acceptance tests for the spike. They act only through the deployed Worker's
// diagnostic endpoint (spec #1, "Testing Decisions") and assert on the JSON
// report, never on internals.
//
//   SPIKE_URL=https://job-scout-spike.<subdomain>.workers.dev npm test
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const base = process.env.SPIKE_URL;
if (!base) throw new Error("Set SPIKE_URL to the deployed Worker's URL");

const EXACT = /^\d+\.\d+\.\d+$/;

async function diag(check: string) {
  const res = await fetch(`${base}/diag?check=${check}`);
  return { status: res.status, report: (await res.json()) as any };
}

describe("diagnostic endpoint, check=turn", () => {
  it("runs one agent turn inside the Durable Object and returns the model's reply", async () => {
    const { status, report } = await diag("turn");
    expect(status).toBe(200);
    expect(report.check).toBe("turn");
    expect(report.verdict).toBe("pass");
    expect(report.evidence.ranIn).toBe("durable-object");
    expect(report.evidence.operation.status).toBe("done");
    expect(report.evidence.reply).toMatch(/\S/);
    // The prompt asks for this word, so a real reply contains it.
    expect(report.evidence.reply.toLowerCase()).toContain("pong");
  }, 120_000);

  it("reports exact pinned versions for every pi package and agents", async () => {
    const { report } = await diag("turn");
    const names = Object.keys(report.versions);
    expect(names).toEqual(
      expect.arrayContaining([
        "@earendil-works/pi-ai",
        "@earendil-works/pi-durable",
        "@earendil-works/chord",
        "agents",
      ]),
    );
    for (const name of names) expect(report.versions[name]).toMatch(EXACT);
  }, 120_000);

  it("reports the neurons the model call used", async () => {
    const { report } = await diag("turn");
    expect(report.neurons.total).toBeGreaterThan(0);
    expect(report.neurons.calls.length).toBeGreaterThan(0);
    for (const call of report.neurons.calls) {
      expect(call.model).toMatch(/^@cf\//);
      expect(call.inputTokens).toBeGreaterThan(0);
    }
  }, 120_000);

  it("answers an unknown check with a failing report, not a crash", async () => {
    const { status, report } = await diag("nope");
    expect(status).toBe(404);
    expect(report.verdict).toBe("fail");
    expect(report.evidence.knownChecks).toContain("turn");
  });
});

describe("diagnostic endpoint, check=clef", () => {
  it("scores a synthetic offer with one score and one noul question and records raw answers, usage and neurons", async () => {
    const { status, report } = await diag("clef");
    expect(status).toBe(200);
    expect(report.check).toBe("clef");
    expect(report.verdict).toBe("pass");
    // The report says whether pi-ai can call Clef, and why.
    expect(typeof report.evidence.piAi.canCallClef).toBe("boolean");
    expect(report.evidence.piAi.reason).toMatch(/\S/);
    // The working path returns an answer for both questions, raw.
    expect(report.evidence.workingPath).toMatch(/\S/);
    const { answers, usage } = report.evidence.raw;
    expect(answers).toHaveProperty("fit");
    expect(answers).toHaveProperty("remote");
    expect(usage).toBeTruthy();
    // Neurons for the Clef call are recorded.
    expect(report.neurons.calls[0].model).toBe("@cf/cloudflare/clef");
    expect(report.neurons.total).toBeGreaterThan(0);
    // Synthetic data only.
    expect(report.evidence.data).toBe("synthetic");
  }, 120_000);
});

describe("repo hygiene", () => {
  it("every @earendil-works package and agents is pinned exactly in package.json", () => {
    const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith("@earendil-works/") || name === "agents") expect(range).toMatch(EXACT);
    }
  });

  it("the deployed Worker holds no secrets (model calls use the AI binding)", () => {
    const out: string = execFileSync("npx", ["wrangler", "secret", "list", "--format", "json"], {
      cwd: here(".."),
      encoding: "utf8",
      shell: true,
    });
    expect(JSON.parse(out.slice(out.indexOf("[")))).toEqual([]);
  }, 60_000);
});
