# Hubstaff MCP Server

Удалённый read-only MCP-сервер для Hubstaff Time Tracking API v2 и Hubstaff Tasks API v1. Он предоставляет задачи, свежие изменения, комментарии и агрегированное время по задачам через Streamable HTTP.

## MCP tools

- `hubstaff_list_organizations` — доступные организации и их ID.
- `hubstaff_list_tasks` — задачи организации с фильтрами.
- `hubstaff_get_task` — подробности задачи Time Tracking.
- `hubstaff_recent_updates` — недавно изменённые задачи и записи времени.
- `hubstaff_task_hours` — часы по задаче и разбивка по пользователям.
- `hubstaff_tasks_list_projects` — проекты Hubstaff Tasks.
- `hubstaff_tasks_list_project_tasks` — задачи проектной доски.
- `hubstaff_tasks_get_task` — подробности задачи Hubstaff Tasks.
- `hubstaff_tasks_list_comments` — комментарии задачи, если endpoint доступен тарифу и токену.

Все инструменты только читают данные.

## Настройка

1. Скопируйте `.env.example` в `.env`.
2. Укажите `MCP_AUTH_TOKEN` длиной не менее 32 символов.
3. Выберите один вариант авторизации Hubstaff:

   - `HUBSTAFF_ORGANIZATION_TOKEN` (`hsoat_...`) — рекомендуемый вариант для постоянно работающего сервера;
   - `HUBSTAFF_REFRESH_TOKEN` — Personal Access Token, который Hubstaff выдаёт как refresh token;
   - `HUBSTAFF_ACCESS_TOKEN` — временный access token.

Для PAT нужны scopes `hubstaff:read` и `tasks:read`. Hubstaff вращает refresh token при каждом обмене; сервер атомарно сохраняет актуальную пару в `/data/token.json` внутри именованного Docker volume. Исходный ключ остаётся только в `.env`, а `.env` исключён из Git и Docker build context.

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

Заголовок:

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Проверка доступности без секрета:

```bash
curl https://hubstuff-mcp.copperdiver.studio/health
```

## Ограничения Hubstaff

- Activity API отдаёт интервалы не более чем за 7 дней одним запросом; `hubstaff_task_hours` сам разбивает диапазон на части.
- История детальной активности доступна максимум примерно за 6 месяцев.
- Комментарии относятся к Hubstaff Tasks API v1 и могут не отдаваться на некоторых тарифах или без scope `tasks:read`. В этом случае инструмент также проверяет комментарии, встроенные в ответ задачи, и возвращает понятную ошибку вместо пустого результата.

Официальная документация: [Hubstaff API](https://developer.hubstaff.com/), [authentication](https://developer.hubstaff.com/authentication/), [tasks](https://developer.hubstaff.com/reference/tasks/), [activities](https://developer.hubstaff.com/reference/activities/).
