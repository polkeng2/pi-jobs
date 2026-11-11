import { route } from "./router.ts";

export { Signal } from "./signal.ts";

export default {
  fetch: (req, env, ctx) => route(req, env, ctx),
  async scheduled(controller, env) {
    const date = new Date(controller.scheduledTime).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
    await env.SIGNAL.getByName("signal").startDailyRun(date);
  },
} satisfies ExportedHandler<Env>;
