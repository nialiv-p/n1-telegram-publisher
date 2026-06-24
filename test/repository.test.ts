import { describe, expect, it } from "vitest";
import { D1ArticleRepository } from "../src/repository";
import type { NewsArticle } from "../src/types";

describe("D1 repository batching", () => {
  it("looks up existing URLs and inserts only unknown articles", async () => {
    const knownUrl = "https://n1info.rs/vesti/known/";
    const database = fakeDatabase(new Set([knownUrl]));
    const repository = new D1ArticleRepository(database.db);

    await repository.discover(
      [article(knownUrl, 0), article("https://n1info.rs/vesti/new/", 1)],
      "2026-06-24T12:00:00.000Z",
    );

    const insert = database.statements.find((statement) => statement.sql.includes("INSERT OR IGNORE"));
    expect(insert?.values).toContain("https://n1info.rs/vesti/new/");
    expect(insert?.values).not.toContain(knownUrl);
  });

  it("groups seed rows into bounded multi-row statements", async () => {
    const database = fakeDatabase();
    const repository = new D1ArticleRepository(database.db);
    const entries = Array.from({ length: 23 }, (_, index) =>
      article(`https://n1info.rs/vesti/article-${index}/`, index),
    );

    await repository.seed(entries, "2026-06-24T12:00:00.000Z");

    const inserts = database.statements.filter((statement) => statement.sql.includes("INSERT OR IGNORE"));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((statement) => statement.values.length)).toEqual([90, 90, 27]);
  });
});

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

function fakeDatabase(knownUrls = new Set<string>()) {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const recorded: RecordedStatement = { sql, values: [] };
      statements.push(recorded);
      const statement = {
        bind(...values: unknown[]) {
          recorded.values = values;
          return statement;
        },
        async all() {
          return {
            results: recorded.values
              .filter((value): value is string => typeof value === "string" && knownUrls.has(value))
              .map((url) => ({ url })),
          };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
  return { db: db as unknown as D1Database, statements };
}

function article(url: string, offset: number): NewsArticle {
  return {
    url,
    title: `Article ${offset}`,
    publicationDate: new Date(Date.UTC(2026, 5, 24, 12, 0, offset)).toISOString(),
    section: "vesti",
    description: `Description ${offset}`,
    imageUrl: `https://n1info.rs/image-${offset}.jpg`,
  };
}
