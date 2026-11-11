import { expect, test } from "vitest";
import { checkWriteUp, parseWriteUp, writeUp } from "../../src/writer.ts";

const good = {
  headline: "Fabrikam compra Northwind por 900 M$",
  summary: "Fabrikam ha acordado la compra de Northwind por 900 M$ en efectivo, según un comunicado. La operación se cerrará en marzo.",
  why_it_matters: "Fabrikam suma los modelos de Northwind a su catálogo.",
  subject: "Fabrikam",
};
const sent = "<facts>section: tech</facts><article>Fabrikam agreed to buy Northwind for $900 million in cash. Closing in March.</article>";
const with_ = (o: object) => ({ ...good, ...o });

test("a faithful Spanish write-up passes", () => {
  expect(checkWriteUp(good, sent, "tech")).toBeNull();
});

test("advice and analyst ratings are rejected, the regex holding the no-advice rule", () => {
  for (const why of [
    "Los analistas ven un precio objetivo de 300 dólares.".replace("300", "900"),
    "Recomendamos comprar acciones de Fabrikam.",
    "Es una oportunidad de compra para el inversor.",
    "Strong buy según el banco.",
    "Las acciones están infravaloradas.",
  ]) {
    expect(checkWriteUp(with_({ why_it_matters: why }), sent, "tech"), why).toBe("no investment advice, price targets or analyst ratings");
  }
});

test("English output, links and references to the text are rejected", () => {
  expect(checkWriteUp(with_({ summary: "The company has agreed to the purchase of Northwind for 900 M$ and that is the news." }), sent, "tech")).toBe("write in Spanish");
  expect(checkWriteUp(with_({ summary: good.summary + " Más en https://x.test/a" }), sent, "tech")).toBe("no links or markup");
  expect(checkWriteUp(with_({ summary: good.summary + " Según el artículo, sí." }), sent, "tech")).toBe('do not refer to "el texto" or "el artículo"');
});

test("Tech needs a 1 to 3 word subject; Markets does not", () => {
  expect(checkWriteUp(with_({ subject: undefined }), sent, "tech")).toBe("subject must be 1 to 3 words");
  expect(checkWriteUp(with_({ subject: "uno dos tres cuatro" }), sent, "tech")).toBe("subject must be 1 to 3 words");
  expect(checkWriteUp(with_({ subject: undefined }), sent, "markets")).toBeNull();
});

test("numbers must be in the text, ignoring separators, outer zeros and small whole numbers", () => {
  expect(checkWriteUp(with_({ summary: good.summary + " Afecta a 950 M$." }), sent, "tech")).toBe("these numbers are not in the text: 950");
  expect(checkWriteUp(with_({ summary: good.summary + " Hay 3 socios." }), sent, "tech")).toBeNull();
  expect(checkWriteUp(good, "<article>buy for $900.0 million; closing in March; ha de ser</article>", "tech")).toBeNull();
});

test("numbers keep their magnitude and compare across separator conventions", () => {
  const w = (n: string) => with_({ summary: good.summary.replace("900 M$", `${n} M$`), headline: good.headline.replace("900 M$", `${n} M$`) });
  const src = (n: string) => `<article>buy for $${n} million</article>`;
  const bad = (n: string) => `these numbers are not in the text: ${n}, ${n}`;
  expect(checkWriteUp(w("100"), src("10"), "tech")).toBe(bad("100"));
  expect(checkWriteUp(w("1000"), src("100"), "tech")).toBe(bad("1000"));
  expect(checkWriteUp(w("1.200"), src("1,200"), "tech")).toBeNull();
  expect(checkWriteUp(w("1,200"), src("1.200"), "tech")).toBeNull();
  expect(checkWriteUp(w("1.234,5"), src("1,234.5"), "tech")).toBeNull();
  expect(checkWriteUp(w("1.200"), src("1,2"), "tech")).toBe(bad("1.200"));
  expect(checkWriteUp(w("1,5"), src("1.5"), "tech")).toBeNull();
  expect(checkWriteUp(w("900"), src("900.00"), "tech")).toBeNull();
});

const msg = (text: string, stopReason = "stop") =>
  ({ role: "assistant", stopReason, content: [{ type: "text", text }], usage: { input: 10, output: 5 } }) as any;

test("parseWriteUp strips a code fence, trims and validates the schema", () => {
  const fenced = "```json\n" + JSON.stringify({ ...good, headline: `  ${good.headline}  ` }) + "\n```";
  expect(parseWriteUp(msg(fenced))).toEqual({ ok: good });
  expect(parseWriteUp(msg("{not json"))).toMatchObject({ error: expect.any(String) });
  expect(parseWriteUp(msg(JSON.stringify(good), "length"))).toMatchObject({ error: expect.stringContaining("length") });
  expect(parseWriteUp(msg(JSON.stringify({ ...good, headline: "corto" })))).toMatchObject({ error: expect.any(String) });
});

const run = (replies: any[]) => {
  const calls: any[] = [];
  const ai = { complete: async (_m: any, ctx: any, opts: any) => (calls.push({ ctx, opts }), replies.shift()), } as any;
  return { calls, go: (isEarnings = false) => writeUp(ai, { model: {} as any, system: "S", user: "U", section: "tech", sent, isEarnings }) };
};

test("one more call on invalid output carries the rejection, then gives up", async () => {
  const bad = msg(JSON.stringify(with_({ why_it_matters: "Recomendamos comprar acciones." })));
  const r = run([bad, msg(JSON.stringify(good))]);
  const out = await r.go();
  expect(out).toMatchObject({ ok: good, usage: { input: 20, output: 10 } });
  expect(r.calls).toHaveLength(2);
  expect(r.calls[1].ctx.messages.at(-1).content).toMatch(/^Your answer was rejected: no investment advice/);
  expect(r.calls[1].ctx.messages).toHaveLength(3);
  expect(r.calls[0].opts).toMatchObject({ maxTokens: 1500, temperature: 0.2, samplingParams: { chat_template_kwargs: { enable_thinking: false } } });

  const r2 = run([bad, bad]);
  expect(await r2.go()).toMatchObject({ error: expect.any(String) });
  expect(r2.calls).toHaveLength(2);
});

test("earnings with an article turn reasoning on with 4,000 tokens", async () => {
  const r = run([msg(JSON.stringify(good))]);
  await r.go(true);
  expect(r.calls[0].opts).toMatchObject({ maxTokens: 4000, samplingParams: { chat_template_kwargs: { enable_thinking: true } } });
});
