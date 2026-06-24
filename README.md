# N1 → Telegram

Cloudflare Cron каждые пять минут запускает GitHub Actions через API. Workflow загружает публичную RSS-ленту `n1info.rs/feed/` и передаёт её в защищённый endpoint Cloudflare Worker. Worker возвращает до 10 действительно новых URL, после чего GitHub Actions извлекает с этих страниц полный вводный абзац и отправляет обогащённые записи Worker для публикации. Первый запуск только запоминает текущие статьи, поэтому старые новости не заполнят канал.

Такое разделение необходимо, потому что N1 блокирует исходящие запросы сети Cloudflare Workers. Worker сам не обращается к N1; все публичные страницы загружает GitHub Actions, а запросы `/discover` и `/publish` защищены общим секретом.

## Что публикуется

Разрешены разделы `vesti`, `svet`, `magazin`, `biznis`, `region`, `kultura`, `kolumne` и `zeleni-kutak`. Английские материалы, видео, анонсы передач, `n1-direktno` и неизвестные разделы исключаются.

Пост содержит изображение, заголовок, полный лид статьи и ссылку на оригинал. Если лид или страница недоступны, используется RSS-описание; если изображение недоступно, Worker автоматически отправляет текстовый пост.

## Подготовка Telegram

1. Создайте бота через [@BotFather](https://t.me/BotFather) командой `/newbot` и сохраните выданный токен.
2. Добавьте бота администратором нужного канала.
3. Выдайте ему право публикации сообщений.
4. Для публичного канала используйте идентификатор вида `@channel_name`. Для приватного канала потребуется числовой `chat_id` вида `-100...`.

Никогда не добавляйте токен в `wrangler.toml`, Git или логи.

## Развёртывание на Cloudflare

Требуются Node.js 20+ и бесплатный аккаунт Cloudflare.

```bash
npm install
npx wrangler login
npx wrangler d1 create n1-telegram-publisher
```

Команда создания D1 выведет `database_id`. Замените `REPLACE_WITH_D1_DATABASE_ID` в `wrangler.toml` полученным значением. Там же замените `@replace_with_channel_username` на идентификатор канала.

Примените схему базы и сохраните Telegram-токен как секрет:

```bash
npx wrangler d1 migrations apply n1-telegram-publisher --remote
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Создайте случайный секрет для endpoint `/discover` и `/publish`:

```bash
openssl rand -hex 32
```

Скопируйте полученное значение и введите **одинаковое значение** в обе команды:

```bash
npx wrangler secret put INGEST_SECRET
gh secret set INGEST_SECRET
```

Для запуска workflow создайте fine-grained GitHub token с доступом только к репозиторию `n1-telegram-publisher` и разрешением `Actions: Read and write`. Сохраните его только в Cloudflare:

```bash
npx wrangler secret put GITHUB_DISPATCH_TOKEN
```

Перед публикацией выполните проверки и deployment:

```bash
npm test
npm run typecheck
npm run deploy
```

После deployment отправьте workflow в первый ручной запуск:

```bash
gh workflow run ingest-feed.yml
```

Дальше Cloudflare Cron вызывает workflow автоматически каждые пять минут. На чистой D1 первый запуск заполнит записи статусом `seeded`, но ничего не отправит. Следующая подходящая статья будет опубликована автоматически.

## Локальная проверка

Создайте локальный файл `.dev.vars`, который уже исключён из Git:

```dotenv
TELEGRAM_BOT_TOKEN=your_test_token
TELEGRAM_CHANNEL_ID=@your_test_channel
INGEST_SECRET=your_local_ingest_secret
GITHUB_DISPATCH_TOKEN=your_local_github_token
```

Примените миграцию к локальной D1 и запустите Worker:

```bash
npx wrangler d1 migrations apply n1-telegram-publisher --local
npm run dev
```

Передайте RSS в локальный Worker, затем опубликуйте найденные записи:

```bash
curl -fsSL https://n1info.rs/feed/ -o /tmp/n1-feed.xml
curl -X POST http://localhost:8787/discover \
  -H "Authorization: Bearer your_local_ingest_secret" \
  -H "Content-Type: application/rss+xml" \
  --data-binary @/tmp/n1-feed.xml \
  -o /tmp/discovery.json
node scripts/enrich-articles.mjs /tmp/discovery.json /tmp/enriched.json
curl -X POST http://localhost:8787/publish \
  -H "Authorization: Bearer your_local_ingest_secret" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/enriched.json
```

Используйте отдельный тестовый канал, поскольку запрос действительно может отправить сообщение.

## Состояние и диагностика

`GET /health` возвращает:

```json
{
  "status": "ok",
  "initializedAt": "2026-06-24T12:00:00.000Z",
  "lastRunAt": "2026-06-24T12:10:00.000Z",
  "lastSuccessfulRunAt": "2026-06-24T12:10:00.000Z",
  "pending": 0,
  "retry": 0,
  "failed": 0
}
```

Логи Worker структурированы как JSON и доступны в Cloudflare dashboard или через:

```bash
npx wrangler tail
```

Временные ошибки повторяются с увеличивающейся задержкой. После пяти неудач статья получает статус `failed`. Вернуть все такие статьи в очередь можно командой:

```bash
npx wrangler d1 execute n1-telegram-publisher --remote --command "UPDATE articles SET status = 'retry', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status = 'failed';"
```

Для одной статьи добавьте к условию `AND url = 'https://n1info.rs/...'`.

## Поведение при сбоях

- Если GitHub Actions не смог загрузить RSS, Worker не вызывается и очередь не изменяется.
- Описание и изображение берутся непосредственно из RSS, поэтому Worker не загружает HTML-страницы статей.
- За один запуск отправляется не более 10 статей, от старых к новым. Между сообщениями выдерживается пауза для соблюдения лимитов Telegram.
- `/discover` и `/publish` принимают только запросы с правильным `INGEST_SECRET`; размер запроса ограничен 1 МБ.
- Уже известный нормализованный URL повторно не публикуется.
- После неоднозначного сетевого сбоя отправка повторяется. Это предотвращает потерю новости, но в редком случае Telegram мог принять первый запрос и создать дубль.
