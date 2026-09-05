"""Validated, per-user limits for the optional research stage."""

from pydantic import BaseModel, ConfigDict, Field

from .config import TITLE_MODEL


class SearchSettings(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    model: str = Field(default="/".join(TITLE_MODEL), min_length=1, max_length=200)
    max_rounds: int = Field(default=2, ge=1, le=3)
    max_queries: int = Field(default=6, ge=1, le=6)
    max_pages: int = Field(default=10, ge=1, le=12)
    timeout_seconds: int = Field(default=180, ge=30, le=300)
    context_chars: int = Field(default=24000, ge=8000, le=48000)
