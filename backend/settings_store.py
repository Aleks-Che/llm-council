import json
import os
from typing import Any, Dict, List, Tuple

from .client import model_id
from .config import CHAIRMAN_MODEL, COUNCIL_MODELS, USER_DATA_ROOT

ModelKey = Tuple[str, str]


def model_id_to_key(identifier: str) -> ModelKey:
    if "/" in identifier:
        provider, model_name = identifier.split("/", 1)
        return provider, model_name
    return "", identifier


def default_settings() -> Dict[str, Any]:
    return {
        "council_models": [model_id(p, m) for p, m in COUNCIL_MODELS],
        "chairman_model": model_id(*CHAIRMAN_MODEL),
    }


def settings_path(user_id: str) -> str:
    return os.path.join(USER_DATA_ROOT, user_id, "settings.json")


def _ensure_user_dir(user_id: str) -> None:
    os.makedirs(os.path.dirname(settings_path(user_id)), exist_ok=True)


def get_settings(user_id: str) -> Dict[str, Any]:
    defaults = default_settings()
    _ensure_user_dir(user_id)
    path = settings_path(user_id)
    if not os.path.exists(path):
        return defaults
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return defaults
    council = data.get("council_models")
    chairman = data.get("chairman_model")
    return {
        "council_models": council if _valid_model_list(council) else defaults["council_models"],
        "chairman_model": chairman if isinstance(chairman, str) and chairman.strip() else defaults["chairman_model"],
    }


def save_settings(user_id: str, council_models: List[str], chairman_model: str) -> Dict[str, Any]:
    council_models = [m.strip() for m in council_models if isinstance(m, str) and m.strip()]
    council_models = list(dict.fromkeys(council_models))
    if not council_models:
        raise ValueError("Совет должен содержать хотя бы одну модель")
    if not isinstance(chairman_model, str) or not chairman_model.strip():
        raise ValueError("Не выбрана модель Председателя")
    chairman_model = chairman_model.strip()
    defaults = default_settings()
    overrides: Dict[str, Any] = {}
    if council_models != defaults["council_models"]:
        overrides["council_models"] = council_models
    if chairman_model != defaults["chairman_model"]:
        overrides["chairman_model"] = chairman_model
    _ensure_user_dir(user_id)
    path = settings_path(user_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(overrides, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
    return {**defaults, **overrides}


def get_effective_models(user_id: str) -> Tuple[List[ModelKey], ModelKey]:
    settings = get_settings(user_id)
    council = [model_id_to_key(m) for m in settings["council_models"]]
    chairman = model_id_to_key(settings["chairman_model"])
    return council, chairman


def _valid_model_list(value: Any) -> bool:
    return isinstance(value, list) and any(isinstance(m, str) and m.strip() for m in value)
