# Avito Webhook Server — Railway Deployment

## Что это
Node.js сервер для приёма Avito webhook-уведомлений о новых сообщениях. Кеширует все переписки и предоставляет API для OpenClaw агента.

## Деплой на Railway

### 1. Создать проект
```bash
# Через CLI
railway init
railway up

# Или через UI: railway.app → New Project → Deploy from GitHub / local
```

### 2. Задать переменные окружения
В Railway dashboard → Variables:
```
AVITO_CLIENT_ID=8iuk2GH8klKXFComTfMG
AVITO_CLIENT_SECRET=IAM8rSTkaO9m31pLqrfRR8v6BZIkwzTOGFE_wA-h
AVITO_USER_ID=204620380
WEBHOOK_API_KEY=<сгенерировать случайную строку>
```

### 3. Добавить Volume (для персистентного кеша)
Railway dashboard → Service → Volumes → New Volume
- Mount path: `/app/cache`

### 4. Зарегистрировать webhook в Avito
После деплоя Railway даст URL типа `https://avito-webhook-xxx.up.railway.app`

Зарегистрировать в Avito API:
```bash
curl -X POST https://api.avito.ru/messenger/v3/webhook \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://avito-webhook-xxx.up.railway.app/webhook"}'
```

## API Endpoints

### Public
- `GET /health` — статус сервера, sync info
- `POST /webhook` — приём Avito webhooks (no auth)

### Protected (require `Authorization: Bearer <WEBHOOK_API_KEY>`)
- `GET /api/chats?limit=50&offset=0` — список чатов с метаинфо
- `GET /api/unread?days=3` — неотвеченные чаты (последнее сообщение от клиента)
- `GET /api/chats/{chatId}/messages` — сообщения конкретного чата из кеша
- `POST /sync` — принудительная синхронизация всех чатов

## Как это работает
1. Avito шлёт POST на `/webhook` при каждом новом сообщении
2. Сервер скачивает 50 последних сообщений этого чата через Avito API
3. Сохраняет в JSON + TXT формате
4. Каждые 15 мин — полный sync (до 1100 чатов), обновляет только изменившиеся
5. OpenClaw агент дёргает `/api/chats`, `/api/unread` для аналитики
