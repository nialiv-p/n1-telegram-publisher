import type { TelegramContent } from "./format";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

interface TelegramMessage {
  message_id: number;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfterSeconds?: number,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "TelegramError";
  }

  get canFallbackToText(): boolean {
    return !this.ambiguous && this.errorCode !== undefined && this.errorCode >= 400 && this.errorCode < 500 && this.errorCode !== 429;
  }
}

export async function publishToTelegram(
  token: string,
  channelId: string,
  content: TelegramContent,
  imageUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (imageUrl) {
    try {
      const message = await callTelegram<TelegramMessage>(
        token,
        "sendPhoto",
        {
          chat_id: channelId,
          photo: imageUrl,
          caption: content.photoCaption,
          parse_mode: "HTML",
        },
        fetchImpl,
      );
      return message.message_id;
    } catch (error) {
      if (!(error instanceof TelegramError) || !error.canFallbackToText) {
        throw error;
      }
    }
  }

  const message = await callTelegram<TelegramMessage>(
    token,
    "sendMessage",
    {
      chat_id: channelId,
      text: content.textMessage,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: false },
    },
    fetchImpl,
  );
  return message.message_id;
}

async function callTelegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new TelegramError(`Telegram request failed: ${errorMessage(error)}`, undefined, undefined, true);
  }

  let payload: TelegramResponse<T>;
  try {
    payload = (await response.json()) as TelegramResponse<T>;
  } catch {
    throw new TelegramError(
      `Telegram returned invalid JSON with HTTP ${response.status}`,
      response.status,
      undefined,
      response.ok,
    );
  }

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new TelegramError(
      payload.description ?? `Telegram returned HTTP ${response.status}`,
      payload.error_code ?? response.status,
      payload.parameters?.retry_after,
    );
  }
  return payload.result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
