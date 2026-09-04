"""Configuration for the LLM Council."""

import os
from dotenv import load_dotenv

load_dotenv()

# OpenAI-compatible proxy (e.g. LiteLLM). Replaces the previous OpenRouter integration.
OPENAI_COMPATIBLE_URL = os.getenv(
    "OPENAI_COMPATIBLE_URL", "http://localhost:8001/v1"
)
# Optional. Many local proxies do not require auth; header is omitted when unset.
OPENAI_COMPATIBLE_KEY = os.getenv("OPENAI_COMPATIBLE_KEY")

# Council members - list of (provider, model_name) tuples.
COUNCIL_MODELS = [
    ("moonshot", "kimi-k3"),
    ("alibaba", "deepseek-v4-pro"),
    ("alibaba", "qwen3.8-max"),
    ("alibaba", "glm-5.2"),
    ("x-ai", "grok-4.6"),
]

# Chairman model - synthesizes final response.
CHAIRMAN_MODEL = ("moonshot", "kimi-k3")

# Convenience for title generation - small/fast model exposed by the proxy.
TITLE_MODEL = ("alibaba", "deepseek-v4-flash")

# Chat completions endpoint derived from the base URL.
CHAT_COMPLETIONS_URL = OPENAI_COMPATIBLE_URL.rstrip("/") + "/chat/completions"

# Data directory for conversation storage
DATA_DIR = "data/conversations"

# User settings file (council composition + chairman overrides)
SETTINGS_FILE = "data/settings.json"