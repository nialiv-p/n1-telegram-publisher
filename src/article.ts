import type { ArticleMetadata } from "./types";

const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const ATTRIBUTE_PATTERN = /([:\w-]+)\s*=\s*(["'])(.*?)\2/gs;

export async function fetchArticleMetadata(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArticleMetadata> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "N1TelegramPublisher/1.0 (+https://workers.dev)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {};
    }
    return parseArticleMetadata(await response.text());
  } catch {
    return {};
  }
}

export function parseArticleMetadata(html: string): ArticleMetadata {
  const metadata: Record<string, string> = {};
  for (const match of html.matchAll(META_TAG_PATTERN)) {
    const attributes = parseAttributes(match[0]);
    const key = (attributes.property ?? attributes.name)?.toLowerCase();
    if (key && attributes.content && metadata[key] === undefined) {
      metadata[key] = decodeHtmlEntities(attributes.content.trim());
    }
  }

  return {
    title: nonEmpty(metadata["og:title"]),
    description: nonEmpty(metadata["og:description"] ?? metadata.description),
    imageUrl: validHttpsUrl(metadata["og:image"]),
  };
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1];
    const value = match[3];
    if (name && value !== undefined) {
      attributes[name.toLowerCase()] = value;
    }
  }
  return attributes;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return safeCodePoint(Number.parseInt(code.slice(2), 16), entity);
    }
    if (code.startsWith("#")) {
      return safeCodePoint(Number.parseInt(code.slice(1), 10), entity);
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function safeCodePoint(codePoint: number, fallback: string): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
}

function validHttpsUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
