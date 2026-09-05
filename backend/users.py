import json
import os
import secrets
import threading
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import bcrypt

from .config import ADMIN_PASSWORD, ADMIN_USERNAME, USERS_FILE

_LOCK = threading.Lock()


def _load() -> List[dict]:
    if not os.path.exists(USERS_FILE):
        return []
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    users_list = data.get("users", [])
    return users_list if isinstance(users_list, list) else []


def _save(users_list: List[dict]) -> None:
    os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
    tmp = USERS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"users": users_list}, f, indent=2, ensure_ascii=False)
    os.replace(tmp, USERS_FILE)


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def get_user_by_username(username: str) -> Optional[dict]:
    if not isinstance(username, str):
        return None
    target = username.strip().lower()
    for u in _load():
        if isinstance(u.get("username"), str) and u["username"].lower() == target:
            return u
    return None


def get_user_by_id(user_id: str) -> Optional[dict]:
    if not isinstance(user_id, str):
        return None
    for u in _load():
        if u.get("id") == user_id:
            return u
    return None


def list_users() -> List[dict]:
    return _load()


def count_users() -> int:
    return len(_load())


def get_first_admin() -> Optional[dict]:
    admins = [u for u in _load() if u.get("role") == "admin"]
    if not admins:
        return None
    admins.sort(key=lambda u: u.get("created_at", ""))
    return admins[0]


def create_user(username: str, password: str, role: str = "user") -> dict:
    if not isinstance(username, str) or not username.strip():
        raise ValueError("Имя пользователя не может быть пустым")
    if not isinstance(password, str) or len(password) < 6:
        raise ValueError("Пароль должен содержать не менее 6 символов")
    if role not in ("user", "admin"):
        raise ValueError("Неизвестная роль")
    clean_username = username.strip()
    with _LOCK:
        users_list = _load()
        for u in users_list:
            if isinstance(u.get("username"), str) and u["username"].lower() == clean_username.lower():
                raise ValueError("Пользователь с таким именем уже существует")
        user = {
            "id": str(uuid.uuid4()),
            "username": clean_username,
            "password_hash": _hash(password),
            "role": role,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        users_list.append(user)
        _save(users_list)
        return user


def delete_user(user_id: str) -> bool:
    with _LOCK:
        users_list = _load()
        new_list = [u for u in users_list if u.get("id") != user_id]
        if len(new_list) == len(users_list):
            return False
        _save(new_list)
        return True


def verify_credentials(username: str, password: str) -> Optional[dict]:
    user = get_user_by_username(username)
    if not user:
        return None
    try:
        ok = bcrypt.checkpw(password.encode("utf-8"), user.get("password_hash", "").encode("utf-8"))
    except Exception:
        return None
    return user if ok else None


def change_password(user_id: str, new_password: str) -> bool:
    if not isinstance(new_password, str) or len(new_password) < 6:
        raise ValueError("Пароль должен содержать не менее 6 символов")
    with _LOCK:
        users_list = _load()
        for u in users_list:
            if u.get("id") == user_id:
                u["password_hash"] = _hash(new_password)
                _save(users_list)
                return True
        return False


def update_user(user_id: str, username: Optional[str] = None, password: Optional[str] = None, role: Optional[str] = None) -> Optional[dict]:
    """
    Частичное обновление пользователя администратором. Передаются только
    те поля, которые нужно изменить. Защита: нельзя понизить единственного
    администратора.
    """
    with _LOCK:
        users_list = _load()
        target = next((u for u in users_list if u.get("id") == user_id), None)
        if target is None:
            return None

        if username is not None:
            if not isinstance(username, str) or not username.strip():
                raise ValueError("Имя пользователя не может быть пустым")
            clean = username.strip()
            for u in users_list:
                if u.get("id") != user_id and isinstance(u.get("username"), str) and u["username"].lower() == clean.lower():
                    raise ValueError("Пользователь с таким именем уже существует")
            target["username"] = clean

        if password is not None:
            if not isinstance(password, str) or len(password) < 6:
                raise ValueError("Пароль должен содержать не менее 6 символов")
            target["password_hash"] = _hash(password)

        if role is not None:
            if role not in ("user", "admin"):
                raise ValueError("Неизвестная роль")
            if role != "admin" and target.get("role") == "admin":
                remaining = [u for u in users_list if u.get("id") != user_id and u.get("role") == "admin"]
                if not remaining:
                    raise ValueError("Нельзя понизить последнего администратора")
            target["role"] = role

        _save(users_list)
        return target


def user_public(user: dict) -> dict:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "role": user.get("role"),
        "created_at": user.get("created_at"),
    }


def ensure_admin_user() -> Optional[dict]:
    if count_users() > 0:
        return None
    password = ADMIN_PASSWORD
    generated = False
    if not password:
        password = secrets.token_urlsafe(12)
        generated = True
    admin = create_user(ADMIN_USERNAME, password, role="admin")
    if generated:
        print("=" * 64)
        print("ВНИМАНИЕ: пользователей не было — создан администратор по умолчанию.")
        print(f"  Логин: {ADMIN_USERNAME}")
        print(f"  Пароль (сохраните сейчас, больше не показывается): {password}")
        print("  Чтобы зафиксировать, задайте ADMIN_USERNAME/ADMIN_PASSWORD в .env")
        print("=" * 64)
    return admin
