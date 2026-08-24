"""Provider connectivity test for the LLM Council.

Run from the project root:

    python -m backend.test_providers
    python -m backend.test_providers --model moonshot kimi-k3
    python -m backend.test_providers --prompt "Скажи 'ок'"
    python -m backend.test_providers --no-parallel

The script exercises every model exposed via the OpenAI-compatible proxy
and produces detailed logs so failures are easy to diagnose:

* configuration snapshot (URL, key presence)
* per-model HTTP request (method, url, headers, payload)
* per-model HTTP response (status, headers, raw body)
* per-model timing, content length, reasoning_details
* per-model error type and message
* aggregate pass/fail summary
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import client
from .config import (
    CHAIRMAN_MODEL,
    CHAT_COMPLETIONS_URL,
    COUNCIL_MODELS,
    OPENAI_COMPATIBLE_KEY,
    OPENAI_COMPATIBLE_URL,
    TITLE_MODEL,
)


DEFAULT_PROMPT = "Ответь одним словом: 'готов'."
MAX_LOG_CHARS = 2000


# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #

LOG_FORMAT = "%(asctime)s.%(msecs)03d %(levelname)-5s %(name)s | %(message)s"
LOG_DATEFMT = "%H:%M:%S"


class _Formatter(logging.Formatter):
    """ASCII-only formatter with a leading level tag.

    Uses plain ASCII so the output is safe on Windows cp1251 consoles and in
    any captured CI/log pipeline. Colors are added only when the destination
    is an interactive TTY that we know supports UTF-8 / ANSI.
    """

    _LEVEL_TAGS = {
        logging.DEBUG: "[DBG]",
        logging.INFO: "[INF]",
        logging.WARNING: "[WRN]",
        logging.ERROR: "[ERR]",
        logging.CRITICAL: "[CRT]",
    }

    _COLORS = {
        logging.DEBUG: "\033[90m",     # gray
        logging.INFO: "\033[36m",      # cyan
        logging.WARNING: "\033[33m",   # yellow
        logging.ERROR: "\033[31m",     # red
        logging.CRITICAL: "\033[1;31m",
    }
    _RESET = "\033[0m"

    def __init__(self, fmt: str, datefmt: str, use_color: bool) -> None:
        super().__init__(fmt=fmt, datefmt=datefmt)
        self._use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        tag = self._LEVEL_TAGS.get(record.levelno, "[???]")
        msg = super().format(record)
        if self._use_color:
            color = self._COLORS.get(record.levelno, "")
            return f"{color}{tag} {msg}{self._RESET}"
        return f"{tag} {msg}"


def _stdout_supports_utf8() -> bool:
    """Best-effort detection: can the active stdout safely emit ASCII+UTF-8?"""

    encoding = getattr(sys.stdout, "encoding", None) or ""
    return encoding.lower().replace("-", "") in {"utf8", "utf16"}


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("test_providers")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(
        _Formatter(LOG_FORMAT, LOG_DATEFMT, use_color=_stdout_supports_utf8())
    )
    logger.addHandler(handler)
    logger.propagate = False
    return logger


log = _build_logger()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _truncate(text: str, limit: int = MAX_LOG_CHARS) -> str:
    if text is None:
        return "<None>"
    if len(text) <= limit:
        return text
    return f"{text[:limit]}... [+{len(text) - limit} chars truncated]"


def _format_json(payload: Any) -> str:
    try:
        return json.dumps(payload, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return repr(payload)


def _mask_auth_headers(headers: Dict[str, str]) -> Dict[str, str]:
    masked = dict(headers)
    if "Authorization" in masked:
        masked["Authorization"] = "Bearer ***"
    return masked


@dataclass
class ModelResult:
    provider: str
    model: str
    ok: bool = False
    duration_s: float = 0.0
    status_code: Optional[int] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    content_length: Optional[int] = None
    has_reasoning: bool = False
    preview: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


@dataclass
class Summary:
    results: List[ModelResult] = field(default_factory=list)

    def passed(self) -> int:
        return sum(1 for r in self.results if r.ok)

    def failed(self) -> int:
        return sum(1 for r in self.results if not r.ok)


def _section(title: str) -> None:
    bar = "=" * 78
    log.info("\n%s\n%s\n%s", bar, title, bar)


# --------------------------------------------------------------------------- #
# Core HTTP probe with verbose logging
# --------------------------------------------------------------------------- #


async def probe_model(
    provider: str,
    model_name: str,
    prompt: str,
    timeout: float = 60.0,
) -> ModelResult:
    """Send a single chat-completion request and capture every step into a log."""

    full_id = client.model_id(provider, model_name)
    result = ModelResult(provider=provider, model=model_name)
    messages = [{"role": "user", "content": prompt}]
    payload = {"model": full_id, "messages": messages}
    headers = client._build_headers()  # noqa: SLF001 - intentional for diagnostics

    _section(f"PROBE -> {full_id}")
    log.debug("URL: %s", CHAT_COMPLETIONS_URL)
    log.debug("Headers: %s", _format_json(_mask_auth_headers(headers)))
    log.debug("Payload:\n%s", _format_json(payload))

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as http:
            response = await http.post(
                CHAT_COMPLETIONS_URL,
                headers=headers,
                json=payload,
            )
        elapsed = time.perf_counter() - started
        result.duration_s = elapsed
        result.status_code = response.status_code

        log.debug(
            "Response status: %s in %.2fs",
            response.status_code,
            elapsed,
        )
        log.debug(
            "Response headers:\n%s",
            _format_json({k: v for k, v in response.headers.items()}),
        )

        raw_text = response.text
        log.debug("Raw body (%d chars):\n%s", len(raw_text), _truncate(raw_text))

        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            result.error_type = "JSONDecodeError"
            result.error_message = str(exc)
            log.error(
                "%s/%s: invalid JSON in response (%s)",
                provider,
                model_name,
                exc,
            )
            return result

        result.raw = data

        if response.status_code >= 400:
            result.error_type = "HTTPError"
            err = data.get("error") if isinstance(data, dict) else None
            if isinstance(err, dict):
                result.error_message = err.get("message") or json.dumps(err, ensure_ascii=False)
                result.error_type = err.get("type") or "HTTPError"
            else:
                result.error_message = _truncate(raw_text, 500)
            log.error(
                "%s/%s: HTTP %s - %s: %s",
                provider,
                model_name,
                response.status_code,
                result.error_type,
                result.error_message,
            )
            return result

        # Successful response: pull content and reasoning_details.
        try:
            choice = data["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError, TypeError) as exc:
            result.error_type = type(exc).__name__
            result.error_message = f"Unexpected response shape: {exc}"
            log.error(
                "%s/%s: malformed response - %s",
                provider,
                model_name,
                exc,
            )
            return result

        content = message.get("content")
        reasoning = message.get("reasoning_details")
        result.has_reasoning = bool(reasoning)
        result.content_length = len(content) if isinstance(content, str) else 0
        result.preview = (content or "").strip().splitlines()[0][:200] if isinstance(content, str) and content.strip() else None

        log.info(
            "%s/%s: HTTP %s in %.2fs | content=%d chars | reasoning=%s",
            provider,
            model_name,
            response.status_code,
            elapsed,
            result.content_length or 0,
            "yes" if result.has_reasoning else "no",
        )
        if result.preview:
            log.info("  preview: %s", _truncate(result.preview, 200))

        if not content:
            result.error_type = "EmptyContent"
            result.error_message = "Response had empty 'content' field"
            log.warning("%s/%s: empty content", provider, model_name)
            return result

        result.ok = True
        return result

    except httpx.TimeoutException as exc:
        elapsed = time.perf_counter() - started
        result.duration_s = elapsed
        result.error_type = "Timeout"
        result.error_message = str(exc)
        log.error(
            "%s/%s: TIMEOUT after %.2fs - %s",
            provider,
            model_name,
            elapsed,
            exc,
        )
        return result
    except httpx.HTTPError as exc:
        elapsed = time.perf_counter() - started
        result.duration_s = elapsed
        result.error_type = type(exc).__name__
        result.error_message = str(exc)
        log.error(
            "%s/%s: HTTP error - %s: %s",
            provider,
            model_name,
            type(exc).__name__,
            exc,
        )
        return result
    except Exception as exc:  # noqa: BLE001 - log everything for diagnostics
        elapsed = time.perf_counter() - started
        result.duration_s = elapsed
        result.error_type = type(exc).__name__
        result.error_message = str(exc)
        log.exception(
            "%s/%s: unexpected exception (%s)",
            provider,
            model_name,
            exc,
        )
        return result


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


async def run_sequential(
    models: List[Tuple[str, str]],
    prompt: str,
) -> List[ModelResult]:
    log.info("Running %d model probe(s) sequentially", len(models))
    results: List[ModelResult] = []
    for provider, model_name in models:
        results.append(await probe_model(provider, model_name, prompt))
    return results


async def run_parallel(
    models: List[Tuple[str, str]],
    prompt: str,
) -> List[ModelResult]:
    log.info("Running %d model probe(s) in parallel", len(models))
    return await asyncio.gather(
        *(probe_model(p, m, prompt) for p, m in models),
        return_exceptions=False,
    )


def print_summary(summary: Summary) -> None:
    _section("SUMMARY")
    width = max((len(client.model_id(r.provider, r.model)) for r in summary.results), default=10)
    width = max(width, 10)
    log.info("%s  %-7s  %-8s  %-8s  %-20s  %s", "model".ljust(width), "status", "http", "time", "content", "error")
    log.info("%s  %-7s  %-8s  %-8s  %-20s  %s", "-" * width, "-------", "--------", "--------", "----------------------", "-----")
    for r in summary.results:
        full = client.model_id(r.provider, r.model)
        status = "PASS" if r.ok else "FAIL"
        http = str(r.status_code) if r.status_code is not None else "-"
        duration = f"{r.duration_s:.2f}s"
        content = (
            f"{r.content_length} chars"
            if r.content_length is not None
            else "-"
        )
        err = (
            f"{r.error_type}: {_truncate(r.error_message or '', 80)}"
            if not r.ok and r.error_type
            else ""
        )
        log.info(
            "%s  %-7s  %-8s  %-8s  %-20s  %s",
            full.ljust(width),
            status,
            http,
            duration,
            content,
            err,
        )

    passed, failed = summary.passed(), summary.failed()
    total = len(summary.results)
    log.info("Result: %d/%d passed, %d failed", passed, total, failed)
    if failed:
        log.warning("Inspect the log above for per-model failure details.")
    else:
        log.info("All probes passed.")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _parse_models_arg(values: List[str]) -> List[Tuple[str, str]]:
    """`--model provider model --model provider model ...`"""
    pairs: List[Tuple[str, str]] = []
    if len(values) % 2 != 0:
        raise SystemExit("--model requires pairs of provider model_name")
    for i in range(0, len(values), 2):
        pairs.append((values[i], values[i + 1]))
    return pairs


def _build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe every configured LLM provider with verbose logging.",
    )
    parser.add_argument(
        "--model",
        nargs=2,
        action="append",
        metavar=("PROVIDER", "MODEL"),
        help="Override the list of models to test. Repeatable.",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="User prompt sent to every model.",
    )
    parser.add_argument(
        "--parallel",
        dest="parallel",
        action="store_true",
        default=True,
        help="Run probes in parallel (default).",
    )
    parser.add_argument(
        "--no-parallel",
        dest="parallel",
        action="store_false",
        help="Run probes sequentially.",
    )
    parser.add_argument(
        "--include-chairman",
        action="store_true",
        help="Also probe the chairman model.",
    )
    parser.add_argument(
        "--include-title",
        action="store_true",
        help="Also probe the title-generation model.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="HTTP timeout per request, seconds.",
    )
    parser.add_argument(
        "--log-level",
        default="DEBUG",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logger verbosity (default DEBUG).",
    )
    return parser


def _resolve_models(args: argparse.Namespace) -> List[Tuple[str, str]]:
    if args.model:
        return _parse_models_arg([item for pair in args.model for item in pair])
    models = list(COUNCIL_MODELS)
    if args.include_chairman and CHAIRMAN_MODEL not in models:
        models.append(CHAIRMAN_MODEL)
    if args.include_title and TITLE_MODEL not in models:
        models.append(TITLE_MODEL)
    return models


def _print_config(models: List[Tuple[str, str]], prompt: str) -> None:
    _section("CONFIGURATION")
    log.info("Proxy URL       : %s", CHAT_COMPLETIONS_URL)
    log.info(
        "API key         : %s",
        "set" if OPENAI_COMPATIBLE_KEY else "not set (anonymous)",
    )
    log.info("Models          : %d", len(models))
    for p, m in models:
        log.info("  - %s/%s", p, m)
    log.info("Prompt          : %r", prompt)
    log.info("Python          : %s", sys.version.split()[0])
    log.info("httpx           : %s", httpx.__version__)
    log.info("OPENAI_COMPATIBLE_URL env: %r", os.getenv("OPENAI_COMPATIBLE_URL"))


async def _async_main(args: argparse.Namespace) -> int:
    log.setLevel(getattr(logging, args.log_level))
    models = _resolve_models(args)
    if not models:
        log.error("No models to probe. Pass --model provider model or check COUNCIL_MODELS.")
        return 2

    _print_config(models, args.prompt)

    if args.parallel:
        results = await run_parallel(models, args.prompt)
    else:
        results = await run_sequential(models, args.prompt)

    summary = Summary(results=results)
    print_summary(summary)
    return 0 if summary.failed() == 0 else 1


def main() -> None:
    parser = _build_argparser()
    args = parser.parse_args()
    try:
        code = asyncio.run(_async_main(args))
    except KeyboardInterrupt:
        log.warning("Interrupted by user")
        code = 130
    sys.exit(code)


if __name__ == "__main__":
    main()
