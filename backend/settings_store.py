import json
import os
from typing import Any, Dict, List, Tuple

from .client import model_id
from .config import CHAIRMAN_MODEL, COUNCIL_MODELS, USER_DATA_ROOT, TAVILY_API_KEY
from .search_config import SearchSettings
from .model_config import CustomModel

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
        "search": SearchSettings().model_dump(),
    }


def settings_path(user_id: str) -> str:
    return os.path.join(USER_DATA_ROOT, user_id, "settings.json")


def _ensure_user_dir(user_id: str) -> None:
    os.makedirs(os.path.dirname(settings_path(user_id)), exist_ok=True)


def _read_data(user_id: str) -> Dict[str, Any]:
    path = settings_path(user_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def get_search_api_key(user_id: str) -> str:
    key = _read_data(user_id).get("tavily_api_key")
    return key.strip() if isinstance(key, str) and key.strip() else TAVILY_API_KEY


def search_key_status(user_id: str) -> Dict[str, Any]:
    personal = bool(_read_data(user_id).get("tavily_api_key"))
    return {"configured": personal or bool(TAVILY_API_KEY), "personal": personal}


def get_model_connections(user_id: str) -> Dict[str, dict]:
    return {m["id"]: m for m in _read_data(user_id).get("custom_models", [])}


def public_custom_models(user_id: str) -> List[dict]:
    return [{k: v for k, v in model.items() if k != "api_key"} |
            {"key_configured": bool(model.get("api_key"))}
            for model in get_model_connections(user_id).values()]


def resolve_custom_models(user_id: str, models: List[CustomModel]) -> Dict[str, dict]:
    previous = get_model_connections(user_id)
    resolved = {}
    for model in models:
        if model.id in resolved:
            raise ValueError("Повторяющийся идентификатор пользовательской модели")
        data = model.model_dump()
        old = previous.get(model.id, {})
        # Never forward a saved credential to an edited endpoint.
        if not data["api_key"] and old.get("url") == data["url"]:
            data["api_key"] = old.get("api_key", "")
        resolved[model.id] = data
    return resolved


def get_settings(user_id: str) -> Dict[str, Any]:
    defaults = default_settings()
    data = _read_data(user_id)
    council = data.get("council_models")
    chairman = data.get("chairman_model")
    try:
        search = SearchSettings.model_validate(data.get("search", {})).model_dump()
    except ValueError:
        search = defaults["search"]
    return {
        "council_models": council if _valid_model_list(council) else defaults["council_models"],
        "chairman_model": chairman if isinstance(chairman, str) and chairman.strip() else defaults["chairman_model"],
        "search": search,
        "custom_models": public_custom_models(user_id),
    }


def save_settings(
    user_id: str, council_models: List[str], chairman_model: str,
    search: SearchSettings = None, tavily_api_key: str = None,
    remove_tavily_key: bool = False,
    custom_models: List[CustomModel] = None,
) -> Dict[str, Any]:
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
    previous = _read_data(user_id)
    connections = (resolve_custom_models(user_id, custom_models) if custom_models is not None
                   else get_model_connections(user_id))
    selected = council_models + [chairman_model, (search.model if search else get_settings(user_id)["search"]["model"])]
    if any(m.startswith("custom/") and m not in connections for m in selected):
        raise ValueError("Выбранная пользовательская модель не найдена")
    if connections:
        overrides["custom_models"] = list(connections.values())
    overrides["search"] = search.model_dump() if search is not None else get_settings(user_id)["search"]
    key = previous.get("tavily_api_key", "")
    if remove_tavily_key:
        key = ""
    if tavily_api_key is not None and tavily_api_key.strip():
        key = tavily_api_key.strip()
    if key:
        overrides["tavily_api_key"] = key
    _ensure_user_dir(user_id)
    path = settings_path(user_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(overrides, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
    return get_settings(user_id)


def get_effective_models(user_id: str) -> Tuple[List[ModelKey], ModelKey]:
    settings = get_settings(user_id)
    council = [model_id_to_key(m) for m in settings["council_models"]]
    chairman = model_id_to_key(settings["chairman_model"])
    return council, chairman


def _valid_model_list(value: Any) -> bool:
    return isinstance(value, list) and any(isinstance(m, str) and m.strip() for m in value)
