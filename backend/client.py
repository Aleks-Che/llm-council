"""OpenAI-compatible API client for the council proxy."""

import asyncio
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlsplit, urlunsplit
import httpx
from typing import Dict, Any, List, Optional, Tuple

from .config import CHAT_COMPLETIONS_URL, OPENAI_COMPATIBLE_KEY

ModelKey = Tuple[str, str]  # (provider, model_name)
_connections = ContextVar("model_connections", default=None)


class ModelQueryError(Exception):
    """A model failure safe to display in the connection test."""


def _error_detail(error: Exception, url: str, api_key: str = "") -> str:
    parsed = urlsplit(url)
    endpoint = urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, "", ""))
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        try:
            data = response.json()
        except ValueError:
            data = None
        message = data.get("error", data.get("detail")) if isinstance(data, dict) else None
        if isinstance(message, dict):
            message = message.get("message")
        if not isinstance(message, str):
            message = response.text if data is None else response.reason_phrase
        detail = f"HTTP {response.status_code} — {endpoint}: {message}"
    elif isinstance(error, ModelQueryError):
        detail = f"{endpoint}: {error}"
    elif isinstance(error, httpx.TimeoutException):
        detail = f"{endpoint}: истекло время ожидания ответа"
    elif isinstance(error, httpx.RequestError):
        detail = f"{endpoint}: ошибка соединения ({type(error).__name__})"
    else:
        detail = f"{endpoint}: некорректный ответ API ({type(error).__name__})"
    # Providers sometimes echo credentials in error messages. Redact before truncating.
    for secret in (api_key, OPENAI_COMPATIBLE_KEY):
        if secret:
            detail = detail.replace(secret, "[REDACTED]")
    detail = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [REDACTED]", detail)
    return " ".join(detail.split())[:1000]


@contextmanager
def use_model_connections(connections: dict):
    """Task-local snapshot, inherited by council and research child tasks."""
    token = _connections.set(connections)
    try:
        yield
    finally:
        _connections.reset(token)


def model_label(identifier: str) -> str:
    return ((_connections.get() or {}).get(identifier) or {}).get("model", identifier)


def model_id(provider: str, model_name: str) -> str:
    """Combine provider and model_name into a single identifier."""
    if not provider:
        return model_name
    return f"{provider}/{model_name}"


def _build_headers() -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if OPENAI_COMPATIBLE_KEY:
        headers["Authorization"] = f"Bearer {OPENAI_COMPATIBLE_KEY}"
    return headers


async def query_model(
    provider: str,
    model_name: str,
    messages: List[Dict[str, str]],
    timeout: float = 1800.0,
    *,
    raise_on_error: bool = False,
) -> Optional[Dict[str, Any]]:
    """
    Query a single model via the OpenAI-compatible proxy.

    Args:
        provider: Provider prefix (e.g. "openai", "google").
        model_name: Model identifier within that provider.
        messages: List of message dicts with 'role' and 'content'.
        timeout: Network inactivity timeout in seconds. Default is high (1800s) because
            the proxy enables reasoning/thinking on upstream models, and
            open-ended prompts can take several minutes to answer.
        raise_on_error: Raise ModelQueryError with diagnostics for connection tests.

    Returns:
        Response dict with 'content' and optional 'reasoning_details', or None on failure.
    """
    payload = {
        "model": model_id(provider, model_name),
        "messages": messages,
    }
    started = time.perf_counter()
    connection = (_connections.get() or {}).get(model_id(provider, model_name))
    url, headers = CHAT_COMPLETIONS_URL, _build_headers()
    if provider == "custom" and connection is None:
        if raise_on_error:
            raise ModelQueryError("Параметры подключения пользовательской модели не найдены")
        return None
    if connection is not None:
        url = connection["url"].rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if connection.get("api_key"):
            headers["Authorization"] = f"Bearer {connection['api_key']}"
        payload["model"] = connection["model"]
        if connection.get("reasoning_effort") is not None:
            payload["reasoning_effort"] = connection["reasoning_effort"]

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                headers=headers,
                json=payload,
            )
            response.raise_for_status()

            data = response.json()
            message = data["choices"][0]["message"]
            if not isinstance(message.get("content"), str) or not message["content"].strip():
                raise ModelQueryError("API вернул пустой ответ модели")

            return {
                "content": message.get("content"),
                "reasoning_details": message.get("reasoning_details"),
            }

    except Exception as e:
        detail = _error_detail(e, url, connection.get("api_key") if connection else "")
        elapsed = time.perf_counter() - started
        detail += f" (прошло {elapsed:.1f} с"
        if isinstance(e, httpx.TimeoutException):
            detail += f"; {type(e).__name__}, таймаут {timeout:g} с"
        detail += ")"
        print(f"Error querying model {provider}/{model_name}: {detail}")
        if raise_on_error:
            raise ModelQueryError(detail) from None
        return None


async def query_models_parallel(
    models: List[ModelKey],
    messages: List[Dict[str, str]],
    on_response=None,
    on_error=None,
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Query multiple models in parallel.

    Args:
        models: List of (provider, model_name) tuples.
        messages: List of message dicts to send to each model.

    Returns:
        Dict mapping combined model identifier ("provider/model_name") to response dict (or None).
    """
    async def query(provider, name):
        try:
            response = await query_model(provider, name, messages, raise_on_error=True)
        except ModelQueryError as exc:
            if on_error is not None:
                on_error(model_id(provider, name), str(exc))
            return None
        if response is not None and on_response is not None:
            on_response(model_id(provider, name), response)
        return response

    tasks = [asyncio.create_task(query(provider, name)) for provider, name in models]
    try:
        responses = await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return {model_id(p, n): response for (p, n), response in zip(models, responses)}
