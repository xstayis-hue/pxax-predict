# Worker оплаты PXAXBET2016 AI

Оплата Telegram Stars без своего сервера и без туннеля: Cloudflare Worker на постоянном
адресе. Хранилище — KV, один ключ на пользователя.

**Задеплоено:** https://pxaxbet-payments.xstayis.workers.dev
Вебхук Telegram привязан, `getWebhookInfo` показывает `pending_update_count: 0` и пустой
`last_error_message`.

## Почему так

Прежний бэкенд (`server/server.js`) — Node-процесс на домашней машине, наружу он смотрел
через `cloudflared`-туннель. У туннеля адрес меняется при каждом перезапуске, а он зашит в
`CONFIG.API_BASE` внутри `index.html` — из-за этого оплата и триал «отваливались» (см.
README репозитория, «Что дальше», п. 1). Worker не зависит от домашней машины и от сессии
Cloudflare CLI: деплой либо из CI, либо одной командой.

## Роуты

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | Готовность, наличие секретов, текущая цена и срок |
| GET | `/api/status?uid=&initData=` | Статус PRO, `until`, цена, сроки, история платежей (только владельцу) |
| POST | `/api/trial` | Активировать пробные 3 дня (`{ initData }`) |
| POST | `/api/invoice` | Ссылка на счёт Stars для `Telegram.WebApp.openInvoice` |
| POST | `/tg/<WEBHOOK_SECRET>` | Вебхук Telegram (`message`, `pre_checkout_query`) |
| GET | `/api/admin/stats?key=` | Сводка: всего пользователей, активных PRO, использован ли триал |

## Секреты и переменные

Секреты уже загружены в воркер (`wrangler secret put`, в репозиторий не попадают):
`BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_KEY`. Значения лежат в
`C:\Users\xstay\Desktop\Xstayis\API-Keys\` (BOT_TOKEN — в `telegram-bots.txt`,
остальные — в `pxax-worker-secrets.txt`).

Публичные значения (цена, сроки, адрес мини-аппа) лежат в `wrangler.toml` → `[vars]`.
Поменять цену = поправить `STARS_PRICE` и `wrangler deploy`; фронтенд подтянет новое
значение из `/api/status`, ничего пересобирать не нужно.

## Обновление воркера

```bash
cd worker
CLOUDFLARE_API_TOKEN=<токен> CLOUDFLARE_ACCOUNT_ID=5a187bc4be93a0fba0e17678c3754983 \
  npx wrangler deploy
```

Токен лежит в `C:\Users\xstay\Desktop\Xstayis\API-Keys\cloudflare-token.txt`.
Либо из CI: `.github/workflows/deploy-payments.yml` деплоит при пуше в `worker/`, если в
репозитории есть секрет `CLOUDFLARE_API_TOKEN`.

## Первичная настройка с нуля (если понадобится переразвернуть)

```bash
cd worker
npx wrangler kv namespace create pxaxbet-users   # id -> wrangler.toml
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://<воркер>/tg/<WEBHOOK_SECRET>",
       "secret_token":"<WEBHOOK_SECRET>",
       "allowed_updates":["message","pre_checkout_query"]}'
```

> Проверка вебхука требует DNS: Telegram один раз ответил `Failed to resolve host` на
> свежий `*.workers.dev`, и на повторе через несколько секунд адрес разрешился. Если
> `setWebhook` снова вернёт такую ошибку — подожди и повтори, это не ошибка конфигурации.

После установки вебхука адрес воркера прописывается в приложение:

```bash
node worker/link.mjs https://pxaxbet-payments.xstayis.workers.dev
git commit -am "payments: адрес воркера" && git push
```

## Тесты

```bash
node worker/test/payments.test.mjs
```

Проверяются: подпись `initData` (валидная/подделанная/просроченная), идемпотентность
платежа по `telegram_payment_charge_id`, начисление поверх действующего срока, отказ в
повторном триале, отказ выдать историю платежей чужому `uid`.