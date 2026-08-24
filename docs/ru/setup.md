# LLM Council — установка и запуск

## 1. Зависимости

Используется [uv](https://docs.astral.sh/uv/) для Python и npm для фронтенда. Требуется Python ≥ 3.10 и Node.js ≥ 18.

**Бэкенд** (из корня проекта):
```bash
uv sync
```
Создаётся виртуальное окружение `.venv/` и ставятся пакеты из `pyproject.toml` (FastAPI, uvicorn, httpx, pydantic, python-dotenv).

**Фронтенд**:
```bash
cd frontend
npm install
```

## 2. Переменные окружения (`.env` в корне проекта)

```bash
# Базовый URL OpenAI-совместимого прокси (например LiteLLM)
OPENAI_COMPATIBLE_URL=http://localhost:8000/v1

# Опционально: ключ авторизации прокси
# OPENAI_COMPATIBLE_KEY=...
```

- `OPENAI_COMPATIBLE_URL` — обязателен, адрес прокси. К нему автоматически дописывается `/chat/completions`.
- `OPENAI_COMPATIBLE_KEY` — опционален. Если задан, в запрос добавляется `Authorization: Bearer ...`; если нет — заголовок опускается.

## 3. Запуск

Два отдельных терминала (или фоном).

**Бэкенд** (порт 8001):
```bash
uv run python -m backend.main
```

**Фронтенд** (порт 5173):
```bash
cd frontend
npm run dev
```

После запуска открыть http://localhost:5173.

Готовый скрипт `./start.sh` поднимает оба сервиса сразу (только под bash — на Windows не запускать напрямую).

## 4. Где что менять

| Что | Файл | Где |
| --- | --- | --- |
| Порт бэкенда | `backend/main.py` | строка `uvicorn.run(app, host="0.0.0.0", port=8001)` |
| Порт фронтенда | `frontend/vite.config.js` | добавить `server: { port: 5173 }` в объект конфига (по умолчанию 5173) |
| CORS-Origins | `backend/main.py` | `allow_origins=[...]` в `CORSMiddleware` |
| Прокси URL | `.env` | `OPENAI_COMPATIBLE_URL` |
| Ключ прокси | `.env` | `OPENAI_COMPATIBLE_KEY` (опц.) |
| Модели совета | `backend/config.py` | список `COUNCIL_MODELS` — кортежи `(provider, model_name)` |
| Модель-председатель (Stage 3) | `backend/config.py` | `CHAIRMAN_MODEL` — кортеж `(provider, model_name)` |
| Модель для заголовков бесед | `backend/config.py` | `TITLE_MODEL` — кортеж `(provider, model_name)` |

### Формат моделей

`COUNCIL_MODELS`, `CHAIRMAN_MODEL`, `TITLE_MODEL` — это кортежи `(provider, model_name)`. В прокси они отправляются как `provider/model_name`. Пример:

```python
COUNCIL_MODELS = [
    ("openai", "gpt-5.1"),
    ("google", "gemini-3-pro-preview"),
    ("anthropic", "claude-sonnet-4.5"),
    ("x-ai", "grok-4"),
]
CHAIRMAN_MODEL = ("google", "gemini-3-pro-preview")
TITLE_MODEL    = ("google", "gemini-2.5-flash")
```

После любых правок конфигурации или `.env` — перезапустить бэкенд.

## 5. Возможные проблемы

- **Порт занят** — смените порт в `backend/main.py` (бэкенд) или `frontend/vite.config.js` (фронтенд) и обновите `allow_origins` в `backend/main.py`, если меняете порт фронтенда.
- **Модули не находятся при запуске** — запускайте бэкенд из корня проекта как `uv run python -m backend.main`, а не `python backend/main.py`.
- **Прокси возвращает 401/403** — задайте `OPENAI_COMPATIBLE_KEY` в `.env`.
- **Модели прокси не находятся** — проверьте, что провайдер и имя в кортеже совпадают с тем, что знает ваш прокси (например у LiteLLM — `litellm --model openai/gpt-5.1`).