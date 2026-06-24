import type { SitemapArticle } from "./types";

export const SITEMAP_URL = "https://n1info.rs/sitemap/sitemap_news_1.xml";

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

const LOC_PATTERN = /<loc>([\s\S]*?)<\/loc>/;
const LAST_MODIFIED_PATTERN = /<lastmod>([\s\S]*?)<\/lastmod>/;
const PUBLICATION_DATE_PATTERN = /<news:publication_date>([\s\S]*?)<\/news:publication_date>/;
const TITLE_PATTERN = /<news:title>([\s\S]*?)<\/news:title>/;

export function normalizeArticleUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "n1info.rs") {
      return null;
    }

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

export function parseSitemap(xml: string): SitemapArticle[] {
  if (!xml.includes("<urlset") || !xml.includes("</urlset>")) {
    throw new Error("Invalid sitemap XML: urlset/url is missing");
  }

  const unique = new Map<string, SitemapArticle>();
  let urlBlockCount = 0;

  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    urlBlockCount += 1;
    const block = match[1] ?? "";
    const rawUrl = extractXmlText(block, LOC_PATTERN);
    const title = extractXmlText(block, TITLE_PATTERN);
    const publicationDate =
      extractXmlText(block, PUBLICATION_DATE_PATTERN) ??
      extractXmlText(block, LAST_MODIFIED_PATTERN);
    if (!rawUrl || !title || !publicationDate || Number.isNaN(Date.parse(publicationDate))) {
      continue;
    }

    const url = normalizeArticleUrl(rawUrl);
    const section = url ? getAllowedSection(url) : null;
    if (!url || !section) {
      continue;
    }

    unique.set(url, { url, title, publicationDate, section });
  }

  if (urlBlockCount === 0) {
    throw new Error("Invalid sitemap XML: urlset/url is missing");
  }

  return [...unique.values()].sort(
    (left, right) => Date.parse(left.publicationDate) - Date.parse(right.publicationDate),
  );
}

function extractXmlText(block: string, pattern: RegExp): string | null {
  const raw = pattern.exec(block)?.[1];
  if (!raw) {
    return null;
  }
  const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)?.[1] ?? raw;
  const decoded = decodeXmlEntities(cdata).trim();
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
