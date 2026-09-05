# CLAUDE.md - Technical Notes for LLM Council

This file contains technical details, architectural decisions, and important implementation notes for future development sessions.

## Project Overview

LLM Council is a 3-stage deliberation system where multiple LLMs collaboratively answer user questions. The key innovation is anonymized peer review in Stage 2, preventing models from playing favorites. Supports **multiple users** with isolated conversations and per-user council settings; authentication via JWT.

## Architecture

### Backend Structure (`backend/`)

**`config.py`**
- `COUNCIL_MODELS` (list of (provider, model_name) tuples) and `CHAIRMAN_MODEL` — hardcoded defaults.
- `TITLE_MODEL` — global fast model for title generation (not per-user).
- `OPENAI_COMPATIBLE_URL`/`OPENAI_COMPATIBLE_KEY` — local OpenAI-compatible proxy (e.g. LM-Proxy).
- `USERS_FILE`, `USER_DATA_ROOT` — user store and per-user data root (`data/users/{user_id}/`).
- `JWT_SECRET_FILE`, `JWT_ALGORITHM`, `JWT_EXPIRE_MINUTES` — JWT config.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — optional env to pre-create the first admin.
- Backend runs on **port 8002**; LLM proxy on **8001**.

**`users.py`** — JSON user store (`data/users.json`).
- Atomic writes (temp + rename), thread lock.
- bcrypt password hashing (`hashpw`/`checkpw`).
- Functions: `create_user`, `get_user_by_username/id`, `verify_credentials`, `list_users`, `delete_user`, `change_password`, `count_users`, `get_first_admin`, `ensure_admin_user` (bootstrap), `update_user` (admin-only partial update of username/password/role; protects last admin from demotion), `user_public` (strips hash).
- First-run bootstrap: if 0 users, creates admin from `ADMIN_USERNAME` + (env `ADMIN_PASSWORD` or auto-generated printed password).

**`auth.py`** — JWT + FastAPI auth dependencies.
- `ensure_jwt_secret()`: reads `JWT_SECRET` env → else loads `data/.jwt_secret` → else generates and saves (with WARNING).
- `create_access_token(user_id)` / `decode_token(token)` — PyJWT HS256, `sub` = user_id, `exp` = now + `JWT_EXPIRE_MINUTES`.
- `get_current_user(authorization: Header)` dependency — 401 on missing/invalid Bearer.
- `require_admin` dependency — 403 if not admin.

**`client.py`**
- `query_model()`: single async model query, default **600s** timeout (proxy enables reasoning; long prompts take minutes).
- `query_models_parallel()`: parallel via `asyncio.gather()`.
- Graceful degradation: returns None on failure.
- `ModelKey = Tuple[str, str]`.

**`council.py`** — 3-stage orchestration (no longer reads global settings).
- `stage1_collect_responses(user_query, council_models)` — required param.
- `stage2_collect_rankings(user_query, stage1_results, council_models)` — required param; reuses council_models as judges.
- `stage3_synthesize_final(user_query, stage1, stage2, chairman_model)` — required param.
- `parse_ranking_from_text()`, `calculate_aggregate_rankings()` — helpers.
- `generate_conversation_title(user_query)` — uses global `TITLE_MODEL` from config (not per-user).

**`settings_store.py`** — per-user settings.
- `get_settings(user_id)`, `save_settings(user_id, ...)`, `get_effective_models(user_id)`.
- Storage: `data/users/{user_id}/settings.json` (overrides only).
- Atomic write.

**`storage.py`** — per-user conversation storage.
- `data/users/{user_id}/conversations/{conv_id}.json`.
- `get_conversation(user_id, conv_id)` is user-scoped → automatic isolation (other users get None).
- `mark_interrupted_runs()` walks all `data/users/*/conversations/`.
- Atomic writes.

**`runs.py`** — background council runs.
- `start(user_id, conversation_id, query, is_first_message)` resolves the user's settings **once** (snapshot semantics) and passes models into the run task.
- `ACTIVE_RUNS` keyed by `conversation_id` (uuid is globally unique); stores `user_id` in the entry.
- `cancel(conversation_id)` used on delete.
- Title generation runs in parallel with the council.

**`migrate.py`** — one-shot legacy data migration.
- On first run (no `data/.migrated` marker): moves `data/conversations/*.json` + `data/settings.json` into the first admin's per-user directory, writes marker.
- Idempotent.

**`main.py`** — FastAPI app, lifespan, endpoints.
- CORS: localhost:5173, localhost:3000.
- Lifespan: `ensure_jwt_secret` → `ensure_admin_user` → `migrate_if_needed(first_admin_id)` → `mark_interrupted_runs`.
- Public endpoints: `POST /api/auth/login`, `GET /`.
- Authenticated (`Depends(get_current_user)`): `/api/auth/me`, `/api/auth/change-password`, all `/api/conversations*`, `/api/settings`, `/api/settings/test-model`.
- Admin (`Depends(require_admin)`): `GET/POST /api/auth/users`, `PATCH /api/auth/users/{id}` (update username/password/role; blocks demotion of last admin), `DELETE /api/auth/users/{id}` (blocks self-delete and last-admin delete).
- Run on port 8002.

### Frontend Structure (`frontend/src/`)

**`api.js`** — single `request()` helper attaches `Authorization: Bearer <token>` from localStorage; 401 → clears token + invokes `onUnauthorized` callback (set by App to show login). Exports `api.*` (login, me, changePassword, listUsers, createUser, deleteUser, conversations CRUD, settings, testModel) plus `getToken/setToken/clearToken`.

**`App.jsx`** — auth state + orchestration.
- On mount: if token present, `api.me()` to validate; on success set `user`, on 401 clear token.
- `authLoading` splash while validating.
- If no user → renders `<Login/>`. Otherwise main UI.
- `handleLogout` clears token + state.
- All conversation polling/listing gated on `user`.

**`components/Login.jsx`** + CSS — username/password form, calls `api.login`, stores token via `setToken`.

**`components/Sidebar.jsx`** — footer with username + role, "Выйти" button, and (admin) "Пользователи" button opening `UsersModal`.

**`components/UsersModal.jsx`** + CSS — admin panel: list users, create (username/password/role), delete (with confirm; backend blocks self/last-admin).

**`components/SettingsModal.jsx`** — unchanged behaviorally; settings are per-user on backend (resolved via token).

**`components/ChatInterface.jsx`**, **Stage1/2/3.jsx**, **CopyButton**, **ErrorBoundary** — unchanged.

## Key Design Decisions

### Auth Strategy
- **JWT (HS256)** in `Authorization: Bearer` header, stored in localStorage. Simple, works across ports (5173→8002) without cookie/SameSite pain.
- Token contains only `sub` (user_id); no role in token (role looked up fresh per request → admin demotion takes effect immediately).
- Secret: env `JWT_SECRET` preferred; else auto-generated and persisted to `data/.jwt_secret` with WARNING (delete the file to invalidate all tokens).

### User Isolation
- Per-user directory `data/users/{user_id}/`. `storage.get_conversation(user_id, ...)` naturally scopes; other users get None for foreign ids → 404.
- Settings per-user → each user configures their own council.

### Registration Policy
- **Closed registration**: first admin auto-created on first run; subsequent users created by admins via `POST /api/auth/users`. No public sign-up.

### Settings Snapshot Semantics
- `runs.start` resolves the user's council **once** at run start. If user changes settings mid-run, the in-flight run uses the old settings (predictable).

### Stage 2 Prompt Format
Strict numbered-list format after `FINAL RANKING:` for reliable parsing.

### De-anonymization
Models see anonymous labels; backend creates `label_to_model`; frontend renders model names in **bold** for readability.

### Error Handling
Graceful degradation: continue with successful model responses; never fail the whole request due to one model failure.

### UI/UX Transparency
All raw outputs inspectable via tabs; parsed rankings shown below raw text.

## Important Implementation Details

### Relative Imports
All backend modules use relative imports. Run as `python -m backend.main` from project root.

### Port Configuration
- Backend: 8002
- LLM proxy: 8001
- Frontend: 5173 (Vite default)

### LAN access
- Vite dev/preview binds `0.0.0.0` and proxies `/api` → `http://localhost:8002` (`frontend/vite.config.js`).
- `frontend/src/api.js` uses relative URLs (`API_BASE = ''`), so the browser always talks to its own origin; the proxy forwards `/api/*` to the backend.
- Backend CORS: `allow_origins=["*"]`, `allow_credentials=False` (JWT in `Authorization` header, no cookies). Incompatible `*`+credentials would crash on startup.
- Access from LAN: open `http://<server-lan-ip>:5173` from any device on the same network; the proxy takes care of the API.

### Markdown Rendering
All ReactMarkdown wrapped in `<div className="markdown-content">`.

### First-Run Admin Password
If `ADMIN_PASSWORD` env not set, a random password is generated and **printed to stdout once** at startup. Set `ADMIN_USERNAME`/`ADMIN_PASSWORD` in `.env` to fix it.

### Deleting Users — Safeguards
Backend refuses: deleting yourself, deleting the last admin.

### Data Migration
Runs once automatically on first server start after upgrade. Marker: `data/.migrated`. To re-run, delete the marker (but legacy files are already moved — re-run is a no-op unless you restore them).

## Common Gotchas

1. **Module imports**: run as `python -m backend.main` from project root.
2. **CORS**: origins must match `main.py` whitelist.
3. **JWT_SECRET**: if you change it (or delete `data/.jwt_secret`), all existing tokens invalidate → users must log in again.
4. **Conversation IDs are global UUIDs**: `runs.ACTIVE_RUNS` is keyed only by `conversation_id` (uniqueness holds). User isolation is via storage lookup, not the run map.
5. **Per-user settings**: each user has independent council; one user's change doesn't affect another.

## Data Flow

```
Login (POST /api/auth/login) → JWT stored in localStorage
    ↓
User sends message
    ↓
Frontend attaches Authorization: Bearer <token>
    ↓
Stage 1: parallel queries to user's council
    ↓
Stage 2: anonymize → parallel ranking queries → parse rankings
    ↓
Aggregate rankings
    ↓
Stage 3: chairman synthesis (user's chairman model)
    ↓
Persist progress after each stage; client polls
```

## Future Enhancement Ideas

- Refresh tokens, token revocation list
- Rate limiting on /api/auth/login (in-memory per IP)
- Public registration toggle (env flag)
- SQLite migration for >10 users / analytics
- Configurable council/chairman via UI is already done (per-user SettingsModal)
- Streaming responses instead of batch loading
- Export conversations to markdown/PDF
