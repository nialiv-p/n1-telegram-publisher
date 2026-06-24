import { D1ArticleRepository } from "./repository";
import { runScheduled } from "./service";
import type { Env } from "./types";

export default {
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runScheduled(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    try {
      const health = await new D1ArticleRepository(env.DB).health();
      return Response.json({ status: "ok", ...health });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown health check error";
      return Response.json({ status: "error", error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
