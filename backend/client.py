"""OpenAI-compatible API client for the council proxy."""

import asyncio
import httpx
from typing import Dict, Any, List, Optional, Tuple

from .config import CHAT_COMPLETIONS_URL, OPENAI_COMPATIBLE_KEY

ModelKey = Tuple[str, str]  # (provider, model_name)


def model_id(provider: str, model_name: str) -> str:
    """Combine provider and model_name into a single identifier."""
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
    timeout: float = 600.0,
) -> Optional[Dict[str, Any]]:
    """
    Query a single model via the OpenAI-compatible proxy.

    Args:
        provider: Provider prefix (e.g. "openai", "google").
        model_name: Model identifier within that provider.
        messages: List of message dicts with 'role' and 'content'.
        timeout: Request timeout in seconds. Default is high (600s) because
            the proxy enables reasoning/thinking on upstream models, and
            open-ended prompts can take several minutes to answer.

    Returns:
        Response dict with 'content' and optional 'reasoning_details', or None on failure.
    """
    payload = {
        "model": model_id(provider, model_name),
        "messages": messages,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                CHAT_COMPLETIONS_URL,
                headers=_build_headers(),
                json=payload,
            )
            response.raise_for_status()

            data = response.json()
            message = data["choices"][0]["message"]

            return {
                "content": message.get("content"),
                "reasoning_details": message.get("reasoning_details"),
            }

    except Exception as e:
        print(f"Error querying model {provider}/{model_name}: {e}")
        return None


async def query_models_parallel(
    models: List[ModelKey],
    messages: List[Dict[str, str]],
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Query multiple models in parallel.

    Args:
        models: List of (provider, model_name) tuples.
        messages: List of message dicts to send to each model.

    Returns:
        Dict mapping combined model identifier ("provider/model_name") to response dict (or None).
    """
    tasks = [query_model(provider, model_name, messages) for provider, model_name in models]
    responses = await asyncio.gather(*tasks)
    return {model_id(p, n): response for (p, n), response in zip(models, responses)}