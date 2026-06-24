import { describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/service";
import type { Env } from "../src/types";
import { MemoryRepository, sitemapXml } from "./helpers";

const NOW = new Date("2026-06-24T12:10:00.000Z");
const ARTICLE_URL = "https://n1info.rs/vesti/nova-vest/";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHANNEL_ID: "@test-channel",
} as Env;

describe("scheduled service", () => {
  it("seeds the first sitemap without publishing", async () => {
    const repository = new MemoryRepository();
    const fetchImpl = vi.fn(async () => xmlResponse(oneArticleSitemap())) as unknown as typeof fetch;

    await runScheduled(env, dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)?.status).toBe("seeded");
    expect(repository.state.get("initialized_at")).toBe(NOW.toISOString());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("publishes new articles once and records the message ID", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramMessageId: 123 });

    await runScheduled(env, dependencies(repository, fetchImpl));
    await runScheduled(env, dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({
      status: "sent",
      messageId: 123,
    });
    expect(telegramCalls(fetchImpl)).toHaveLength(1);
  });


  it("falls back to sendMessage when Telegram rejects the photo", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ rejectPhoto: true, telegramMessageId: 456 });

    await runScheduled(env, dependencies(repository, fetchImpl));

    const calls = telegramCalls(fetchImpl).map(([input]) => String(input));
    expect(calls).toEqual([
      "https://api.telegram.org/bottest-token/sendPhoto",
      "https://api.telegram.org/bottest-token/sendMessage",
    ]);
    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({ status: "sent", messageId: 456 });
  });

  it("uses sitemap data when the article page cannot be loaded", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ articleStatus: 503, telegramMessageId: 789 });

    await runScheduled(env, dependencies(repository, fetchImpl));

    const telegramCall = telegramCalls(fetchImpl)[0];
    const body = JSON.parse(String(telegramCall?.[1]?.body)) as { text: string };
    expect(body.text).toContain("Nova vest");
    expect(repository.articles.get(ARTICLE_URL)?.status).toBe("sent");
  });

  it("honors Telegram retry_after and fails permanently after five attempts", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ rateLimited: true });

    await runScheduled(env, dependencies(repository, fetchImpl));
    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({
      status: "retry",
      attempts: 1,
      nextAttemptAt: "2026-06-24T12:12:00.000Z",
    });

    const article = repository.articles.get(ARTICLE_URL);
    if (!article) throw new Error("Test article was not discovered");
    article.status = "retry";
    article.attempts = 4;
    article.nextAttemptAt = null;

    await runScheduled(env, dependencies(repository, fetchImpl));
    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({
      status: "failed",
      attempts: 5,
      nextAttemptAt: null,
    });
  });

  it("processes one backlog entry per run to avoid origin throttling", async () => {
    const repository = initializedRepository();
    const entries = Array.from({ length: 12 }, (_, index) => ({
      url: `https://n1info.rs/vesti/article-${index}/`,
      title: `Article ${index}`,
      publicationDate: new Date(NOW.getTime() + index * 1000).toISOString(),
    }));
    const fetchImpl = routeFetch({ sitemap: sitemapXml(entries), telegramMessageId: 100 });

    await runScheduled(env, dependencies(repository, fetchImpl));

    const sent = [...repository.articles.values()].filter((article) => article.status === "sent");
    const pending = [...repository.articles.values()].filter((article) => article.status === "pending");
    expect(sent).toHaveLength(1);
    expect(pending).toHaveLength(11);
    expect(sent[0]?.title).toBe("Article 0");
  });

  it("backs off without throwing when N1 returns 403", async () => {
    const repository = initializedRepository();
    const fetchImpl = vi.fn(async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;

    await runScheduled(env, dependencies(repository, fetchImpl));
    await runScheduled(env, dependencies(repository, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(repository.state.get("sitemap_retry_attempts")).toBe("1");
    expect(repository.state.get("sitemap_retry_at")).toBe("2026-06-24T12:15:00.000Z");
  });

  it("does not mutate state when the sitemap is malformed", async () => {
    const repository = initializedRepository();
    const fetchImpl = vi.fn(async () => xmlResponse("<invalid />")) as unknown as typeof fetch;

    await expect(runScheduled(env, dependencies(repository, fetchImpl))).rejects.toThrow(
      /urlset\/url is missing/,
    );
    expect(repository.articles).toHaveLength(0);
    expect(repository.state.get("last_run_at")).toBeUndefined();
  });

  it("retries an ambiguous network error instead of losing the article", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramNetworkError: true });

    await runScheduled(env, dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({ status: "retry", attempts: 1 });
  });

  it("retries a Telegram server error", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramServerError: true });

    await runScheduled(env, dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({ status: "retry", attempts: 1 });
  });
});

function dependencies(repository: MemoryRepository, fetchImpl: typeof fetch) {
  return {
    repository,
    fetchImpl,
    now: () => new Date(NOW),
    sleep: async () => undefined,
  };
}

function initializedRepository(): MemoryRepository {
  const repository = new MemoryRepository();
  repository.state.set("initialized_at", "2026-06-24T11:00:00.000Z");
  return repository;
}

function oneArticleSitemap(): string {
  return sitemapXml([
    {
      url: ARTICLE_URL,
      title: "Nova vest",
      publicationDate: "2026-06-24T12:09:00.000Z",
    },
  ]);
}

interface FetchOptions {
  sitemap?: string;
  articleStatus?: number;
  rejectPhoto?: boolean;
  rateLimited?: boolean;
  telegramNetworkError?: boolean;
  telegramServerError?: boolean;
  telegramMessageId?: number;
}

function routeFetch(options: FetchOptions): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("sitemap_news_1.xml")) {
      return xmlResponse(options.sitemap ?? oneArticleSitemap());
    }
    if (url.startsWith("https://n1info.rs/")) {
      if (options.articleStatus && options.articleStatus >= 400) {
        return new Response("unavailable", { status: options.articleStatus });
      }
      return new Response(
        `<meta property="og:title" content="Nova vest">
         <meta property="og:description" content="Kratak opis">
         <meta property="og:image" content="https://n1info.rs/image.jpg">`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    if (url.includes("api.telegram.org")) {
      if (options.telegramNetworkError) {
        throw new Error("network timeout");
      }
      if (options.telegramServerError) {
        return Response.json(
          { ok: false, error_code: 500, description: "Internal Server Error" },
          { status: 500 },
        );
      }
      if (options.rateLimited) {
        return Response.json(
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 120 } },
          { status: 429 },
        );
      }
      if (options.rejectPhoto && url.endsWith("/sendPhoto")) {
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: wrong file identifier" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: { message_id: options.telegramMessageId ?? 1 } });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
}

function telegramCalls(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.filter(([input]) => String(input).includes("api.telegram.org"));
}

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml" },
  });
}
