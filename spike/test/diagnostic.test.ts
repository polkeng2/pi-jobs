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

describe.each(["tool", "tool-interpreted"])("diagnostic endpoint, check=%s", (check) => {
  it("makes the agent call the test tool and shows the validated arguments it received", async () => {
    const { status, report } = await diag(check);
    expect(status).toBe(200);
    expect(report.check).toBe(check);
    expect(report.verdict).toBe("pass");
    expect(report.evidence.ranIn).toBe("durable-object");
    expect(report.evidence.toolCalls).toBeGreaterThanOrEqual(1);
    // The prompt asks for add(a=3, b=4); validation must hand the tool real integers.
    expect(report.evidence.receivedArgs[0]).toEqual({ a: 3, b: 4 });
    expect(report.evidence.reply).toContain("7");
  }, 120_000);

  it("proves validation ran: it coerces good arguments and rejects bad ones", async () => {
    const { report } = await diag(check);
    const v = report.evidence.validation;
    expect(v.coerced).toEqual({ a: 3, b: 4 });
    expect(v.badArgsRejected).toBe(true);
    expect(v.badArgsError).toMatch(/\S/);
    expect(["evaluated", "interpreted"]).toContain(v.path);
    expect(typeof v.canEvaluate).toBe("boolean");
  }, 120_000);
});

describe("diagnostic endpoint, which typebox path ran", () => {
  it("with acceleration disabled the interpreted path is used", async () => {
    const { report } = await diag("tool-interpreted");
    expect(report.evidence.validation.path).toBe("interpreted");
    expect(report.evidence.validation.useAcceleration).toBe(false);
  }, 120_000);
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

// Ticket #5: do AI binding calls count toward the free plan's 50 subrequests
// per invocation? The verdict is the platform's: its own limit error, not a counter.
async function subrequests(ai: number, fetches: number) {
  const res = await fetch(`${base}/diag?check=subrequests&ai=${ai}&fetches=${fetches}`);
  return { status: res.status, report: (await res.json()) as any };
}

describe("diagnostic endpoint, check=subrequests", () => {
  it("a run below 50 total calls succeeds with every call answered", async () => {
    const { status, report } = await subrequests(15, 15);
    expect(status).toBe(200);
    expect(report.evidence.attempted).toEqual({ ai: 15, fetches: 15, total: 30 });
    expect(report.evidence.failures).toEqual([]);
    expect(report.evidence.succeeded).toBe(30);
    expect(report.verdict).toBe("pass");
    expect(report.neurons.calls.length).toBe(15);
  }, 120_000);

  it("a run above 50 AI calls records which call the platform refused and its error", async () => {
    const { report } = await subrequests(55, 0);
    expect(report.evidence.attempted.total).toBe(55);
    // The report states the outcome whichever way it falls; the platform's error is the proof.
    expect(report.evidence.firstFailure === null || typeof report.evidence.firstFailure.error === "string").toBe(true);
    expect(typeof report.evidence.aiCallsCountTowardLimit).toBe("boolean");
  }, 120_000);

  it("a mixed run above 50 accounts for every call", async () => {
    const { report } = await subrequests(20, 40);
    expect(report.evidence.attempted.total).toBe(60);
    expect(report.evidence.succeeded + report.evidence.failures.length).toBe(60);
  }, 120_000);
});
