import { parseFeed } from "./feed";
import { buildTelegramContent } from "./format";
import { D1ArticleRepository } from "./repository";
import { publishToTelegram, TelegramError } from "./telegram";
import type { ArticleRepository, Env, NewsArticle } from "./types";

const MAX_ARTICLES_PER_RUN = 1;
const MAX_ATTEMPTS = 5;
const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;

export interface ServiceDependencies {
  repository: ArticleRepository;
  fetchImpl: typeof fetch;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

export async function ingestFeed(
  env: Env,
  feed: string,
  overrides: Partial<ServiceDependencies> = {},
): Promise<void> {
  validateConfiguration(env);
  const dependencies: ServiceDependencies = {
    repository: overrides.repository ?? new D1ArticleRepository(env.DB),
    fetchImpl: overrides.fetchImpl ?? fetch,
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };

  const runAt = dependencies.now().toISOString();
  const entries = parseFeed(feed);
  const initializedAt = await dependencies.repository.getState("initialized_at");

  if (!initializedAt) {
    await dependencies.repository.seed(entries, runAt);
    log("info", "initial_seed_completed", { count: entries.length });
    return;
  }

  await dependencies.repository.discover(entries, runAt);
  const staleBefore = new Date(
    dependencies.now().getTime() - STALE_SENDING_AFTER_MS,
  ).toISOString();
  await dependencies.repository.recoverStaleSending(staleBefore, runAt);

  const ready = await dependencies.repository.listReady(runAt, MAX_ARTICLES_PER_RUN);
  for (let index = 0; index < ready.length; index += 1) {
    const article = ready[index];
    if (!article || !(await dependencies.repository.claim(article.url, dependencies.now().toISOString()))) {
      continue;
    }

    try {
      const messageId = await publishArticle(env, article, dependencies.fetchImpl);
      await dependencies.repository.markSent(
        article.url,
        messageId,
        dependencies.now().toISOString(),
      );
      log("info", "article_sent", { url: article.url, messageId });
    } catch (error) {
      await recordFailure(dependencies.repository, article, error, dependencies.now());
    }

    if (index < ready.length - 1) {
      await dependencies.sleep(1_050);
    }
  }

  const completedAt = dependencies.now().toISOString();
  await dependencies.repository.markRunSuccessful(completedAt);
  log("info", "feed_ingestion_completed", { discovered: entries.length, processed: ready.length });
}

async function publishArticle(
  env: Env,
  article: NewsArticle,
  fetchImpl: typeof fetch,
): Promise<number> {
  const content = buildTelegramContent(article.title, article.description, article.url);
  return publishToTelegram(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHANNEL_ID,
    content,
    article.imageUrl,
    fetchImpl,
  );
}

async function recordFailure(
  repository: ArticleRepository,
  article: NewsArticle & { attempts: number },
  error: unknown,
  now: Date,
): Promise<void> {
  const attempts = article.attempts + 1;
  const failed = attempts >= MAX_ATTEMPTS;
  const retryAfter = error instanceof TelegramError ? error.retryAfterSeconds : undefined;
  const delaySeconds = retryAfter ?? Math.min(60 * 2 ** (attempts - 1), 3_600);
  const nextAttemptAt = failed ? null : new Date(now.getTime() + delaySeconds * 1000).toISOString();
  const message = error instanceof Error ? error.message : String(error);

  await repository.markFailure(
    article.url,
    attempts,
    failed ? "failed" : "retry",
    message,
    nextAttemptAt,
    now.toISOString(),
  );
  log("error", "article_send_failed", {
    url: article.url,
    attempts,
    status: failed ? "failed" : "retry",
    error: message,
  });
}

function validateConfiguration(env: Env): void {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID must be configured");
  }
}

function log(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
): void {
  console[level](JSON.stringify({ level, event, ...details }));
}
