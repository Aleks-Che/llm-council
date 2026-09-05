import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import USER_DATA_ROOT


def ensure_user_dir(user_id: str) -> None:
    os.makedirs(os.path.join(USER_DATA_ROOT, user_id, "conversations"), exist_ok=True)


def get_conversation_path(user_id: str, conversation_id: str) -> str:
    return os.path.join(USER_DATA_ROOT, user_id, "conversations", f"{conversation_id}.json")


def _read(user_id: str, conversation_id: str) -> Optional[Dict[str, Any]]:
    path = get_conversation_path(user_id, conversation_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _write(user_id: str, conversation: Dict[str, Any]) -> None:
    ensure_user_dir(user_id)
    path = get_conversation_path(user_id, conversation["id"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(conversation, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def create_conversation(user_id: str, conversation_id: str) -> Dict[str, Any]:
    conversation = {
        "id": conversation_id,
        "user_id": user_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "title": "Новый диалог",
        "messages": [],
    }
    _write(user_id, conversation)
    return conversation


def get_conversation(user_id: str, conversation_id: str) -> Optional[Dict[str, Any]]:
    return _read(user_id, conversation_id)


def save_conversation(user_id: str, conversation: Dict[str, Any]) -> None:
    _write(user_id, conversation)


def list_conversations(user_id: str) -> List[Dict[str, Any]]:
    d = os.path.join(USER_DATA_ROOT, user_id, "conversations")
    if not os.path.isdir(d):
        return []
    conversations: List[Dict[str, Any]] = []
    for filename in os.listdir(d):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(d, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        conversations.append({
            "id": data["id"],
            "created_at": data["created_at"],
            "title": data.get("title", "Новый диалог"),
            "message_count": len(data.get("messages", [])),
        })
    conversations.sort(key=lambda x: x["created_at"], reverse=True)
    return conversations


def add_user_message(user_id: str, conversation_id: str, content: str, search_enabled: bool = False) -> None:
    conversation = get_conversation(user_id, conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    conversation["messages"].append({"role": "user", "content": content, "search_enabled": search_enabled})
    save_conversation(user_id, conversation)


def add_assistant_placeholder(user_id: str, conversation_id: str, search_enabled: bool = False) -> None:
    conversation = get_conversation(user_id, conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    conversation["messages"].append({
        "role": "assistant",
        "stage1": None,
        "stage2": None,
        "stage3": None,
        "metadata": None,
        "research": None,
        "status": "running",
        "current_stage": "research" if search_enabled else "stage1",
        "error": None,
    })
    save_conversation(user_id, conversation)


def update_last_assistant_message(user_id: str, conversation_id: str, **fields: Any) -> None:
    conversation = get_conversation(user_id, conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    for message in reversed(conversation["messages"]):
        if message.get("role") == "assistant":
            message.update(fields)
            save_conversation(user_id, conversation)
            return
    raise ValueError(f"Conversation {conversation_id} has no assistant message")


def mark_interrupted_runs() -> None:
    if not os.path.isdir(USER_DATA_ROOT):
        return
    for user_dir in os.listdir(USER_DATA_ROOT):
        convs_dir = os.path.join(USER_DATA_ROOT, user_dir, "conversations")
        if not os.path.isdir(convs_dir):
            continue
        for filename in os.listdir(convs_dir):
            if not filename.endswith(".json"):
                continue
            path = os.path.join(convs_dir, filename)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, OSError):
                continue
            messages = data.get("messages", [])
            if not messages:
                continue
            last = messages[-1]
            if last.get("role") == "assistant" and last.get("status") == "running":
                last["status"] = "interrupted"
                last["current_stage"] = None
                last["error"] = "Сервер был перезапущен во время выполнения."
                research = last.get("research")
                if research and research.get("status") == "running":
                    research.update(status="interrupted", phase="done", stop_reason="interrupted")
                    research["revision"] = research.get("revision", 0) + 1
                tmp = path + ".tmp"
                try:
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=2, ensure_ascii=False)
                    os.replace(tmp, path)
                except OSError:
                    pass


def update_conversation_title(user_id: str, conversation_id: str, title: str) -> None:
    conversation = get_conversation(user_id, conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    conversation["title"] = title
    save_conversation(user_id, conversation)


def delete_conversation(user_id: str, conversation_id: str) -> bool:
    path = get_conversation_path(user_id, conversation_id)
    if not os.path.exists(path):
        return False
    os.remove(path)
    research_dir = os.path.join(USER_DATA_ROOT, user_id, "research")
    if os.path.isdir(research_dir):
        for filename in os.listdir(research_dir):
            if filename.startswith(f"{conversation_id}-") and filename.endswith(".json"):
                os.remove(os.path.join(research_dir, filename))
    return True


def save_research_documents(user_id: str, conversation_id: str, research_id: str, documents: dict) -> None:
    directory = os.path.join(USER_DATA_ROOT, user_id, "research")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{conversation_id}-{research_id}.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(documents, f, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def get_research_document(user_id: str, conversation_id: str, research_id: str, source_id: str) -> Optional[dict]:
    # Callers verify both run ownership and identifiers against the saved conversation.
    path = os.path.join(USER_DATA_ROOT, user_id, "research", f"{conversation_id}-{research_id}.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get(source_id)
    except (OSError, ValueError):
        return None
