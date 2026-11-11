export { Signal } from "./signal.ts";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
  async scheduled(controller, env) {
    const date = new Date(controller.scheduledTime).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
    await env.SIGNAL.getByName("signal").startDailyRun(date);
  },
} satisfies ExportedHandler<Env>;
