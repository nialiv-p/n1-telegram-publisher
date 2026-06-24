import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

describe("HTTP interface", () => {
  it("returns health state without configuration secrets", async () => {
    const env = {
      DB: healthDatabase(),
      TELEGRAM_BOT_TOKEN: "must-not-leak",
      TELEGRAM_CHANNEL_ID: "@channel",
      INGEST_SECRET: "ingest-secret",
    } as Env;

    const response = await worker.fetch?.(
      new Request("https://worker.example/health"),
      env,
    );
    const body = (await response?.json()) as Record<string, unknown>;

    expect(response?.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      initializedAt: "2026-06-24T12:00:00.000Z",
      lastRunAt: "2026-06-24T12:10:00.000Z",
      lastSuccessfulRunAt: "2026-06-24T12:10:00.000Z",
      pending: 2,
      retry: 1,
      failed: 3,
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("returns 404 for other routes", async () => {
    const response = await worker.fetch?.(
      new Request("https://worker.example/"),
      {} as Env,
    );
    expect(response?.status).toBe(404);
  });

  it("rejects unauthenticated feed ingestion", async () => {
    const response = await worker.fetch?.(
      new Request("https://worker.example/discover", { method: "POST", body: "<rss/>" }),
      { INGEST_SECRET: "ingest-secret" } as Env,
    );
    expect(response?.status).toBe(401);
  });

  it("rejects oversized feed ingestion before reading D1", async () => {
    const response = await worker.fetch?.(
      new Request("https://worker.example/discover", {
        method: "POST",
        headers: {
          Authorization: "Bearer ingest-secret",
          "Content-Length": "1000001",
        },
        body: "<rss/>",
      }),
      { INGEST_SECRET: "ingest-secret" } as Env,
    );
    expect(response?.status).toBe(413);
  });
});

function healthDatabase(): D1Database {
  const state: Record<string, string> = {
    initialized_at: "2026-06-24T12:00:00.000Z",
    last_run_at: "2026-06-24T12:10:00.000Z",
    last_successful_run_at: "2026-06-24T12:10:00.000Z",
  };

  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          values = bound;
          return this;
        },
        async first() {
          if (sql.includes("FROM app_state")) {
            const value = state[String(values[0])];
            return value ? { value } : null;
          }
          return { pending: 2, retry: 1, failed: 3 };
        },
      };
    },
  } as unknown as D1Database;
}
