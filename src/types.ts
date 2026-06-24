export const ARTICLE_STATUSES = [
  "seeded",
  "pending",
  "sending",
  "sent",
  "retry",
  "failed",
] as const;

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  INGEST_SECRET: string;
  GITHUB_DISPATCH_TOKEN: string;
}

export interface NewsArticle {
  url: string;
  title: string;
  publicationDate: string;
  section: string;
  description?: string;
  imageUrl?: string;
}

export interface StoredArticle extends NewsArticle {
  status: ArticleStatus;
  attempts: number;
}

export interface ArticleEnrichment {
  url: string;
  description?: string;
  imageUrl?: string;
}

export interface HealthSnapshot {
  initializedAt: string | null;
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  pending: number;
  retry: number;
  failed: number;
}

export interface ArticleRepository {
  getState(key: string): Promise<string | null>;
  seed(entries: NewsArticle[], now: string): Promise<void>;
  discover(entries: NewsArticle[], now: string): Promise<void>;
  recoverStaleSending(staleBefore: string, now: string): Promise<void>;
  listReady(now: string, limit: number): Promise<StoredArticle[]>;
  claim(url: string, now: string): Promise<boolean>;
  updateMetadata(
    url: string,
    description: string | undefined,
    imageUrl: string | undefined,
    now: string,
  ): Promise<void>;
  markSent(url: string, messageId: number, now: string): Promise<void>;
  markFailure(
    url: string,
    attempts: number,
    status: "retry" | "failed",
    error: string,
    nextAttemptAt: string | null,
    now: string,
  ): Promise<void>;
  markRunSuccessful(now: string): Promise<void>;
  health(): Promise<HealthSnapshot>;
}
