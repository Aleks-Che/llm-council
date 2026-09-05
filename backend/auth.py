import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import Depends, Header, HTTPException, status

from . import users
from .config import JWT_ALGORITHM, JWT_EXPIRE_MINUTES, JWT_SECRET_FILE

_SECRET: Optional[str] = None


def ensure_jwt_secret() -> str:
    global _SECRET
    if _SECRET:
        return _SECRET
    env = os.getenv("JWT_SECRET")
    if env:
        _SECRET = env
        return _SECRET
    if os.path.exists(JWT_SECRET_FILE):
        try:
            with open(JWT_SECRET_FILE, "r", encoding="utf-8") as f:
                s = f.read().strip()
        except OSError:
            s = ""
        if s:
            _SECRET = s
            return _SECRET
    _SECRET = secrets.token_urlsafe(64)
    os.makedirs(os.path.dirname(JWT_SECRET_FILE), exist_ok=True)
    with open(JWT_SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(_SECRET)
    print(
        f"ВНИМАНИЕ: JWT_SECRET не задан в .env — сгенерирован и сохранён в {JWT_SECRET_FILE}. "
        f"Для продакшена задайте JWT_SECRET явно."
    )
    return _SECRET


def create_access_token(user_id: str) -> str:
    secret = ensure_jwt_secret()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=JWT_EXPIRE_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[str]:
    secret = ensure_jwt_secret()
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) and sub else None


async def get_current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Не авторизован")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Не авторизован")
    token = parts[1].strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Не авторизован")
    user_id = decode_token(token)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Невалидный токен")
    user = users.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Пользователь не найден")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Требуются права администратора")
    return user
