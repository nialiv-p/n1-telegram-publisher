import type {
  ArticleRepository,
  HealthSnapshot,
  NewsArticle,
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

  async seed(entries: NewsArticle[], now: string): Promise<void> {
    this.insert(entries, "seeded");
    this.state.set("initialized_at", now);
    this.state.set("last_run_at", now);
    this.state.set("last_successful_run_at", now);
  }

  async discover(entries: NewsArticle[], now: string): Promise<void> {
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

  async updateMetadata(
    url: string,
    description: string | undefined,
    imageUrl: string | undefined,
  ): Promise<void> {
    const article = this.requireArticle(url);
    article.description = description ?? article.description;
    article.imageUrl = imageUrl ?? article.imageUrl;
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
  }

  async health(): Promise<HealthSnapshot> {
    const count = (status: MemoryArticle["status"]) =>
      [...this.articles.values()].filter((article) => article.status === status).length;
    return {
      initializedAt: this.state.get("initialized_at") ?? null,
      lastRunAt: this.state.get("last_run_at") ?? null,
      lastSuccessfulRunAt: this.state.get("last_successful_run_at") ?? null,
      pending: count("pending"),
      retry: count("retry"),
      failed: count("failed"),
    };
  }

  private insert(entries: NewsArticle[], status: "seeded" | "pending"): void {
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

export function feedXml(
  entries: Array<{
    url: string;
    title: string;
    publicationDate: string;
    description?: string;
    imageUrl?: string;
  }>,
): string {
  return `<?xml version="1.0"?>
<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>
${entries
  .map(
    (entry) => `<item>
  <title>${entry.title}</title>
  <link>${entry.url}</link>
  <description><![CDATA[${entry.description ?? "Kratak opis"}]]></description>
  ${entry.imageUrl ? `<media:content url="${entry.imageUrl}" type="image/jpeg"/>` : ""}
  <pubDate>${entry.publicationDate}</pubDate>
</item>`,
  )
  .join("\n")}
</channel></rss>`;
}
