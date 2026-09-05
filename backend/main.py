"""FastAPI backend for LLM Council."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import uuid
import time

import httpx

from . import runs, storage, settings_store
from .client import model_id, query_model
from .config import COUNCIL_MODELS, CHAIRMAN_MODEL, TITLE_MODEL, OPENAI_COMPATIBLE_URL, OPENAI_COMPATIBLE_KEY


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Запуски, оставшиеся в статусе "running" после перезапуска сервера,
    # помечаем как прерванные.
    storage.mark_interrupted_runs()
    yield


app = FastAPI(title="LLM Council API", lifespan=lifespan)

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateConversationRequest(BaseModel):
    """Request to create a new conversation."""
    pass


class SendMessageRequest(BaseModel):
    """Request to send a message in a conversation."""
    content: str


class ConversationMetadata(BaseModel):
    """Conversation metadata for list view."""
    id: str
    created_at: str
    title: str
    message_count: int
    is_running: bool


class Conversation(BaseModel):
    """Full conversation with all messages."""
    id: str
    created_at: str
    title: str
    messages: List[Dict[str, Any]]


class UpdateConversationRequest(BaseModel):
    """Request to update a conversation (e.g. rename)."""
    title: str


class SettingsRequest(BaseModel):
    """Request to save user settings (council composition + chairman)."""
    council_models: List[str]
    chairman_model: str


class TestModelRequest(BaseModel):
    """Request to run a short connectivity test for a single model."""
    model: str


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "LLM Council API"}


async def fetch_available_models() -> List[str]:
    """
    Fetch the list of model ids exposed by the OpenAI-compatible proxy.
    Returns an empty list if the proxy is unreachable.
    """
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


@app.get("/api/settings")
async def get_settings():
    """
    Get current settings plus the list of models available for selection.

    Checkbox logic for the UI: a model is checked if it is in the effective
    council list (settings override; config defaults otherwise).
    """
    settings = settings_store.get_settings()
    defaults = settings_store.default_settings()

    proxy_models = await fetch_available_models()

    # Union: proxy models + everything referenced by config/settings,
    # so the UI stays usable even if the proxy is down.
    known = {
        model_id(p, m) for p, m in (*COUNCIL_MODELS, CHAIRMAN_MODEL, TITLE_MODEL)
    }
    available = sorted(
        set(proxy_models) | known | set(settings["council_models"]) | {settings["chairman_model"]}
    )

    return {
        "available_models": available,
        "council_models": settings["council_models"],
        "chairman_model": settings["chairman_model"],
        "defaults": defaults,
    }


@app.post("/api/settings")
async def save_settings(request: SettingsRequest):
    """Save user settings (council composition + chairman model)."""
    try:
        saved = settings_store.save_settings(request.council_models, request.chairman_model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", **saved}


@app.post("/api/settings/test-model")
async def test_model(request: TestModelRequest):
    """
    Run a short test query against a single model.
    Returns {"ok": bool, "duration_s": float} - never raises for model errors.
    """
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
async def list_conversations():
    """List all conversations (metadata only, plus live run status)."""
    running = runs.running_ids()
    return [
        {**conv, "is_running": conv["id"] in running}
        for conv in storage.list_conversations()
    ]


@app.post("/api/conversations", response_model=Conversation)
async def create_conversation(request: CreateConversationRequest):
    """Create a new conversation."""
    conversation_id = str(uuid.uuid4())
    conversation = storage.create_conversation(conversation_id)
    return conversation


@app.get("/api/conversations/{conversation_id}", response_model=Conversation)
async def get_conversation(conversation_id: str):
    """Get a specific conversation with all its messages."""
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.patch("/api/conversations/{conversation_id}", response_model=ConversationMetadata)
async def update_conversation(conversation_id: str, request: UpdateConversationRequest):
    """Update a conversation (rename)."""
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    new_title = request.title.strip()
    if not new_title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")

    storage.update_conversation_title(conversation_id, new_title)

    return {
        "id": conversation_id,
        "created_at": conversation["created_at"],
        "title": new_title,
        "message_count": len(conversation["messages"]),
    }


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    """Delete a conversation (cancels a background run if there is one)."""
    runs.cancel(conversation_id)
    deleted = storage.delete_conversation(conversation_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"status": "ok", "id": conversation_id}


@app.post("/api/conversations/{conversation_id}/message")
async def send_message(conversation_id: str, request: SendMessageRequest):
    """
    Send a message and start the 3-stage council process in the background.

    The process runs server-side and persists progress after each stage, so
    it survives frontend disconnects/reloads. The client polls the
    conversation to observe progress. Returns immediately.
    """
    # Check if conversation exists
    conversation = storage.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # One council run per conversation at a time
    if runs.is_running(conversation_id):
        raise HTTPException(
            status_code=409, detail="Conversation already has a run in progress"
        )

    # Check if this is the first message
    is_first_message = len(conversation["messages"]) == 0

    # Persist user message and an empty assistant answer that the
    # background run will fill in stage by stage
    storage.add_user_message(conversation_id, request.content)
    storage.add_assistant_placeholder(conversation_id)

    started = runs.start(conversation_id, request.content, is_first_message)
    if not started:
        raise HTTPException(
            status_code=409, detail="Conversation already has a run in progress"
        )

    return {"status": "started", "conversation_id": conversation_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
