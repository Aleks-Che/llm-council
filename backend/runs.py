"""Фоновые запуски Совета.

Оркестрация трёх этапов живёт на сервере и не зависит от соединения с
фронтендом: запуск выполняется как фоновая asyncio-задача, а прогресс
сохраняется в storage после каждого этапа. Фронтенд может перезагружаться
и переподключаться — данные не теряются.
"""

import asyncio
import time
from typing import Any, Dict, Set

from . import storage
from .council import (
    calculate_aggregate_rankings,
    generate_conversation_title,
    stage1_collect_responses,
    stage2_collect_rankings,
    stage3_synthesize_final,
)

# conversation_id -> {"task": asyncio.Task, "started_at": float}
ACTIVE_RUNS: Dict[str, Dict[str, Any]] = {}


def is_running(conversation_id: str) -> bool:
    """True, если по диалогу сейчас выполняется запуск Совета."""
    return conversation_id in ACTIVE_RUNS


def running_ids() -> Set[str]:
    """Идентификаторы диалогов с активными запусками."""
    return set(ACTIVE_RUNS)


def start(conversation_id: str, user_query: str, is_first_message: bool) -> bool:
    """
    Запустить фоновый прогон Совета для диалога.

    Предполагается, что пользовательское сообщение и placeholder ответа
    ассистента уже добавлены в storage.

    Returns:
        False, если запуск для этого диалога уже активен.
    """
    if conversation_id in ACTIVE_RUNS:
        return False
    task = asyncio.create_task(_run(conversation_id, user_query, is_first_message))
    ACTIVE_RUNS[conversation_id] = {"task": task, "started_at": time.time()}
    return True


def cancel(conversation_id: str) -> None:
    """Отменить активный запуск (например, при удалении диалога)."""
    run = ACTIVE_RUNS.get(conversation_id)
    if run is not None:
        run["task"].cancel()


async def _run(conversation_id: str, user_query: str, is_first_message: bool) -> None:
    try:
        # Генерацию заголовка запускаем параллельно с Советом
        title_task = None
        if is_first_message:
            title_task = asyncio.create_task(generate_conversation_title(user_query))

        storage.update_last_assistant_message(conversation_id, current_stage="stage1")
        stage1_results = await stage1_collect_responses(user_query)

        if not stage1_results:
            storage.update_last_assistant_message(
                conversation_id,
                status="error",
                current_stage=None,
                error="Все модели не смогли ответить. Попробуйте ещё раз в новом диалоге.",
            )
            return

        storage.update_last_assistant_message(
            conversation_id, stage1=stage1_results, current_stage="stage2"
        )

        stage2_results, label_to_model = await stage2_collect_rankings(
            user_query, stage1_results
        )
        metadata = {
            "label_to_model": label_to_model,
            "aggregate_rankings": calculate_aggregate_rankings(stage2_results, label_to_model),
        }
        storage.update_last_assistant_message(
            conversation_id,
            stage2=stage2_results,
            metadata=metadata,
            current_stage="stage3",
        )

        stage3_result = await stage3_synthesize_final(
            user_query, stage1_results, stage2_results
        )
        storage.update_last_assistant_message(
            conversation_id, stage3=stage3_result, status="complete", current_stage=None
        )

        if title_task is not None:
            title = await title_task
            storage.update_conversation_title(conversation_id, title)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"Council run failed for conversation {conversation_id}: {e}")
        try:
            storage.update_last_assistant_message(
                conversation_id,
                status="error",
                current_stage=None,
                error=str(e),
            )
        except Exception:
            pass
    finally:
        ACTIVE_RUNS.pop(conversation_id, None)
