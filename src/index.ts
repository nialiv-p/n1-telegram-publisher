import { D1ArticleRepository } from "./repository";
import { ingestFeed } from "./service";
import type { Env } from "./types";

const MAX_FEED_BYTES = 1_000_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const health = await new D1ArticleRepository(env.DB).health();
        return Response.json({ status: "ok", ...health });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown health check error";
        return Response.json({ status: "error", error: message }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      if (!env.INGEST_SECRET || request.headers.get("Authorization") !== `Bearer ${env.INGEST_SECRET}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
      if (declaredLength > MAX_FEED_BYTES) {
        return Response.json({ error: "Feed is too large" }, { status: 413 });
      }
      const feed = await request.text();
      if (new TextEncoder().encode(feed).length > MAX_FEED_BYTES) {
        return Response.json({ error: "Feed is too large" }, { status: 413 });
      }
      try {
        await ingestFeed(env, feed);
        return Response.json({ status: "ok" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown ingestion error";
        console.error(JSON.stringify({ level: "error", event: "feed_ingestion_failed", error: message }));
        return Response.json({ status: "error", error: message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
