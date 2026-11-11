// The writer: a nested model call that turns one Article into a validated WriteUp. Runs in Node and workerd.
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { isSubrequestLimit } from "./budget.ts";

export const WriteUp = Type.Object({
  headline: Type.String({ minLength: 8, maxLength: 120 }),
  summary: Type.String({ minLength: 20, maxLength: 700 }),
  why_it_matters: Type.String({ maxLength: 180 }),
  subject: Type.Optional(Type.String({ maxLength: 30 })), // Tech only; ignored in Markets
});
export type WriteUp = Static<typeof WriteUp>;
const check = Compile(WriteUp);

// The format the model is held to: four required strings. Length limits stay in WriteUp.
export const WRITE_UP_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "write_up",
    schema: {
      type: "object",
      properties: { headline: { type: "string" }, summary: { type: "string" }, why_it_matters: { type: "string" }, subject: { type: "string" } },
      required: ["headline", "summary", "why_it_matters", "subject"],
    },
  },
};

const STOP_ES = /\b(el|la|los|las|de|del|que|y|en|un|una|con|por|para|ha|se)\b/gi;
const STOP_EN = /\b(the|of|and|to|in|that|with|has|for|is|was|its)\b/gi;
const ADVICE = /\b(recomiend\w* (la |el )?(compra|venta|comprar|vender|mantener)|recomendamos|deberías|conviene (comprar|vender|mantener)|(comprar|vender|mantener) (las )?acciones|(compra|vende) acciones( de \S+)? (ahora|ya)|oportunidad de (compra|inversión)|señal de (compra|venta)|fuerte compra|precio objetivo|objetivo de \d|sobreponderar|infraponderar|sobrevalorad\w+|infravalorad\w+|strong buy|price target)\b/i;
const nums = (s: string) => s.match(/\d[\d.,]*\d|\d/g) ?? [];
const norm = (n: string) => n.replace(/[.,]/g, "").replace(/^0+/, "").replace(/0+$/, "");

/** `sent` is the user message exactly as sent. Returns the reason to reject, or null. */
export function checkWriteUp(w: WriteUp, sent: string, section: string): string | null {
  const text = [w.headline, w.summary, w.why_it_matters, w.subject ?? ""].join(" ");
  if (section === "tech" && (!w.subject?.trim() || w.subject.trim().split(/\s+/).length > 3)) return "subject must be 1 to 3 words";
  if (/https?:\/\/|www\.|[<>]/.test(text)) return "no links or markup";
  if (/\bel (texto|artículo)\b|system prompt/i.test(text)) return 'do not refer to "el texto" or "el artículo"';
  if (ADVICE.test(text)) return "no investment advice, price targets or analyst ratings";
  if ((text.match(STOP_EN) ?? []).length >= (text.match(STOP_ES) ?? []).length) return "write in Spanish";
  const known = new Set(nums(sent).map(norm));
  const bad = nums(text).filter((n) => !(/^\d+$/.test(n) && +n <= 12) && !known.has(norm(n)));
  return bad.length ? `these numbers are not in the text: ${bad.join(", ")}` : null;
}

/** Stop reason, code fence, first `{` to last `}`, schema, trimmed. */
export function parseWriteUp(msg: AssistantMessage): { ok: WriteUp } | { error: string } {
  if (msg.stopReason !== "stop") return { error: `the answer ended with stop reason ${msg.stopReason}, not stop` };
  const text = msg.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").replace(/```(json)?/g, "");
  const [a, b] = [text.indexOf("{"), text.lastIndexOf("}")];
  if (a < 0 || b < a) return { error: "the answer has no JSON object" };
  let raw: any;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return { error: "the answer is not valid JSON" };
  }
  for (const k in raw) if (typeof raw[k] === "string") raw[k] = raw[k].trim();
  if (!check.Check(raw)) return { error: `schema: ${[...check.Errors(raw)].map((e: any) => `${e.instancePath || "/"} ${e.message}`).join("; ")}` };
  return { ok: raw };
}

export type Usage = { input: number; output: number; calls: number };
type Complete = { complete(model: Model<string>, ctx: any, opts?: any): Promise<AssistantMessage> };

/**
 * One call, then one more with the rejection if the answer is invalid. A failing call is not retried.
 * Earnings with an article think (4,000 tokens); everything else does not (1,500).
 */
export async function writeUp(
  ai: Complete,
  a: { model: Model<string>; system: string; user: string; section: string; sent: string; isEarnings: boolean },
): Promise<({ ok: WriteUp } | { error: string }) & { usage: Usage }> {
  const usage = { input: 0, output: 0, calls: 0 };
  const messages: any[] = [{ role: "user", content: a.user, timestamp: Date.now() }];
  const opts = {
    maxTokens: a.isEarnings ? 4000 : 1500,
    temperature: 0.2,
    samplingParams: { response_format: WRITE_UP_FORMAT, chat_template_kwargs: { enable_thinking: a.isEarnings } },
  };
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let msg: AssistantMessage;
    usage.calls++;
    try {
      msg = await ai.complete(a.model, { systemPrompt: a.system, messages }, opts);
    } catch (e) {
      if (isSubrequestLimit(e)) throw e;
      return { error: `model call failed: ${e instanceof Error ? e.message : e}`, usage };
    }
    usage.input += msg.usage?.input ?? 0;
    usage.output += msg.usage?.output ?? 0;
    const parsed = parseWriteUp(msg);
    error = "error" in parsed ? parsed.error : (checkWriteUp(parsed.ok, a.sent, a.section) ?? "");
    if (!error) return { ok: (parsed as { ok: WriteUp }).ok, usage };
    messages.push(msg, { role: "user", content: `Your answer was rejected: ${error}. Return the corrected JSON object only.`, timestamp: Date.now() });
  }
  return { error, usage };
}
