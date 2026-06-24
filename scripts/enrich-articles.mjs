import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

export async function main([inputPath, outputPath]) {
  if (!inputPath || !outputPath) {
    throw new Error("Usage: node scripts/enrich-articles.mjs <discovery.json> <output.json>");
  }

  const discovery = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(discovery.articles)) {
    throw new Error("Discovery response does not contain an articles array");
  }

  const enrichments = [];
  for (const article of discovery.articles) {
    validateArticle(article);
    let description = article.description;
    try {
      const html = await fetchArticle(article.url);
      description = extractLead(html) ?? description;
    } catch (error) {
      console.error(`Lead fallback for ${article.url}: ${errorMessage(error)}`);
    }
    enrichments.push({
      url: article.url,
      description,
      imageUrl: article.imageUrl,
    });
  }

  await writeFile(outputPath, `${JSON.stringify(enrichments)}\n`, "utf8");
  console.log(`Enriched ${enrichments.length} article(s)`);
}

export function extractLead(html) {
  const match = html.match(
    /<p\b(?=[^>]*\bdata-testid=["']article-lead-text["'])[^>]*>([\s\S]*?)<\/p>/i,
  );
  if (!match?.[1]) return undefined;
  const text = decodeHtmlEntities(match[1].replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

async function fetchArticle(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "n1-telegram-publisher/1.0 (+https://github.com/nialiv-p/n1-telegram-publisher)",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function validateArticle(article) {
  if (!article || typeof article !== "object" || typeof article.url !== "string") {
    throw new Error("Invalid article in discovery response");
  }
  const url = new URL(article.url);
  if (url.protocol !== "https:" || url.hostname !== "n1info.rs") {
    throw new Error(`Unexpected article URL: ${article.url}`);
  }
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return safeCodePoint(Number.parseInt(code.slice(2), 16), entity);
    }
    if (code.startsWith("#")) {
      return safeCodePoint(Number.parseInt(code.slice(1), 10), entity);
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function safeCodePoint(codePoint, fallback) {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
