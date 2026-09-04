"""JSON-based storage for user settings (council composition, chairman).

Settings live in ``data/settings.json``. The file stores ONLY overrides
relative to the config defaults (COUNCIL_MODELS / CHAIRMAN_MODEL): keys
whose effective value matches the config are omitted. A missing key (or a
missing file) therefore means "use the config default". The file is created
with empty overrides on first access.
Models are stored as combined identifiers ("provider/model_name").
"""

import json
import os
from typing import Any, Dict, List, Optional, Tuple

from .client import model_id
from .config import CHAIRMAN_MODEL, COUNCIL_MODELS, SETTINGS_FILE

ModelKey = Tuple[str, str]  # (provider, model_name)


def model_id_to_key(identifier: str) -> ModelKey:
    """Split "provider/model_name" into a tuple. No prefix -> ("", name)."""
    if "/" in identifier:
        provider, model_name = identifier.split("/", 1)
        return provider, model_name
    return "", identifier


def default_settings() -> Dict[str, Any]:
    """Settings derived from the hardcoded config defaults."""
    return {
        "council_models": [model_id(p, m) for p, m in COUNCIL_MODELS],
        "chairman_model": model_id(*CHAIRMAN_MODEL),
    }


def _ensure_settings_file() -> None:
    """Create the settings file with empty overrides if it does not exist."""
    if os.path.exists(SETTINGS_FILE):
        return
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump({}, f, indent=2)
    except OSError as e:
        # Read-only fs etc. - defaults will be used, no crash.
        print(f"Could not create settings file: {e}")


def get_settings() -> Dict[str, Any]:
    """
    Load effective settings: overrides from file merged over config defaults.

    Returns:
        Dict with 'council_models' (list of model ids) and 'chairman_model'.
    """
    defaults = default_settings()
    _ensure_settings_file()

    if not os.path.exists(SETTINGS_FILE):
        return defaults

    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return defaults

    council = data.get("council_models")
    chairman = data.get("chairman_model")

    return {
        "council_models": council if _valid_model_list(council) else defaults["council_models"],
        "chairman_model": chairman if isinstance(chairman, str) and chairman.strip() else defaults["chairman_model"],
    }


def save_settings(council_models: List[str], chairman_model: str) -> Dict[str, Any]:
    """
    Validate and persist user settings.

    Only overrides relative to the config defaults are written to the file;
    values equal to the defaults are omitted.

    Returns:
        The effective settings (defaults + overrides).

    Raises:
        ValueError: if the payload is invalid.
    """
    council_models = [m.strip() for m in council_models if isinstance(m, str) and m.strip()]
    # Preserve order, drop duplicates
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

    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(overrides, f, indent=2, ensure_ascii=False)

    return {**defaults, **overrides}


def get_effective_models() -> Tuple[List[ModelKey], ModelKey]:
    """
    Resolve the models to use right now (settings override config defaults).

    Returns:
        Tuple of (council model keys, chairman model key).
    """
    settings = get_settings()
    council = [model_id_to_key(m) for m in settings["council_models"]]
    chairman = model_id_to_key(settings["chairman_model"])
    return council, chairman


def _valid_model_list(value: Any) -> bool:
    return isinstance(value, list) and any(isinstance(m, str) and m.strip() for m in value)
