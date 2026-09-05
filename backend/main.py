from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
import uuid
import time

import httpx

from . import auth, migrate, runs, settings_store, storage, users
from .client import model_id, query_model
from .search_config import SearchSettings
from .config import COUNCIL_MODELS, CHAIRMAN_MODEL, TITLE_MODEL, OPENAI_COMPATIBLE_URL, OPENAI_COMPATIBLE_KEY


@asynccontextmanager
async def lifespan(app: FastAPI):
    auth.ensure_jwt_secret()
    bootstrap = users.ensure_admin_user()
    admin_user = bootstrap or users.get_first_admin()
    if admin_user is not None:
        migrate.migrate_if_needed(admin_user["id"])
    storage.mark_interrupted_runs()
    yield


app = FastAPI(title="LLM Council API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    pass


class SendMessageRequest(BaseModel):
    content: str
    search_enabled: bool = False


class ConversationMetadata(BaseModel):
    id: str
    created_at: str
    title: str
    message_count: int
    is_running: bool


class Conversation(BaseModel):
    id: str
    created_at: str
    title: str
    messages: List[Dict[str, Any]]


class UpdateConversationRequest(BaseModel):
    title: str


class SettingsRequest(BaseModel):
    council_models: List[str]
    chairman_model: str
    search: Optional[SearchSettings] = None
    tavily_api_key: Optional[str] = Field(default=None, max_length=512)
    remove_tavily_key: bool = False


class TestModelRequest(BaseModel):
    model: str


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"


class UpdateUserRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


@app.get("/")
async def root():
    return {"status": "ok", "service": "LLM Council API"}


async def fetch_available_models() -> List[str]:
    url = OPENAI_COMPATIBLE_URL.rstrip("/") + "/models"
    headers = {}
    if OPENAI_COMPATIBLE_KEY:
        headers["Authorization"] = f"Bearer {OPENAI_COMPATIBLE_KEY}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            response = await http.get(url, headers=headers)
            response.raise_for_status()
            data = response.json()
            return [m["id"] for m in data.get("data", []) if m.get("id")]
    except Exception as e:
        print(f"Failed to fetch models from proxy: {e}")
        return []


@app.post("/api/auth/login")
async def login(request: LoginRequest):
    user = users.verify_credentials(request.username, request.password)
    if not user:
        raise HTTPException(status_code=401, detail="Неверное имя пользователя или пароль")
    token = auth.create_access_token(user["id"])
    return {"access_token": token, "token_type": "bearer", "user": users.user_public(user)}


@app.get("/api/auth/me")
async def me(current: dict = Depends(auth.get_current_user)):
    return users.user_public(current)


@app.post("/api/auth/change-password")
async def change_password(request: ChangePasswordRequest, current: dict = Depends(auth.get_current_user)):
    if not users.verify_credentials(current["username"], request.old_password):
        raise HTTPException(status_code=400, detail="Неверный текущий пароль")
    users.change_password(current["id"], request.new_password)
    return {"status": "ok"}


@app.get("/api/auth/users")
async def list_users_endpoint(admin: dict = Depends(auth.require_admin)):
    return [users.user_public(u) for u in users.list_users()]


@app.post("/api/auth/users")
async def create_user_endpoint(request: CreateUserRequest, admin: dict = Depends(auth.require_admin)):
    try:
        user = users.create_user(request.username, request.password, request.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return users.user_public(user)


@app.patch("/api/auth/users/{user_id}")
async def update_user_endpoint(user_id: str, request: UpdateUserRequest, admin: dict = Depends(auth.require_admin)):
    if request.username is None and request.password is None and request.role is None:
        raise HTTPException(status_code=400, detail="Не указаны поля для изменения")
    empty = []
    if request.username is not None and (not isinstance(request.username, str) or not request.username.strip()):
        empty.append("username")
    if request.password is not None and (not isinstance(request.password, str) or not request.password.strip()):
        empty.append("password")
    if request.role is not None and request.role not in ("user", "admin"):
        raise HTTPException(status_code=400, detail="Неизвестная роль")
    if empty:
        raise HTTPException(status_code=400, detail=f"Пустые поля: {', '.join(empty)}")
    try:
        updated = users.update_user(
            user_id,
            username=request.username,
            password=request.password,
            role=request.role,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if updated is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    return users.user_public(updated)


@app.delete("/api/auth/users/{user_id}")
async def delete_user_endpoint(user_id: str, admin: dict = Depends(auth.require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Нельзя удалить самого себя")
    target = users.get_user_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if target.get("role") == "admin":
        remaining = [u for u in users.list_users() if u.get("role") == "admin" and u.get("id") != user_id]
        if not remaining:
            raise HTTPException(status_code=400, detail="Нельзя удалить последнего администратора")
    users.delete_user(user_id)
    return {"status": "ok", "id": user_id}


@app.get("/api/settings")
async def get_settings_endpoint(current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    settings = settings_store.get_settings(user_id)
    defaults = settings_store.default_settings()
    proxy_models = await fetch_available_models()
    known = {model_id(p, m) for p, m in (*COUNCIL_MODELS, CHAIRMAN_MODEL, TITLE_MODEL)}
    available = sorted(
        set(proxy_models) | known | set(settings["council_models"]) | {settings["chairman_model"], settings["search"]["model"]}
    )
    return {
        "available_models": available,
        "council_models": settings["council_models"],
        "chairman_model": settings["chairman_model"],
        "search": settings["search"],
        "search_key": settings_store.search_key_status(user_id),
        "defaults": defaults,
    }


@app.post("/api/settings")
async def save_settings_endpoint(request: SettingsRequest, current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    try:
        saved = settings_store.save_settings(user_id, request.council_models, request.chairman_model,
            request.search, request.tavily_api_key, request.remove_tavily_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", **saved, "search_key": settings_store.search_key_status(user_id)}


@app.post("/api/settings/test-model")
async def test_model(request: TestModelRequest, current: dict = Depends(auth.get_current_user)):
    provider, model_name = settings_store.model_id_to_key(request.model)
    if not model_name.strip():
        raise HTTPException(status_code=400, detail="Пустой идентификатор модели")
    started = time.perf_counter()
    response = await query_model(
        provider,
        model_name,
        [{"role": "user", "content": "Ответь одним словом: 'готов'."}],
        timeout=60.0,
    )
    duration = round(time.perf_counter() - started, 2)
    ok = response is not None and bool((response.get("content") or "").strip())
    return {"ok": ok, "duration_s": duration}


@app.get("/api/conversations", response_model=List[ConversationMetadata])
async def list_conversations(current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    running = runs.running_ids()
    return [
        {**conv, "is_running": conv["id"] in running}
        for conv in storage.list_conversations(user_id)
    ]


@app.post("/api/conversations", response_model=Conversation)
async def create_conversation(request: CreateConversationRequest, current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    conversation_id = str(uuid.uuid4())
    return storage.create_conversation(user_id, conversation_id)


@app.get("/api/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str, current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    conversation = storage.get_conversation(user_id, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.patch("/api/conversations/{conversation_id}", response_model=ConversationMetadata)
async def update_conversation(conversation_id: str, request: UpdateConversationRequest, current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    conversation = storage.get_conversation(user_id, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    new_title = request.title.strip()
    if not new_title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")
    storage.update_conversation_title(user_id, conversation_id, new_title)
    return {
        "id": conversation_id,
        "created_at": conversation["created_at"],
        "title": new_title,
        "message_count": len(conversation["messages"]),
    }


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    conversation = storage.get_conversation(user_id, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    runs.cancel(conversation_id)
    storage.delete_conversation(user_id, conversation_id)
    return {"status": "ok", "id": conversation_id}


@app.post("/api/conversations/{conversation_id}/message")
async def send_message(conversation_id: str, request: SendMessageRequest, current: dict = Depends(auth.get_current_user)):
    user_id = current["id"]
    conversation = storage.get_conversation(user_id, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if runs.is_running(conversation_id):
        raise HTTPException(status_code=409, detail="Conversation already has a run in progress")
    if not request.content.strip():
        raise HTTPException(status_code=400, detail="Введите вопрос или прикрепите файл.")
    if request.search_enabled and not settings_store.get_search_api_key(user_id):
        raise HTTPException(status_code=400, detail="Для поиска добавьте ключ Tavily в настройках совета.")
    is_first_message = len(conversation["messages"]) == 0
    storage.add_user_message(user_id, conversation_id, request.content, request.search_enabled)
    storage.add_assistant_placeholder(user_id, conversation_id, request.search_enabled)
    started = runs.start(user_id, conversation_id, request.content, is_first_message, request.search_enabled)
    if not started:
        raise HTTPException(status_code=409, detail="Conversation already has a run in progress")
    return {"status": "started", "conversation_id": conversation_id}


@app.get("/api/conversations/{conversation_id}/research/{research_id}/sources/{source_id}")
async def get_research_source(conversation_id: uuid.UUID, research_id: uuid.UUID, source_id: str,
                              current: dict = Depends(auth.get_current_user)):
    cid, rid = str(conversation_id), str(research_id)
    conversation = storage.get_conversation(current["id"], cid)
    research = next((m["research"] for m in (conversation or {}).get("messages", [])
                     if (m.get("research") or {}).get("id") == rid), None)
    if not research or not any(s["id"] == source_id and s["status"] == "read" for s in research["sources"]):
        raise HTTPException(status_code=404, detail="Источник не найден")
    document = storage.get_research_document(current["id"], cid, rid, source_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Текст источника не найден")
    return document


@app.post("/api/conversations/{conversation_id}/cancel")
async def cancel_run(conversation_id: str, current: dict = Depends(auth.get_current_user)):
    if storage.get_conversation(current["id"], conversation_id) is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    runs.cancel(conversation_id)
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
