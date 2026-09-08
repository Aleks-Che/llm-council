import asyncio
import time
from typing import Any, Dict, List, Set

from . import settings_store, storage
from .client import ModelKey, model_id, model_label, use_model_connections
from .research import run_research, resolve_citations, build_context
from .search_config import SearchSettings
from .council import (
    calculate_aggregate_rankings,
    generate_conversation_title,
    stage1_collect_responses,
    stage2_collect_rankings,
    stage3_synthesize_final,
)

ACTIVE_RUNS: Dict[str, Dict[str, Any]] = {}
RETRYABLE_STATUSES = {"error", "interrupted", "cancelled"}


def is_running(conversation_id: str) -> bool:
    return conversation_id in ACTIVE_RUNS


def running_ids() -> Set[str]:
    return set(ACTIVE_RUNS)


def start(user_id: str, conversation_id: str, user_query: str, is_first_message: bool,
          search_enabled: bool = False, *, resume: dict = None) -> bool:
    if conversation_id in ACTIVE_RUNS:
        return False
    settings = settings_store.get_settings(user_id)
    config = (resume or {}).get("run_config") or {
        "council_models": settings["council_models"],
        "chairman_model": settings["chairman_model"],
        "search": settings["search"],
        "search_enabled": search_enabled,
    }
    council_models = [settings_store.model_id_to_key(m) for m in config["council_models"]]
    chairman_model = settings_store.model_id_to_key(config["chairman_model"])
    search_settings = SearchSettings.model_validate(config["search"]) if config["search_enabled"] else None
    search_key = settings_store.get_search_api_key(user_id) if search_settings else ""
    completed = completed_stages(resume or {})
    stage = next_stage(completed, config["search_enabled"])
    # Connections are inherited only by this task. Credentials never enter a conversation.
    with use_model_connections(settings_store.get_model_connections(user_id)):
        storage.update_last_assistant_message(user_id, conversation_id,
            status="running", current_stage=stage, failed_stage=None, error=None,
            run_config=config, completed_stages=completed,
            model_labels={m: model_label(m) for m in config["council_models"] + [config["chairman_model"]]})
        task = asyncio.create_task(
            _run(user_id, conversation_id, user_query, is_first_message, council_models, chairman_model,
                 search_settings, search_key, resume=resume, completed=completed)
        )
    ACTIVE_RUNS[conversation_id] = {"task": task, "started_at": time.time(), "user_id": user_id}
    return True


def completed_stages(message: dict) -> list:
    if "completed_stages" in message:
        return list(message["completed_stages"])
    # Older versions saved only entire council stages.
    completed = [stage for stage in ("stage1", "stage2", "stage3") if message.get(stage) is not None]
    research = message.get("research") or {}
    if research.get("status") in {"complete", "partial", "failed"} or completed:
        completed.insert(0, "research")
    return completed


def next_stage(completed: list, search_enabled: bool) -> str:
    return next((stage for stage in (["research"] if search_enabled else []) + ["stage1", "stage2", "stage3"]
                 if stage not in completed), "stage3")


def retry(user_id: str, conversation_id: str) -> bool:
    if is_running(conversation_id):
        return False
    conversation = storage.get_conversation(user_id, conversation_id)
    messages = (conversation or {}).get("messages", [])
    if (len(messages) < 2 or messages[-1].get("role") != "assistant"
            or messages[-1].get("status") not in RETRYABLE_STATUSES
            or messages[-2].get("role") != "user"):
        raise ValueError("Нет незавершённого запуска для повтора")
    question, message = messages[-2], messages[-1]
    return start(user_id, conversation_id, question["content"],
                 conversation.get("title") == "Новый диалог",
                 question.get("search_enabled", bool(message.get("research"))), resume=message)


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
    *, resume: dict = None, completed: list = None,
) -> None:
    title_task = None
    completed = list(completed or [])
    resume = resume or {}
    stage = next_stage(completed, search_settings is not None)

    def save(**fields):
        storage.update_last_assistant_message(user_id, conversation_id, **fields)

    async def save_title():
        try:
            title = await generate_conversation_title(user_query)
            conversation = storage.get_conversation(user_id, conversation_id)
            if conversation and conversation.get("title") == "Новый диалог":
                storage.update_conversation_title(user_id, conversation_id, title)
        except Exception:
            pass  # A cosmetic title failure must not invalidate a completed answer.

    try:
        if is_first_message:
            title_task = asyncio.create_task(save_title())

        research, research_context = resume.get("research"), ""
        if search_settings is not None:
            if "research" not in completed:
                stage = "research"
                save(current_stage=stage)

                def progress(state, documents):
                    if storage.get_conversation(user_id, conversation_id) is None:
                        return
                    if documents:
                        storage.save_research_documents(user_id, conversation_id, state["id"], documents)
                    save(research=state)

                research, research_context = await run_research(user_query, search_settings, search_key, progress)
                completed.append("research")
                save(research=research, completed_stages=completed)
            elif research:
                research_context = build_context(research, search_settings.context_chars)

        stage1_results = list(resume.get("stage1") or [])
        stage2_results = list(resume.get("stage2") or [])
        model_errors = {}

        def failed(model, error):
            model_errors[model] = error

        def collector(stage_name, results, field):
            def received(result):
                result = dict(result)
                if research:
                    result[field] = resolve_citations(result[field], research)
                results[:] = [r for r in results if r["model"] != result["model"]] + [result]
                save(**{stage_name: results})
            return received

        def pending_models(results):
            successful = {r["model"] for r in results}
            return [m for m in council_models if model_id(*m) not in successful]

        def finish_stage(stage_name, results):
            missing = pending_models(results)
            if missing:
                names = ", ".join(model_label(model_id(*m)) for m in missing)
                details = "\n".join(f"{model_label(model_id(*m))}: {model_errors[model_id(*m)]}"
                                    for m in missing if model_id(*m) in model_errors)
                summary = f"Не ответили модели: {names}. Нажмите «Повторить», чтобы запросить их снова."
                raise RuntimeError(summary + ("\n" + details if details else ""))
            order = {model_id(*m): i for i, m in enumerate(council_models)}
            results.sort(key=lambda r: order.get(r["model"], len(order)))
            completed.append(stage_name)
            save(**{stage_name: results}, completed_stages=completed)

        if "stage1" not in completed:
            stage = "stage1"
            save(current_stage=stage)
            received = collector(stage, stage1_results, "response")
            results = await stage1_collect_responses(user_query, pending_models(stage1_results), research_context,
                                                     on_result=received, on_error=failed)
            for result in results:
                received(result)
            finish_stage(stage, stage1_results)

        if "stage2" not in completed:
            stage = "stage2"
            model_errors.clear()
            save(current_stage=stage, metadata={
                "label_to_model": {f"Response {chr(65 + i)}": r["model"] for i, r in enumerate(stage1_results)},
                "aggregate_rankings": [],
            })
            received = collector(stage, stage2_results, "ranking")
            results, label_to_model = await stage2_collect_rankings(
                user_query, stage1_results, pending_models(stage2_results), research_context,
                on_result=received, on_error=failed)
            for result in results:
                received(result)
            save(metadata={"label_to_model": label_to_model,
                           "aggregate_rankings": calculate_aggregate_rankings(stage2_results, label_to_model)})
            finish_stage(stage, stage2_results)

        if "stage3" not in completed:
            stage = "stage3"
            save(current_stage=stage)
            result = await stage3_synthesize_final(
                user_query, stage1_results, stage2_results, chairman_model, research_context)
            if research:
                result["response"] = resolve_citations(result["response"], research)
            completed.append(stage)
            save(stage3=result, completed_stages=completed)
        save(status="complete", current_stage=None, failed_stage=None, error=None)
    except asyncio.CancelledError:
        if storage.get_conversation(user_id, conversation_id) is not None:
            save(status="cancelled", current_stage=None, failed_stage=stage)
        raise
    except Exception as exc:
        print(f"Council run failed for conversation {conversation_id}: {type(exc).__name__}")
        if storage.get_conversation(user_id, conversation_id) is not None:
            save(status="error", current_stage=None, failed_stage=stage, error=str(exc))
    finally:
        if title_task is not None:
            if not title_task.done():
                title_task.cancel()
            await asyncio.gather(title_task, return_exceptions=True)
        ACTIVE_RUNS.pop(conversation_id, None)
