import os
from dotenv import load_dotenv

load_dotenv()

OPENAI_COMPATIBLE_URL = os.getenv(
    "OPENAI_COMPATIBLE_URL", "http://0.0.0.0:8001/v1"
)
OPENAI_COMPATIBLE_KEY = os.getenv("OPENAI_COMPATIBLE_KEY")

COUNCIL_MODELS = [
    ("moonshot", "kimi-k3"),
    ("alibaba", "deepseek-v4-pro"),
    ("alibaba", "qwen3.8-max"),
    ("alibaba", "glm-5.2"),
    ("x-ai", "grok-4.6"),
]

CHAIRMAN_MODEL = ("moonshot", "kimi-k3")
TITLE_MODEL = ("alibaba", "deepseek-v4-flash")

CHAT_COMPLETIONS_URL = OPENAI_COMPATIBLE_URL.rstrip("/") + "/chat/completions"

USERS_FILE = "data/users.json"
USER_DATA_ROOT = "data/users"
JWT_SECRET_FILE = "data/.jwt_secret"
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = 60 * 24 * 7

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
