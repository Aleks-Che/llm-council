"""JSON-based storage for conversations."""

import json
import os
from datetime import datetime
from typing import List, Dict, Any, Optional
from pathlib import Path
from .config import DATA_DIR


def ensure_data_dir():
    """Ensure the data directory exists."""
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)


def get_conversation_path(conversation_id: str) -> str:
    """Get the file path for a conversation."""
    return os.path.join(DATA_DIR, f"{conversation_id}.json")


def create_conversation(conversation_id: str) -> Dict[str, Any]:
    """
    Create a new conversation.

    Args:
        conversation_id: Unique identifier for the conversation

    Returns:
        New conversation dict
    """
    ensure_data_dir()

    conversation = {
        "id": conversation_id,
        "created_at": datetime.utcnow().isoformat(),
        "title": "Новый диалог",
        "messages": []
    }

    # Save to file
    path = get_conversation_path(conversation_id)
    with open(path, 'w') as f:
        json.dump(conversation, f, indent=2)

    return conversation


def get_conversation(conversation_id: str) -> Optional[Dict[str, Any]]:
    """
    Load a conversation from storage.

    Args:
        conversation_id: Unique identifier for the conversation

    Returns:
        Conversation dict or None if not found
    """
    path = get_conversation_path(conversation_id)

    if not os.path.exists(path):
        return None

    with open(path, 'r') as f:
        return json.load(f)


def save_conversation(conversation: Dict[str, Any]):
    """
    Save a conversation to storage.

    Args:
        conversation: Conversation dict to save
    """
    ensure_data_dir()

    path = get_conversation_path(conversation['id'])
    with open(path, 'w') as f:
        json.dump(conversation, f, indent=2)


def list_conversations() -> List[Dict[str, Any]]:
    """
    List all conversations (metadata only).

    Returns:
        List of conversation metadata dicts
    """
    ensure_data_dir()

    conversations = []
    for filename in os.listdir(DATA_DIR):
        if filename.endswith('.json'):
            path = os.path.join(DATA_DIR, filename)
            with open(path, 'r') as f:
                data = json.load(f)
                # Return metadata only
                conversations.append({
                    "id": data["id"],
                    "created_at": data["created_at"],
                    "title": data.get("title", "Новый диалог"),
                    "message_count": len(data["messages"])
                })

    # Sort by creation time, newest first
    conversations.sort(key=lambda x: x["created_at"], reverse=True)

    return conversations


def add_user_message(conversation_id: str, content: str):
    """
    Add a user message to a conversation.

    Args:
        conversation_id: Conversation identifier
        content: User message content
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    conversation["messages"].append({
        "role": "user",
        "content": content
    })

    save_conversation(conversation)


def add_assistant_placeholder(conversation_id: str):
    """
    Add an empty assistant message that a background council run will fill
    in progressively (stage results are saved as each stage completes).

    Args:
        conversation_id: Conversation identifier
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    conversation["messages"].append({
        "role": "assistant",
        "stage1": None,
        "stage2": None,
        "stage3": None,
        "metadata": None,
        "status": "running",
        "current_stage": "stage1",
        "error": None
    })

    save_conversation(conversation)


def update_last_assistant_message(conversation_id: str, **fields):
    """
    Update fields of the most recent assistant message (incremental
    persistence of council progress).

    Args:
        conversation_id: Conversation identifier
        **fields: Fields to set (stage1/stage2/stage3/metadata/status/
            current_stage/error)
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    for message in reversed(conversation["messages"]):
        if message.get("role") == "assistant":
            message.update(fields)
            save_conversation(conversation)
            return

    raise ValueError(f"Conversation {conversation_id} has no assistant message")


def mark_interrupted_runs():
    """
    Mark assistant messages still in 'running' state as 'interrupted'.

    Called on server startup: a persisted 'running' status means the server
    was restarted while a background run was in progress.
    """
    ensure_data_dir()

    for filename in os.listdir(DATA_DIR):
        if not filename.endswith('.json'):
            continue
        path = os.path.join(DATA_DIR, filename)
        try:
            with open(path, 'r') as f:
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
            with open(path, 'w') as f:
                json.dump(data, f, indent=2)


def update_conversation_title(conversation_id: str, title: str):
    """
    Update the title of a conversation.

    Args:
        conversation_id: Conversation identifier
        title: New title for the conversation
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise ValueError(f"Conversation {conversation_id} not found")

    conversation["title"] = title
    save_conversation(conversation)


def delete_conversation(conversation_id: str) -> bool:
    """
    Delete a conversation from storage.

    Args:
        conversation_id: Conversation identifier

    Returns:
        True if the conversation was deleted, False if it didn't exist
    """
    path = get_conversation_path(conversation_id)
    if not os.path.exists(path):
        return False

    os.remove(path)
    return True
