import { describe, expect, it, vi } from "vitest";
import { ingestFeed } from "../src/service";
import type { Env } from "../src/types";
import { feedXml, MemoryRepository } from "./helpers";

const NOW = new Date("2026-06-24T12:10:00.000Z");
const ARTICLE_URL = "https://n1info.rs/vesti/nova-vest/";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHANNEL_ID: "@test-channel",
} as Env;

describe("scheduled service", () => {
  it("seeds the first feed without publishing", async () => {
    const repository = new MemoryRepository();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)?.status).toBe("seeded");
    expect(repository.state.get("initialized_at")).toBe(NOW.toISOString());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("publishes new articles once and records the message ID", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramMessageId: 123 });

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));
    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({
      status: "sent",
      messageId: 123,
    });
    expect(telegramCalls(fetchImpl)).toHaveLength(1);
  });
  it("falls back to sendMessage when Telegram rejects the photo", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ rejectPhoto: true, telegramMessageId: 456 });

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));

    const calls = telegramCalls(fetchImpl).map(([input]) => String(input));
    expect(calls).toEqual([
      "https://api.telegram.org/bottest-token/sendPhoto",
      "https://api.telegram.org/bottest-token/sendMessage",
    ]);
    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({ status: "sent", messageId: 456 });
  });

  it("uses RSS metadata without fetching the article page", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramMessageId: 789 });

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));

    const telegramCall = telegramCalls(fetchImpl)[0];
    const body = JSON.parse(String(telegramCall?.[1]?.body)) as {
      caption?: string;
      text?: string;
    };
    expect(body.caption ?? body.text).toContain("Kratak opis");
    expect(repository.articles.get(ARTICLE_URL)?.status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors Telegram retry_after and fails permanently after five attempts", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ rateLimited: true });

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));
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

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));
    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({
      status: "failed",
      attempts: 5,
      nextAttemptAt: null,
    });
  });

  it("processes at most ten backlog entries from oldest to newest", async () => {
    const repository = initializedRepository();
    const entries = Array.from({ length: 12 }, (_, index) => ({
      url: `https://n1info.rs/vesti/article-${index}/`,
      title: `Article ${index}`,
      publicationDate: new Date(NOW.getTime() + index * 1000).toISOString(),
    }));
    const fetchImpl = routeFetch({ telegramMessageId: 100 });

    await ingestFeed(env, feedXml(entries), dependencies(repository, fetchImpl));

    const sent = [...repository.articles.values()].filter((article) => article.status === "sent");
    const pending = [...repository.articles.values()].filter((article) => article.status === "pending");
    expect(sent).toHaveLength(10);
    expect(pending).toHaveLength(2);
    expect(sent.map((article) => article.title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Article ${index}`),
    );
  });

  it("does not mutate state when the feed is malformed", async () => {
    const repository = initializedRepository();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      ingestFeed(env, "<invalid />", dependencies(repository, fetchImpl)),
    ).rejects.toThrow(/rss\/item is missing/);
    expect(repository.articles).toHaveLength(0);
    expect(repository.state.get("last_run_at")).toBeUndefined();
  });

  it("retries an ambiguous network error instead of losing the article", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramNetworkError: true });

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));

    expect(repository.articles.get(ARTICLE_URL)).toMatchObject({ status: "retry", attempts: 1 });
  });

  it("retries a Telegram server error", async () => {
    const repository = initializedRepository();
    const fetchImpl = routeFetch({ telegramServerError: true });

    await ingestFeed(env, oneArticleFeed(), dependencies(repository, fetchImpl));

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

function oneArticleFeed(): string {
  return feedXml([
    {
      url: ARTICLE_URL,
      title: "Nova vest",
      publicationDate: "2026-06-24T12:09:00.000Z",
      description: "Kratak opis",
      imageUrl: "https://n1info.rs/image.jpg",
    },
  ]);
}

interface FetchOptions {
  rejectPhoto?: boolean;
  rateLimited?: boolean;
  telegramNetworkError?: boolean;
  telegramServerError?: boolean;
  telegramMessageId?: number;
}

function routeFetch(options: FetchOptions): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://n1info.rs/")) {
      throw new Error(`Unexpected article-page request: ${url}`);
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
