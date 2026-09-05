"""3-stage LLM Council orchestration."""

from typing import List, Dict, Any, Optional, Tuple
from .client import query_models_parallel, query_model, model_id, ModelKey
from .config import COUNCIL_MODELS, CHAIRMAN_MODEL, TITLE_MODEL
from . import settings_store


async def stage1_collect_responses(
    user_query: str,
    council_models: Optional[List[ModelKey]] = None,
) -> List[Dict[str, Any]]:
    """
    Stage 1: Collect individual responses from all council models.

    Args:
        user_query: The user's question
        council_models: Models to query. When None, resolved from user
            settings (falling back to config defaults).

    Returns:
        List of dicts with 'model' and 'response' keys
    """
    if council_models is None:
        council_models, _ = settings_store.get_effective_models()

    messages = [{"role": "user", "content": user_query}]

    # Query all models in parallel
    responses = await query_models_parallel(council_models, messages)

    # Format results
    stage1_results = []
    for model, response in responses.items():
        if response is not None:  # Only include successful responses
            stage1_results.append({
                "model": model,
                "response": response.get('content', '')
            })

    return stage1_results


async def stage2_collect_rankings(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    council_models: Optional[List[ModelKey]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Stage 2: Each model ranks the anonymized responses.

    Args:
        user_query: The original user query
        stage1_results: Results from Stage 1
        council_models: Models that produce rankings. When None, resolved
            from user settings (falling back to config defaults).

    Returns:
        Tuple of (rankings list, label_to_model mapping)
    """
    if council_models is None:
        council_models, _ = settings_store.get_effective_models()
    # Create anonymized labels for responses (Response A, Response B, etc.)
    labels = [chr(65 + i) for i in range(len(stage1_results))]  # A, B, C, ...

    # Create mapping from label to model name
    label_to_model = {
        f"Response {label}": result['model']
        for label, result in zip(labels, stage1_results)
    }

    # Build the ranking prompt
    responses_text = "\n\n".join([
        f"Response {label}:\n{result['response']}"
        for label, result in zip(labels, stage1_results)
    ])

    ranking_prompt = f"""Ты оцениваешь различные ответы на следующий вопрос:

Вопрос: {user_query}

Вот ответы разных моделей (анонимизированные):

{responses_text}

Твоя задача:
1. Сначала оцени каждый ответ по отдельности. Для каждого ответа объясни, что в нём сделано хорошо, а что плохо.
2. Затем, в самом конце своего ответа, приведи итоговый рейтинг.

ВАЖНО: Твой итоговый рейтинг ДОЛЖЕН быть отформатирован ТОЧНО следующим образом:
- Начни со строки "FINAL RANKING:" (именно так, заглавными буквами, с двоеточием)
- Затем перечисли ответы от лучшего к худшему в виде нумерованного списка
- Каждая строка должна содержать: номер, точку, пробел, затем ТОЛЬКО метку ответа (например, "1. Response A")
- Не добавляй никакого другого текста или пояснений в разделе рейтинга

Пример правильного формата ВСЕГО твоего ответа:

Response A хорошо раскрывает X, но упускает Y...
Response B точен, но ему не хватает глубины в Z...
Response C даёт наиболее полный ответ...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Теперь приведи свою оценку и рейтинг:"""

    messages = [{"role": "user", "content": ranking_prompt}]

    # Get rankings from all council models in parallel
    responses = await query_models_parallel(council_models, messages)

    # Format results
    stage2_results = []
    for model, response in responses.items():
        if response is not None:
            full_text = response.get('content', '')
            parsed = parse_ranking_from_text(full_text)
            stage2_results.append({
                "model": model,
                "ranking": full_text,
                "parsed_ranking": parsed
            })

    return stage2_results, label_to_model


async def stage3_synthesize_final(
    user_query: str,
    stage1_results: List[Dict[str, Any]],
    stage2_results: List[Dict[str, Any]],
    chairman_model: Optional[ModelKey] = None,
) -> Dict[str, Any]:
    """
    Stage 3: Chairman synthesizes final response.

    Args:
        user_query: The original user query
        stage1_results: Individual model responses from Stage 1
        stage2_results: Rankings from Stage 2
        chairman_model: Model that synthesizes the answer. When None,
            resolved from user settings (falling back to config defaults).

    Returns:
        Dict with 'model' and 'response' keys
    """
    if chairman_model is None:
        _, chairman_model = settings_store.get_effective_models()
    # Build comprehensive context for chairman
    stage1_text = "\n\n".join([
        f"Модель: {result['model']}\nОтвет: {result['response']}"
        for result in stage1_results
    ])

    stage2_text = "\n\n".join([
        f"Модель: {result['model']}\nОценка: {result['ranking']}"
        for result in stage2_results
    ])

    chairman_prompt = f"""Ты — Председатель Совета LLM. Несколько ИИ-моделей дали ответы на вопрос пользователя, а затем оценили ответы друг друга.

Исходный вопрос: {user_query}

ЭТАП 1 — Индивидуальные ответы:
{stage1_text}

ЭТАП 2 — Взаимные оценки:
{stage2_text}

Твоя задача как Председателя — синтезировать всю эту информацию в единый, исчерпывающий и точный ответ на исходный вопрос пользователя. Учитывай:
- Индивидуальные ответы и содержащиеся в них идеи
- Взаимные оценки и то, что они говорят о качестве ответов
- Любые закономерности согласия или разногласий

Дай чёткий, обоснованный финальный ответ, отражающий коллективную мудрость совета:"""

    messages = [{"role": "user", "content": chairman_prompt}]

# Query the chairman model
    response = await query_model(*chairman_model, messages)

    chairman_id = model_id(*chairman_model)

    if response is None:
        # Fallback if chairman fails
        return {
            "model": chairman_id,
            "response": "Ошибка: не удалось сгенерировать итоговый синтез."
        }

    return {
        "model": chairman_id,
        "response": response.get('content', '')
    }


def parse_ranking_from_text(ranking_text: str) -> List[str]:
    """
    Parse the FINAL RANKING section from the model's response.

    Args:
        ranking_text: The full text response from the model

    Returns:
        List of response labels in ranked order
    """
    import re

    # Look for "FINAL RANKING:" section
    if "FINAL RANKING:" in ranking_text:
        # Extract everything after "FINAL RANKING:"
        parts = ranking_text.split("FINAL RANKING:")
        if len(parts) >= 2:
            ranking_section = parts[1]
            # Try to extract numbered list format (e.g., "1. Response A")
            # This pattern looks for: number, period, optional space, "Response X"
            numbered_matches = re.findall(r'\d+\.\s*Response [A-Z]', ranking_section)
            if numbered_matches:
                # Extract just the "Response X" part
                return [re.search(r'Response [A-Z]', m).group() for m in numbered_matches]

            # Fallback: Extract all "Response X" patterns in order
            matches = re.findall(r'Response [A-Z]', ranking_section)
            return matches

    # Fallback: try to find any "Response X" patterns in order
    matches = re.findall(r'Response [A-Z]', ranking_text)
    return matches


def calculate_aggregate_rankings(
    stage2_results: List[Dict[str, Any]],
    label_to_model: Dict[str, str]
) -> List[Dict[str, Any]]:
    """
    Calculate aggregate rankings across all models.

    Args:
        stage2_results: Rankings from each model
        label_to_model: Mapping from anonymous labels to model names

    Returns:
        List of dicts with model name and average rank, sorted best to worst
    """
    from collections import defaultdict

    # Track positions for each model
    model_positions = defaultdict(list)

    for ranking in stage2_results:
        ranking_text = ranking['ranking']

        # Parse the ranking from the structured format
        parsed_ranking = parse_ranking_from_text(ranking_text)

        for position, label in enumerate(parsed_ranking, start=1):
            if label in label_to_model:
                model_name = label_to_model[label]
                model_positions[model_name].append(position)

    # Calculate average position for each model
    aggregate = []
    for model, positions in model_positions.items():
        if positions:
            avg_rank = sum(positions) / len(positions)
            aggregate.append({
                "model": model,
                "average_rank": round(avg_rank, 2),
                "rankings_count": len(positions)
            })

    # Sort by average rank (lower is better)
    aggregate.sort(key=lambda x: x['average_rank'])

    return aggregate


async def generate_conversation_title(user_query: str) -> str:
    """
    Generate a short title for a conversation based on the first user message.

    Args:
        user_query: The first user message

    Returns:
        A short title (3-5 words)
    """
    title_prompt = f"""Составь очень короткий заголовок (максимум 3-5 слов), обобщающий следующий вопрос.
Заголовок должен быть кратким и ёмким. Не используй кавычки и знаки препинания в заголовке.

Вопрос: {user_query}

Заголовок:"""

    messages = [{"role": "user", "content": title_prompt}]

    # Title generation runs in parallel with the council; reasoning models
    # can be slow, so allow a generous timeout (fallback title otherwise).
    response = await query_model(*TITLE_MODEL, messages, timeout=180.0)

    if response is None:
        # Fallback to a generic title
        return "Новый диалог"

    title = response.get('content', 'Новый диалог').strip()

    # Clean up the title - remove quotes, limit length
    title = title.strip('"\'')

    # Truncate if too long
    if len(title) > 50:
        title = title[:47] + "..."

    return title

