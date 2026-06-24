import type {
  ArticleRepository,
  HealthSnapshot,
  SitemapArticle,
  StoredArticle,
} from "./types";

const STATE_INITIALIZED_AT = "initialized_at";
const STATE_LAST_RUN_AT = "last_run_at";
const STATE_LAST_SUCCESSFUL_RUN_AT = "last_successful_run_at";
const BATCH_SIZE = 100;

interface ArticleRow {
  url: string;
  title: string;
  publication_date: string;
  section: string;
  status: StoredArticle["status"];
  attempts: number;
}

interface HealthRow {
  pending: number;
  retry: number;
  failed: number;
}

export class D1ArticleRepository implements ArticleRepository {
  constructor(private readonly db: D1Database) {}

  async getState(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM app_state WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async seed(entries: SitemapArticle[], now: string): Promise<void> {
    await this.insertEntries(entries, "seeded", now);
    await this.db.batch([
      stateStatement(this.db, STATE_INITIALIZED_AT, now),
      stateStatement(this.db, STATE_LAST_RUN_AT, now),
      stateStatement(this.db, STATE_LAST_SUCCESSFUL_RUN_AT, now),
    ]);
  }

  async discover(entries: SitemapArticle[], now: string): Promise<void> {
    await this.insertEntries(entries, "pending", now);
    await this.db.batch([stateStatement(this.db, STATE_LAST_RUN_AT, now)]);
  }

  async recoverStaleSending(staleBefore: string, now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE articles
         SET status = 'retry', next_attempt_at = ?, updated_at = ?,
             last_error = 'Recovered stale sending state'
         WHERE status = 'sending' AND updated_at < ?`,
      )
      .bind(now, now, staleBefore)
      .run();
  }

  async listReady(now: string, limit: number): Promise<StoredArticle[]> {
    const result = await this.db
      .prepare(
        `SELECT url, title, publication_date, section, status, attempts
         FROM articles
         WHERE status = 'pending'
            OR (status = 'retry' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         ORDER BY publication_date ASC, discovered_at ASC
         LIMIT ?`,
      )
      .bind(now, limit)
      .all<ArticleRow>();
    return (result.results ?? []).map(toStoredArticle);
  }

  async claim(url: string, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE articles SET status = 'sending', updated_at = ?
         WHERE url = ? AND status IN ('pending', 'retry')`,
      )
      .bind(now, url)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async markSent(url: string, messageId: number, now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE articles
         SET status = 'sent', telegram_message_id = ?, last_error = NULL,
             next_attempt_at = NULL, sent_at = ?, updated_at = ?
         WHERE url = ?`,
      )
      .bind(messageId, now, now, url)
      .run();
  }

  async markFailure(
    url: string,
    attempts: number,
    status: "retry" | "failed",
    error: string,
    nextAttemptAt: string | null,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE articles
         SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE url = ?`,
      )
      .bind(status, attempts, error.slice(0, 1000), nextAttemptAt, now, url)
      .run();
  }

  async markRunSuccessful(now: string): Promise<void> {
    await this.db.batch([
      stateStatement(this.db, STATE_LAST_RUN_AT, now),
      stateStatement(this.db, STATE_LAST_SUCCESSFUL_RUN_AT, now),
    ]);
  }

  async health(): Promise<HealthSnapshot> {
    const [initializedAt, lastRunAt, lastSuccessfulRunAt, counts] = await Promise.all([
      this.getState(STATE_INITIALIZED_AT),
      this.getState(STATE_LAST_RUN_AT),
      this.getState(STATE_LAST_SUCCESSFUL_RUN_AT),
      this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
             COALESCE(SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END), 0) AS retry,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
           FROM articles`,
        )
        .first<HealthRow>(),
    ]);
    return {
      initializedAt,
      lastRunAt,
      lastSuccessfulRunAt,
      pending: Number(counts?.pending ?? 0),
      retry: Number(counts?.retry ?? 0),
      failed: Number(counts?.failed ?? 0),
    };
  }

  private async insertEntries(
    entries: SitemapArticle[],
    status: "seeded" | "pending",
    now: string,
  ): Promise<void> {
    for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
      const statements = entries.slice(offset, offset + BATCH_SIZE).map((entry) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO articles
               (url, title, publication_date, section, status, attempts, discovered_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .bind(
            entry.url,
            entry.title,
            entry.publicationDate,
            entry.section,
            status,
            now,
            now,
          ),
      );
      if (statements.length > 0) {
        await this.db.batch(statements);
      }
    }
  }
}

function stateStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value);
}

function toStoredArticle(row: ArticleRow): StoredArticle {
  return {
    url: row.url,
    title: row.title,
    publicationDate: row.publication_date,
    section: row.section,
    status: row.status,
    attempts: Number(row.attempts),
  };
}
