import { XMLParser } from "fast-xml-parser";
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

interface ParsedSitemapEntry {
  loc?: unknown;
  lastmod?: unknown;
  news?: {
    publication_date?: unknown;
    title?: unknown;
  };
}

interface ParsedSitemap {
  urlset?: {
    url?: ParsedSitemapEntry | ParsedSitemapEntry[];
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: true,
  trimValues: true,
});

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
  let document: ParsedSitemap;
  try {
    document = parser.parse(xml) as ParsedSitemap;
  } catch (error) {
    throw new Error(`Invalid sitemap XML: ${errorMessage(error)}`);
  }

  const rawEntries = document.urlset?.url;
  if (!rawEntries) {
    throw new Error("Invalid sitemap XML: urlset/url is missing");
  }

  const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
  const unique = new Map<string, SitemapArticle>();

  for (const entry of entries) {
    const rawUrl = asNonEmptyString(entry.loc);
    const title = asNonEmptyString(entry.news?.title);
    const publicationDate =
      asNonEmptyString(entry.news?.publication_date) ?? asNonEmptyString(entry.lastmod);
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

  return [...unique.values()].sort(
    (left, right) => Date.parse(left.publicationDate) - Date.parse(right.publicationDate),
  );
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
