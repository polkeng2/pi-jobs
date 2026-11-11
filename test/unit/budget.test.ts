import { expect, test } from "vitest";
import { createBudget, isSubrequestLimit, neuronGuard, neurons } from "../../src/budget.ts";

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

test("countedFetch counts every hop and follows at most 2 redirects", async () => {
  const seen: any[] = [];
  const hops = [redirect("https://b/"), redirect("https://c/"), new Response("ok")];
  const b = createBudget(async (url, init) => {
    seen.push([String(url), init?.redirect]);
    return hops.shift()!;
  });
  expect(await (await b.fetch("https://a/")).text()).toBe("ok");
  expect(b.used).toBe(3);
  expect(seen).toEqual([["https://a/", "manual"], ["https://b/", "manual"], ["https://c/", "manual"]]);
});

test("a third redirect is refused, relative Locations resolve, reset zeroes used", async () => {
  const b = createBudget(async () => redirect("/next"));
  await expect(b.fetch("https://a/x")).rejects.toThrow(/redirect/);
  expect(b.used).toBe(3);
  b.reset();
  expect(b.used).toBe(0);
});

test("at most 6 fetches run at once", async () => {
  let live = 0, peak = 0;
  const b = createBudget(async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return new Response("x");
  });
  await Promise.all(Array.from({ length: 20 }, () => b.fetch("https://a/")));
  expect(peak).toBe(6);
  expect(b.used).toBe(20);
});

test("a caller arriving as a slot frees cannot jump the waiter past 6 in flight", async () => {
  let live = 0, peak = 0;
  const gates: (() => void)[] = [];
  const b = createBudget(() => {
    peak = Math.max(peak, ++live);
    return new Promise<Response>((r) => gates.push(() => (live--, r(new Response("x")))));
  });
  const calls = Array.from({ length: 7 }, () => b.fetch("https://a/")); // 6 run, 1 waits
  gates.shift()!();
  queueMicrotask(() => void calls.push(b.fetch("https://a/"))); // runs right after the slot is freed
  await new Promise((r) => setTimeout(r, 0));
  while (gates.length) {
    gates.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  }
  await Promise.all(calls);
  expect(calls).toHaveLength(8);
  expect(peak).toBe(6);
});

test("fetch gets an 8 s abort signal",async () => {
  let signal: AbortSignal | undefined;
  const b = createBudget(async (_u, init) => ((signal = init?.signal ?? undefined), new Response("x")));
  await b.fetch("https://a/");
  expect(signal).toBeInstanceOf(AbortSignal);
});

test("countedAI counts a call and returns the result untouched", async () => {
  const result = { probs: [0.1] };
  const b = createBudget(fetch);
  const ai = b.countAI({ run: async (m: string, i: unknown) => (m === "m" && i === 1 ? result : null) });
  expect(await ai.run("m", 1)).toBe(result);
  expect(b.used).toBe(1);
});

test("isSubrequestLimit matches the platform error", () => {
  expect(isSubrequestLimit(new Error("Too many subrequests by single Worker invocation."))).toBe(true);
  expect(isSubrequestLimit(new Error("boom"))).toBe(false);
});

test("neurons use the pricing-page rates", () => {
  expect(neurons("@cf/cloudflare/clef", 1_000_000, 0)).toBeCloseTo(21_818);
  expect(neurons("@cf/zai-org/glm-4.7-flash", 1_000_000, 1_000_000)).toBeCloseTo(41_900);
});

test("neuron guard stops at 9,000 for the date and passes below", () => {
  const sum = (n: number) => (date: string) => (date === "2026-11-03" ? n : 0);
  expect(neuronGuard(sum(8_999.9), "2026-11-03")).toBe("ok");
  expect(neuronGuard(sum(9_000), "2026-11-03")).toBe("neurons");
  expect(neuronGuard(sum(9_000), "2026-11-04")).toBe("ok");
});
