import asyncio
import time
from typing import Any, Dict, List, Set

from . import settings_store, storage
from .client import ModelKey
from .research import run_research, resolve_citations
from .search_config import SearchSettings
from .council import (
    calculate_aggregate_rankings,
    generate_conversation_title,
    stage1_collect_responses,
    stage2_collect_rankings,
    stage3_synthesize_final,
)

ACTIVE_RUNS: Dict[str, Dict[str, Any]] = {}


def is_running(conversation_id: str) -> bool:
    return conversation_id in ACTIVE_RUNS


def running_ids() -> Set[str]:
    return set(ACTIVE_RUNS)


def start(user_id: str, conversation_id: str, user_query: str, is_first_message: bool,
          search_enabled: bool = False) -> bool:
    if conversation_id in ACTIVE_RUNS:
        return False
    settings = settings_store.get_settings(user_id)
    council_models = [settings_store.model_id_to_key(m) for m in settings["council_models"]]
    chairman_model = settings_store.model_id_to_key(settings["chairman_model"])
    search_settings = SearchSettings.model_validate(settings["search"]) if search_enabled else None
    search_key = settings_store.get_search_api_key(user_id) if search_enabled else ""
    task = asyncio.create_task(
        _run(user_id, conversation_id, user_query, is_first_message, council_models, chairman_model,
             search_settings, search_key)
    )
    ACTIVE_RUNS[conversation_id] = {
        "task": task,
        "started_at": time.time(),
        "user_id": user_id,
    }
    return True


def cancel(conversation_id: str) -> None:
    run = ACTIVE_RUNS.get(conversation_id)
    if run is not None:
        run["task"].cancel()


async def _run(
    user_id: str,
    conversation_id: str,
    user_query: str,
    is_first_message: bool,
    council_models: List[ModelKey],
    chairman_model: ModelKey,
    search_settings: SearchSettings = None,
    search_key: str = "",
) -> None:
    title_task = None
    try:
        if is_first_message:
            title_task = asyncio.create_task(generate_conversation_title(user_query))

        research, research_context = None, ""
        if search_settings is not None:
            def progress(state, documents):
                # Deleting a conversation must never recreate it or its documents.
                if storage.get_conversation(user_id, conversation_id) is None:
                    return
                if documents:
                    storage.save_research_documents(user_id, conversation_id, state["id"], documents)
                storage.update_last_assistant_message(user_id, conversation_id, research=state)

            research, research_context = await run_research(user_query, search_settings, search_key, progress)

        storage.update_last_assistant_message(user_id, conversation_id, current_stage="stage1")
        stage1_results = await stage1_collect_responses(user_query, council_models, research_context)
        if research:
            for result in stage1_results:
                result["response"] = resolve_citations(result["response"], research)

        if not stage1_results:
            storage.update_last_assistant_message(
                user_id,
                conversation_id,
                status="error",
                current_stage=None,
                error="Все модели не смогли ответить. Попробуйте ещё раз в новом диалоге.",
            )
            return

        storage.update_last_assistant_message(
            user_id, conversation_id, stage1=stage1_results, current_stage="stage2"
        )

        stage2_results, label_to_model = await stage2_collect_rankings(
            user_query, stage1_results, council_models, research_context
        )
        if research:
            for result in stage2_results:
                result["ranking"] = resolve_citations(result["ranking"], research)
        metadata = {
            "label_to_model": label_to_model,
            "aggregate_rankings": calculate_aggregate_rankings(stage2_results, label_to_model),
        }
        storage.update_last_assistant_message(
            user_id,
            conversation_id,
            stage2=stage2_results,
            metadata=metadata,
            current_stage="stage3",
        )

        stage3_result = await stage3_synthesize_final(
            user_query, stage1_results, stage2_results, chairman_model, research_context
        )
        if research:
            stage3_result["response"] = resolve_citations(stage3_result["response"], research)
        storage.update_last_assistant_message(
            user_id, conversation_id, stage3=stage3_result, status="complete", current_stage=None
        )

        if title_task is not None:
            title = await title_task
            storage.update_conversation_title(user_id, conversation_id, title)
    except asyncio.CancelledError:
        if storage.get_conversation(user_id, conversation_id) is not None:
            storage.update_last_assistant_message(user_id, conversation_id, status="cancelled", current_stage=None)
        raise
    except Exception as e:
        print(f"Council run failed for conversation {conversation_id}: {e}")
        try:
            storage.update_last_assistant_message(
                user_id,
                conversation_id,
                status="error",
                current_stage=None,
                error=str(e),
            )
        except Exception:
            pass
    finally:
        if title_task is not None:
            if not title_task.done():
                title_task.cancel()
            await asyncio.gather(title_task, return_exceptions=True)
        ACTIVE_RUNS.pop(conversation_id, None)
