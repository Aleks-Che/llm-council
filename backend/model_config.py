"""Validated, per-user OpenAI-compatible connections."""

from typing import Literal, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CustomModel(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    id: str = Field(pattern=r"^custom/[a-f0-9]{32}$")
    url: str = Field(min_length=1, max_length=2048)
    model: str = Field(min_length=1, max_length=256)
    api_key: Optional[str] = Field(default=None, max_length=4096, repr=False)
    reasoning_effort: Optional[Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]] = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value):
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or any(c.isspace() for c in value)):
            raise ValueError("Укажите HTTP(S) URL API без логина, пароля и параметров")
        _ = parsed.port
        value = value.rstrip("/")
        if value.endswith("/chat/completions"):
            value = value[:-len("/chat/completions")]
        return value

    @field_validator("api_key")
    @classmethod
    def validate_key(cls, value):
        if value and any(ord(c) < 32 or ord(c) > 126 for c in value):
            raise ValueError("API key должен содержать только печатные ASCII-символы")
        return value
