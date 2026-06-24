import { D1ArticleRepository } from "./repository";
import { discoverFeed, publishEnrichedArticles } from "./service";
import type { ArticleEnrichment, Env } from "./types";

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

    if (request.method === "POST" && (url.pathname === "/discover" || url.pathname === "/publish")) {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
      if (declaredLength > MAX_FEED_BYTES) {
        return Response.json({ error: "Feed is too large" }, { status: 413 });
      }
      const body = await request.text();
      if (new TextEncoder().encode(body).length > MAX_FEED_BYTES) {
        return Response.json({ error: "Feed is too large" }, { status: 413 });
      }
      try {
        if (url.pathname === "/discover") {
          const articles = await discoverFeed(env, body);
          return Response.json({ status: "ok", articles });
        }
        const enrichments = parseEnrichments(body);
        const published = await publishEnrichedArticles(env, enrichments);
        return Response.json({ status: "ok", published });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown processing error";
        console.error(JSON.stringify({ level: "error", event: "request_processing_failed", error: message }));
        return Response.json({ status: "error", error: message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function isAuthorized(request: Request, env: Env): boolean {
  return Boolean(
    env.INGEST_SECRET &&
      request.headers.get("Authorization") === `Bearer ${env.INGEST_SECRET}`,
  );
}

function parseEnrichments(body: string): ArticleEnrichment[] {
  const value = JSON.parse(body) as unknown;
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error("Publish payload must be an array with at most 10 entries");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid enrichment entry");
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.url !== "string") throw new Error("Enrichment URL is required");
    if (candidate.description !== undefined && typeof candidate.description !== "string") {
      throw new Error("Enrichment description must be a string");
    }
    if (candidate.imageUrl !== undefined && typeof candidate.imageUrl !== "string") {
      throw new Error("Enrichment imageUrl must be a string");
    }
    return {
      url: candidate.url,
      description: candidate.description?.slice(0, 4_000),
      imageUrl: candidate.imageUrl,
    };
  });
}
