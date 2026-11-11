// Eval worker: the only way to Clef and GLM from Node, since both are binding-only. Run with `npm run eval:worker` (real AI binding).
// Each request is its own invocation, so the subrequest limit does not apply. Never deploy this.
import { createAI } from "agents/models/pi-ai";
import { CLEF } from "../src/scorer.ts";
import { getArticleText } from "../src/article.ts";
import { GLM } from "../src/read-story.ts";
import { writeUp } from "../src/writer.ts";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST") return new Response("POST only", { status: 405 });
    const body: any = await req.json();
    if (pathname === "/clef") return Response.json(await env.AI.run(CLEF, { model: "clef", state: body.state, questions: body.questions } as any));
    if (pathname === "/write") {
      const ai = createAI({ binding: env.AI as never });
      return Response.json(await writeUp(ai as any, { ...body, model: ai(GLM) }));
    }
    if (pathname === "/article") return Response.json(await getArticleText((u) => fetch(u), body));
    return new Response("not found", { status: 404 });
  },
};
