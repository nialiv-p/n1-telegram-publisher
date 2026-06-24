const PHOTO_CAPTION_LIMIT = 1024;
const TEXT_MESSAGE_LIMIT = 4096;

export interface TelegramContent {
  photoCaption: string;
  textMessage: string;
}

export function buildTelegramContent(
  title: string,
  description: string | undefined,
  url: string,
): TelegramContent {
  return {
    photoCaption: buildMessage(title, description, url, PHOTO_CAPTION_LIMIT),
    textMessage: buildMessage(title, description, url, TEXT_MESSAGE_LIMIT),
  };
}

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function buildMessage(
  rawTitle: string,
  rawDescription: string | undefined,
  rawUrl: string,
  limit: number,
): string {
  const link = `\n\n<a href="${escapeAttribute(rawUrl)}">Pročitajte na N1</a>`;
  const titleBudget = Math.max(1, limit - link.length - "<b></b>".length);
  const title = truncateAndEscape(rawTitle, titleBudget, false);
  const prefix = `<b>${title}</b>`;
  const descriptionBudget = Math.max(0, limit - prefix.length - link.length - 2);
  const description = rawDescription
    ? truncateAndEscape(rawDescription, descriptionBudget, true)
    : "";
  return description ? `${prefix}\n\n${description}${link}` : `${prefix}${link}`;
}

function truncateAndEscape(value: string, budget: number, wordBoundary: boolean): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const escaped = escapeTelegramHtml(normalized);
  if (escaped.length <= budget) {
    return escaped;
  }
  if (budget <= 1) {
    return budget === 1 ? "…" : "";
  }

  let raw = "";
  let escapedLength = 0;
  for (const character of normalized) {
    const escapedCharacter = escapeTelegramHtml(character);
    if (escapedLength + escapedCharacter.length > budget - 1) {
      break;
    }
    raw += character;
    escapedLength += escapedCharacter.length;
  }

  if (wordBoundary) {
    const lastSpace = raw.lastIndexOf(" ");
    if (lastSpace > Math.floor(raw.length * 0.6)) {
      raw = raw.slice(0, lastSpace);
    }
  }
  return `${escapeTelegramHtml(raw.trimEnd())}…`;
}

function escapeAttribute(value: string): string {
  return escapeTelegramHtml(value).replaceAll('"', "&quot;");
}
