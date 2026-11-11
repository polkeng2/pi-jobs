import { route } from "./router.ts";

export { Signal } from "./signal.ts";

export default {
  fetch: (req, env, ctx) => route(req, env, ctx),
} satisfies ExportedHandler<Env>;
