"""Tavily transport. Page URLs are sent to the provider, never fetched locally."""

import asyncio
import ipaddress
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx


class SearchProviderError(Exception):
    pass


def public_url(value: str) -> str:
    """Validate and normalize source URLs before storing or rendering them."""
    try:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
            return ""
        parts = urlsplit(value)
        host = (parts.hostname or "").lower()
        if parts.scheme not in ("https", "http") or parts.username or parts.password:
            return ""
        if not host or "." not in host or host.endswith((".localhost", ".local", ".internal")):
            return ""
        try:
            if not ipaddress.ip_address(host).is_global:
                return ""
        except ValueError:
            pass
        if parts.port not in (None, 80, 443):
            return ""
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if not k.lower().startswith("utm_") and k.lower() not in ("fbclid", "gclid")]
        return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path or "/", urlencode(query), ""))
    except ValueError:
        return ""


class TavilyProvider:
    def __init__(self, api_key: str):
        self.client = httpx.AsyncClient(
            base_url="https://api.tavily.com", timeout=35,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        self.usage = {"search_requests": 0, "extract_requests": 0, "credits": 0}

    async def close(self):
        await self.client.aclose()

    async def _post(self, endpoint: str, payload: dict) -> dict:
        for attempt in range(2):
            self.usage[f"{endpoint}_requests"] += 1
            try:
                response = await self.client.post(f"/{endpoint}", json={**payload, "include_usage": True})
                if response.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                    await asyncio.sleep(1)
                    continue
                if response.status_code in (401, 403):
                    raise SearchProviderError("Tavily отклонил ключ API. Проверьте ключ в настройках.")
                if response.status_code in (432, 433):
                    raise SearchProviderError("Исчерпан лимит Tavily.")
                if response.status_code == 429:
                    raise SearchProviderError("Tavily временно ограничил частоту запросов.")
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                    raise SearchProviderError("Tavily вернул некорректный ответ.")
                credits = (data.get("usage") or {}).get("credits", 0)
                if isinstance(credits, (float, int)):
                    self.usage["credits"] += max(0, credits)
                return data
            except (httpx.HTTPError, ValueError) as exc:
                # Never expose upstream response bodies or headers (may contain credentials).
                raise SearchProviderError("Не удалось получить данные от Tavily. Попробуйте позже.") from exc
        raise SearchProviderError("Tavily временно недоступен.")

    async def search(self, query: str) -> dict:
        return await self._post("search", {
            "query": query, "search_depth": "advanced", "max_results": 5,
            "include_answer": False, "include_raw_content": False,
        })

    async def extract(self, urls: list[str], advanced: bool = False) -> dict:
        return await self._post("extract", {
            "urls": urls, "extract_depth": "advanced" if advanced else "basic",
            "format": "markdown", "timeout": 25 if advanced else 10,
        })
