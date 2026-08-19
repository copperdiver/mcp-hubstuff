# Hubstaff MCP Server

Удалённый read-only MCP-сервер для официального Hubstaff API v2. Он предоставляет задачи, свежие изменения, источник задачи, агрегированное время и, при наличии Enterprise-доступа, журнал аудита через Streamable HTTP.

Сервер включает встроенный OAuth 2.1 authorization server для ChatGPT Developer mode: DCR, authorization code, PKCE S256, audience-bound JWT access tokens и ротируемые refresh tokens.

## MCP tools

- `hubstaff_list_organizations` — доступные организации и их ID.
- `hubstaff_capabilities` — поддерживаемые источники данных и ограничения API.
- `hubstaff_list_tasks` — задачи организации с фильтрами.
- `hubstaff_get_task` — подробности задачи и идентификаторы исходной системы.
- `hubstaff_recent_updates` — недавно изменённые задачи и записи времени.
- `hubstaff_task_hours` — часы по задаче и разбивка по пользователям.
- `hubstaff_list_audit_log_entries` — журнал аудита организации; требуется Enterprise и роль Owner/Manager.

Все инструменты только читают данные.

## Настройка

1. Скопируйте `.env.example` в `.env`.
2. Укажите `MCP_AUTH_TOKEN` длиной не менее 32 символов.
3. Для ChatGPT укажите `OAUTH_ISSUER`, `OAUTH_USERNAME`, `OAUTH_PASSWORD` и `OAUTH_SIGNING_SECRET`. OAuth-состояние сохраняется в `/data/oauth-state.json`.
4. Выберите один вариант авторизации Hubstaff:

   - `HUBSTAFF_ORGANIZATION_TOKEN` (`hsoat_...`) — рекомендуемый вариант для постоянно работающего сервера;
   - `HUBSTAFF_REFRESH_TOKEN` — Personal Access Token, который Hubstaff выдаёт как refresh token;
   - `HUBSTAFF_ACCESS_TOKEN` — временный access token.

Для PAT нужен scope `hubstaff:read`. Hubstaff вращает refresh token при каждом обмене; сервер атомарно сохраняет актуальную пару в `/data/token.json` внутри именованного Docker volume. Исходный ключ остаётся только в `.env`, а `.env` исключён из Git и Docker build context.

Запуск:

```bash
npm ci
npm run build
npm test
npm start
```

Docker:

```bash
docker compose up -d --build
```

## Подключение MCP-клиента

URL:

```text
https://hubstuff-mcp.copperdiver.studio/mcp
```

Для обычного MCP-клиента можно использовать служебный заголовок:

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

ChatGPT подключается по OAuth автоматически. Сервер публикует:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/register`, `/oauth/authorize`, `/oauth/token`

В ChatGPT включите **Settings → Security and login → Developer mode**, затем на странице Plugins добавьте URL `https://hubstuff-mcp.copperdiver.studio/mcp` с OAuth/DCR. Во время первого подключения введите `OAUTH_USERNAME` и `OAUTH_PASSWORD` из серверного `.env`.

Проверка доступности без секрета:

```bash
curl https://hubstuff-mcp.copperdiver.studio/health
```

## Ограничения Hubstaff

- Activity API отдаёт интервалы не более чем за 7 дней одним запросом; `hubstaff_task_hours` сам разбивает диапазон на части.
- История детальной активности доступна максимум примерно за 6 месяцев.
- Публичный Hubstaff API v2 не предоставляет комментарии задач. Для интегрированных задач используйте `project_type` и `remote_id`, чтобы обратиться к API исходной системы.
- Audit Log API доступен только организациям на Enterprise и требует роль Owner или Organization Manager с разрешением просмотра данных других пользователей. Журнал аудита не содержит комментарии задач.

Официальная документация: [Hubstaff API](https://developer.hubstaff.com/), [authentication](https://developer.hubstaff.com/authentication/), [tasks](https://developer.hubstaff.com/reference/tasks/), [activities](https://developer.hubstaff.com/reference/activities/), [audit log](https://developer.hubstaff.com/reference/audit_log_entries/).
