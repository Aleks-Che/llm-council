import os
import shutil

from .config import USER_DATA_ROOT

LEGACY_CONVERSATIONS_DIR = "data/conversations"
LEGACY_SETTINGS_FILE = "data/settings.json"
MIGRATION_MARKER = "data/.migrated"


def migrate_if_needed(target_user_id: str) -> bool:
    if os.path.exists(MIGRATION_MARKER):
        return False
    has_legacy = False
    if os.path.isdir(LEGACY_CONVERSATIONS_DIR):
        for name in os.listdir(LEGACY_CONVERSATIONS_DIR):
            if name.endswith(".json"):
                has_legacy = True
                break
    if not has_legacy and os.path.exists(LEGACY_SETTINGS_FILE):
        has_legacy = True
    if not has_legacy:
        _write_marker()
        return False

    target_conv_dir = os.path.join(USER_DATA_ROOT, target_user_id, "conversations")
    if os.path.isdir(LEGACY_CONVERSATIONS_DIR):
        os.makedirs(target_conv_dir, exist_ok=True)
        for name in os.listdir(LEGACY_CONVERSATIONS_DIR):
            if not name.endswith(".json"):
                continue
            src = os.path.join(LEGACY_CONVERSATIONS_DIR, name)
            dst = os.path.join(target_conv_dir, name)
            shutil.move(src, dst)
        try:
            os.rmdir(LEGACY_CONVERSATIONS_DIR)
        except OSError:
            pass

    if os.path.exists(LEGACY_SETTINGS_FILE):
        target_settings = os.path.join(USER_DATA_ROOT, target_user_id, "settings.json")
        os.makedirs(os.path.dirname(target_settings), exist_ok=True)
        shutil.move(LEGACY_SETTINGS_FILE, target_settings)

    _write_marker()
    print(f"Миграция: данные перенесены пользователю {target_user_id}")
    return True


def _write_marker() -> None:
    os.makedirs(os.path.dirname(MIGRATION_MARKER), exist_ok=True)
    with open(MIGRATION_MARKER, "w", encoding="utf-8") as f:
        f.write("migrated\n")
