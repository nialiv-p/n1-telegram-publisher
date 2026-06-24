import type {
  ArticleRepository,
  HealthSnapshot,
  SitemapArticle,
  StoredArticle,
} from "../src/types";

interface MemoryArticle extends StoredArticle {
  nextAttemptAt: string | null;
  messageId?: number;
  error?: string;
}

export class MemoryRepository implements ArticleRepository {
  readonly articles = new Map<string, MemoryArticle>();
  readonly state = new Map<string, string>();

  async getState(key: string): Promise<string | null> {
    return this.state.get(key) ?? null;
  }

  async seed(entries: SitemapArticle[], now: string): Promise<void> {
    this.insert(entries, "seeded");
    this.state.set("initialized_at", now);
    this.state.set("last_run_at", now);
    this.state.set("last_successful_run_at", now);
  }

  async discover(entries: SitemapArticle[], now: string): Promise<void> {
    this.insert(entries, "pending");
    this.state.set("last_run_at", now);
  }

  async recoverStaleSending(): Promise<void> {}

  async listReady(now: string, limit: number): Promise<StoredArticle[]> {
    return [...this.articles.values()]
      .filter(
        (article) =>
          article.status === "pending" ||
          (article.status === "retry" &&
            (article.nextAttemptAt === null || article.nextAttemptAt <= now)),
      )
      .sort((left, right) => left.publicationDate.localeCompare(right.publicationDate))
      .slice(0, limit);
  }

  async claim(url: string): Promise<boolean> {
    const article = this.articles.get(url);
    if (!article || (article.status !== "pending" && article.status !== "retry")) {
      return false;
    }
    article.status = "sending";
    return true;
  }

  async markSent(url: string, messageId: number): Promise<void> {
    const article = this.requireArticle(url);
    article.status = "sent";
    article.messageId = messageId;
    article.nextAttemptAt = null;
  }

  async markFailure(
    url: string,
    attempts: number,
    status: "retry" | "failed",
    error: string,
    nextAttemptAt: string | null,
  ): Promise<void> {
    const article = this.requireArticle(url);
    article.status = status;
    article.attempts = attempts;
    article.error = error;
    article.nextAttemptAt = nextAttemptAt;
  }

  async markRunSuccessful(now: string): Promise<void> {
    this.state.set("last_run_at", now);
    this.state.set("last_successful_run_at", now);
    this.state.set("sitemap_retry_at", "");
    this.state.set("sitemap_retry_attempts", "0");
  }

  async markSitemapThrottled(retryAt: string, attempts: number): Promise<void> {
    this.state.set("sitemap_retry_at", retryAt);
    this.state.set("sitemap_retry_attempts", String(attempts));
  }

  async health(): Promise<HealthSnapshot> {
    const count = (status: MemoryArticle["status"]) =>
      [...this.articles.values()].filter((article) => article.status === status).length;
    return {
      initializedAt: this.state.get("initialized_at") ?? null,
      lastRunAt: this.state.get("last_run_at") ?? null,
      lastSuccessfulRunAt: this.state.get("last_successful_run_at") ?? null,
      sitemapRetryAt: this.state.get("sitemap_retry_at") || null,
      pending: count("pending"),
      retry: count("retry"),
      failed: count("failed"),
    };
  }

  private insert(entries: SitemapArticle[], status: "seeded" | "pending"): void {
    for (const entry of entries) {
      if (!this.articles.has(entry.url)) {
        this.articles.set(entry.url, {
          ...entry,
          status,
          attempts: 0,
          nextAttemptAt: null,
        });
      }
    }
  }

  private requireArticle(url: string): MemoryArticle {
    const article = this.articles.get(url);
    if (!article) {
      throw new Error(`Missing memory article: ${url}`);
    }
    return article;
  }
}

export function sitemapXml(
  entries: Array<{ url: string; title: string; publicationDate: string }>,
): string {
  return `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${entries
  .map(
    (entry) => `<url>
  <loc>${entry.url}</loc>
  <lastmod>${entry.publicationDate}</lastmod>
  <news:news>
    <news:publication_date>${entry.publicationDate}</news:publication_date>
    <news:title>${entry.title}</news:title>
  </news:news>
</url>`,
  )
  .join("\n")}
</urlset>`;
}
