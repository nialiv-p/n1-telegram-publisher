import type { NewsArticle } from "./types";

export const FEED_URL = "https://n1info.rs/feed/";

const ALLOWED_SECTIONS = new Set([
  "vesti",
  "svet",
  "magazin",
  "biznis",
  "region",
  "kultura",
  "kolumne",
  "zeleni-kutak",
]);

const LINK_PATTERN = /<link>([\s\S]*?)<\/link>/;
const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/;
const DESCRIPTION_PATTERN = /<description>([\s\S]*?)<\/description>/;
const PUBLICATION_DATE_PATTERN = /<pubDate>([\s\S]*?)<\/pubDate>/;
const MEDIA_PATTERN = /<media:content\b[^>]*\burl=(["'])(.*?)\1/i;

export function parseFeed(xml: string): NewsArticle[] {
  if (!xml.includes("<rss") || !xml.includes("</rss>")) {
    throw new Error("Invalid RSS XML: rss/item is missing");
  }

  const unique = new Map<string, NewsArticle>();
  let itemCount = 0;
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    itemCount += 1;
    const block = match[1] ?? "";
    const rawUrl = extractXmlText(block, LINK_PATTERN);
    const title = extractXmlText(block, TITLE_PATTERN);
    const rawPublicationDate = extractXmlText(block, PUBLICATION_DATE_PATTERN);
    if (!rawUrl || !title || !rawPublicationDate) continue;

    const publicationTimestamp = Date.parse(rawPublicationDate);
    const url = normalizeArticleUrl(rawUrl);
    const section = url ? getAllowedSection(url) : null;
    if (!url || !section || Number.isNaN(publicationTimestamp)) continue;

    unique.set(url, {
      url,
      title,
      publicationDate: new Date(publicationTimestamp).toISOString(),
      section,
      description: extractXmlText(block, DESCRIPTION_PATTERN) ?? undefined,
      imageUrl: extractMediaUrl(block),
    });
  }

  if (itemCount === 0) {
    throw new Error("Invalid RSS XML: rss/item is missing");
  }

  return [...unique.values()].sort((left, right) =>
    left.publicationDate.localeCompare(right.publicationDate),
  );
}

export function normalizeArticleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "n1info.rs") return null;
    url.hostname = "n1info.rs";
    url.search = "";
    url.hash = "";
    url.pathname = `/${url.pathname.split("/").filter(Boolean).join("/")}/`;
    return url.toString();
  } catch {
    return null;
  }
}

export function getAllowedSection(url: string): string | null {
  try {
    const section = new URL(url).pathname.split("/").filter(Boolean)[0];
    return section && ALLOWED_SECTIONS.has(section) ? section : null;
  } catch {
    return null;
  }
}

function extractMediaUrl(block: string): string | undefined {
  const raw = MEDIA_PATTERN.exec(block)?.[2];
  if (!raw) return undefined;
  try {
    const url = new URL(decodeXmlEntities(raw));
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function extractXmlText(block: string, pattern: RegExp): string | null {
  const raw = pattern.exec(block)?.[1];
  if (!raw) return null;
  const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)?.[1] ?? raw;
  const decoded = decodeXmlEntities(cdata).replace(/\s+/g, " ").trim();
  return decoded.length > 0 ? decoded : null;
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, code: string) => {
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
