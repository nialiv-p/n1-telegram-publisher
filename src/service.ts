import { fetchArticleMetadata } from "./article";
import { buildTelegramContent } from "./format";
import { D1ArticleRepository } from "./repository";
import { parseSitemap, SITEMAP_URL } from "./sitemap";
import { publishToTelegram, TelegramError } from "./telegram";
import type { ArticleRepository, Env, SitemapArticle } from "./types";

const MAX_ARTICLES_PER_RUN = 10;
const MAX_ATTEMPTS = 5;
const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
const STATE_SITEMAP_ETAG = "sitemap_etag";

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

  const previousEtag = await dependencies.repository.getState(STATE_SITEMAP_ETAG);
  const sitemap = await fetchSitemap(dependencies.fetchImpl, previousEtag);
  const runAt = dependencies.now().toISOString();
  if (sitemap.notModified) {
    await dependencies.repository.markRunSuccessful(runAt);
    log("info", "sitemap_not_modified", {});
    return;
  }

  const entries = parseSitemap(sitemap.xml);
  const initializedAt = await dependencies.repository.getState("initialized_at");

  if (!initializedAt) {
    await dependencies.repository.seed(entries, runAt, sitemap.etag);
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
  await dependencies.repository.markRunSuccessful(completedAt, sitemap.etag);
  log("info", "scheduled_run_completed", { discovered: entries.length, processed: ready.length });
}

async function publishArticle(
  env: Env,
  article: SitemapArticle,
  fetchImpl: typeof fetch,
): Promise<number> {
  const metadata = await fetchArticleMetadata(article.url, fetchImpl);
  const title = metadata.title ?? article.title;
  const content = buildTelegramContent(title, metadata.description, article.url);
  return publishToTelegram(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHANNEL_ID,
    content,
    metadata.imageUrl,
    fetchImpl,
  );
}

interface SitemapResponse {
  notModified: boolean;
  xml: string;
  etag?: string;
}

async function fetchSitemap(
  fetchImpl: typeof fetch,
  previousEtag: string | null,
): Promise<SitemapResponse> {
  const headers: Record<string, string> = {
    Accept: "application/xml,text/xml",
    "User-Agent": "N1TelegramPublisher/1.0 (+https://workers.dev)",
  };
  if (previousEtag) {
    headers["If-None-Match"] = previousEtag;
  }
  const response = await fetchImpl(SITEMAP_URL, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304) {
    return { notModified: true, xml: "", etag: previousEtag ?? undefined };
  }
  if (!response.ok) {
    throw new Error(`Sitemap returned HTTP ${response.status}`);
  }
  return {
    notModified: false,
    xml: await response.text(),
    etag: response.headers.get("etag") ?? undefined,
  };
}

async function recordFailure(
  repository: ArticleRepository,
  article: SitemapArticle & { attempts: number },
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

function log(level: "info" | "error", event: string, details: Record<string, unknown>): void {
  console[level](JSON.stringify({ level, event, ...details }));
}
