import { FEED_URL, parseFeed } from "./feed";
import { buildTelegramContent } from "./format";
import { D1ArticleRepository } from "./repository";
import { publishToTelegram, TelegramError } from "./telegram";
import type { ArticleRepository, Env, NewsArticle } from "./types";

const MAX_ARTICLES_PER_RUN = 1;
const MAX_ATTEMPTS = 5;
const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
const STATE_FEED_RETRY_AT = "sitemap_retry_at";
const STATE_FEED_RETRY_ATTEMPTS = "sitemap_retry_attempts";
const THROTTLE_BASE_DELAY_MS = 5 * 60 * 1000;
const THROTTLE_MAX_DELAY_MS = 30 * 60 * 1000;

export interface ServiceDependencies {
  repository: ArticleRepository;
  fetchImpl: typeof fetch;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

export async function runScheduled(
  env: Env,
  overrides: Partial<ServiceDependencies> = {},
): Promise<void> {
  validateConfiguration(env);
  const dependencies: ServiceDependencies = {
    repository: overrides.repository ?? new D1ArticleRepository(env.DB),
    fetchImpl: overrides.fetchImpl ?? fetch,
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };

  const runDate = dependencies.now();
  const runAt = runDate.toISOString();
  const retryAt = await dependencies.repository.getState(STATE_FEED_RETRY_AT);
  if (retryAt && Date.parse(retryAt) > runDate.getTime()) {
    log("info", "feed_cooldown_active", { retryAt });
    return;
  }

  let feed: string;
  try {
    feed = await fetchNewsFeed(dependencies.fetchImpl);
  } catch (error) {
    if (error instanceof FeedHttpError && (error.status === 403 || error.status === 429)) {
      await scheduleFeedRetry(dependencies.repository, error, runDate);
      return;
    }
    throw error;
  }
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
  log("info", "scheduled_run_completed", { discovered: entries.length, processed: ready.length });
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

async function fetchNewsFeed(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(FEED_URL, {
    headers: {
      Accept: "application/rss+xml,application/xml,text/xml",
      "User-Agent": "N1TelegramPublisher/1.0 (+https://workers.dev)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new FeedHttpError(response.status, parseRetryAfter(response.headers.get("retry-after")));
  }
  return response.text();
}

class FeedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMilliseconds?: number,
  ) {
    super(`N1 feed returned HTTP ${status}`);
    this.name = "FeedHttpError";
  }
}

async function scheduleFeedRetry(
  repository: ArticleRepository,
  error: FeedHttpError,
  now: Date,
): Promise<void> {
  const previousAttempts = Number.parseInt(
    (await repository.getState(STATE_FEED_RETRY_ATTEMPTS)) ?? "0",
    10,
  );
  const attempts = Number.isFinite(previousAttempts) ? previousAttempts + 1 : 1;
  const exponentialDelay = Math.min(
    THROTTLE_BASE_DELAY_MS * 2 ** (attempts - 1),
    THROTTLE_MAX_DELAY_MS,
  );
  const delay = error.retryAfterMilliseconds ?? exponentialDelay;
  const retryAt = new Date(now.getTime() + delay).toISOString();
  await repository.markFeedThrottled(retryAt, attempts);
  log("warn", "feed_throttled", { status: error.status, attempts, retryAt });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
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
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown>,
): void {
  console[level](JSON.stringify({ level, event, ...details }));
}
