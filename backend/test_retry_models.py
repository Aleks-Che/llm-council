"""Offline regression tests for resumable runs and personal model connections."""

import asyncio
from collections import Counter
from contextlib import ExitStack
import json
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import httpx
from pydantic import ValidationError

from . import auth, client, council, main, research, runs, settings_store, storage
from .model_config import CustomModel
from .search_config import SearchSettings


class RetryModelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.object(storage, "USER_DATA_ROOT", root))
        self.stack.enter_context(patch.object(settings_store, "USER_DATA_ROOT", root))
        self.cid = str(uuid.uuid4())
        storage.create_conversation("alice", self.cid)
        storage.add_user_message("alice", self.cid, "Question")
        storage.add_assistant_placeholder("alice", self.cid)
        settings_store.save_settings("alice", ["test/a", "test/b"], "test/chair")
        self.calls = Counter()
        self.failures = set()
        self.stack.enter_context(patch.object(client, "query_model", self.fake_query))
        self.stack.enter_context(patch.object(council, "query_model", self.fake_query))
        self.stack.enter_context(patch.object(runs, "generate_conversation_title", AsyncMock(return_value="Question")))

    async def fake_query(self, provider, name, messages, **kwargs):
        prompt = messages[-1]["content"]
        stage = "stage2" if prompt.startswith("Ты оцениваешь") else "stage3" if prompt.startswith("Ты — Председатель") else "stage1"
        key = (stage, client.model_id(provider, name))
        self.calls[key] += 1
        if key in self.failures:
            return None
        return {"content": "FINAL RANKING:\n1. Response A\n2. Response B" if stage == "stage2" else f"Answer {name}"}

    def message(self):
        return storage.get_conversation("alice", self.cid)["messages"][-1]

    async def run_once(self):
        self.assertTrue(runs.start("alice", self.cid, "Question", False))
        await runs.ACTIVE_RUNS[self.cid]["task"]

    async def retry_once(self):
        self.assertTrue(runs.retry("alice", self.cid))
        await runs.ACTIVE_RUNS[self.cid]["task"]

    async def test_partial_first_stage_retries_only_missing_model_and_preserves_order(self):
        self.failures.add(("stage1", "test/a"))
        await self.run_once()
        first = self.message()
        self.assertEqual(first["status"], "error")
        self.assertEqual(first["failed_stage"], "stage1")
        self.assertEqual([r["model"] for r in first["stage1"]], ["test/b"])
        self.assertIsNone(first["stage2"])
        self.failures.clear()
        await self.retry_once()
        last = self.message()
        self.assertEqual(last["status"], "complete")
        self.assertEqual(last["stage1"][1], first["stage1"][0])
        self.assertEqual([r["model"] for r in last["stage1"]], ["test/a", "test/b"])
        self.assertEqual(last["metadata"]["label_to_model"], {"Response A": "test/a", "Response B": "test/b"})
        self.assertEqual(self.calls[("stage1", "test/a")], 2)
        self.assertEqual(self.calls[("stage1", "test/b")], 1)
        self.assertEqual(len(storage.get_conversation("alice", self.cid)["messages"]), 2)

    async def test_partial_rankings_retry_keeps_answers_and_successful_judges(self):
        self.failures.add(("stage2", "test/b"))
        await self.run_once()
        before = self.message()
        self.assertEqual(before["failed_stage"], "stage2")
        self.failures.clear()
        await self.retry_once()
        self.assertEqual(self.message()["stage1"], before["stage1"])
        self.assertEqual(self.calls[("stage2", "test/a")], 1)
        self.assertEqual(self.calls[("stage2", "test/b")], 2)
        self.assertEqual(self.calls[("stage1", "test/a")], 1)

    async def test_failed_ranking_reports_its_reason_and_preserves_other_scores(self):
        async def query(provider, name, messages, **kwargs):
            if name == "b" and messages[-1]["content"].startswith("Ты оцениваешь"):
                raise client.ModelQueryError("HTTP 503: Service unavailable")
            return await self.fake_query(provider, name, messages, **kwargs)

        with patch.object(client, "query_model", query):
            await self.run_once()
        failed = self.message()
        self.assertEqual(failed["failed_stage"], "stage2")
        self.assertIn("test/b: HTTP 503", failed["error"])
        self.assertEqual(len(failed["stage1"]), 2)
        self.assertEqual([r["model"] for r in failed["stage2"]], ["test/a"])
        await self.retry_once()
        self.assertEqual(self.message()["status"], "complete")
        self.assertIsNone(self.message()["error"])
        self.assertEqual(self.calls[("stage2", "test/a")], 1)

    async def test_chairman_failure_is_retryable_and_settings_do_not_replace_council(self):
        self.failures.add(("stage3", "test/chair"))
        await self.run_once()
        before = self.message()
        self.assertEqual(before["status"], "error")
        self.assertIsNone(before["stage3"])
        settings_store.save_settings("alice", ["test/different"], "test/different")
        self.failures.clear()
        await self.retry_once()
        self.assertEqual(self.message()["stage1"], before["stage1"])
        self.assertEqual(self.message()["stage2"], before["stage2"])
        self.assertEqual(self.calls[("stage3", "test/chair")], 2)
        self.assertEqual(self.calls[("stage3", "test/different")], 0)

    async def test_completed_research_is_not_repeated(self):
        state = research.new_research(SearchSettings())
        state.update(status="partial", phase="done", stop_reason="round_limit")
        context = research.build_context(state, SearchSettings().context_chars)
        self.failures.add(("stage3", "test/chair"))
        with patch.object(runs, "run_research", AsyncMock(return_value=(state, context))) as search:
            runs.start("alice", self.cid, "Question", False, True)
            await runs.ACTIVE_RUNS[self.cid]["task"]
            self.failures.clear()
            await self.retry_once()
        search.assert_awaited_once()
        self.assertEqual(self.message()["research"], state)

    async def test_cancellation_preserves_individual_response_before_other_models_finish(self):
        saved = asyncio.Event()
        original_save = storage.update_last_assistant_message

        def observe(*args, **fields):
            original_save(*args, **fields)
            if fields.get("stage1"):
                saved.set()

        async def query(provider, name, messages, **kwargs):
            if name == "b":
                await asyncio.Event().wait()
            return {"content": "Answer a"}

        with patch.object(client, "query_model", query), patch.object(storage, "update_last_assistant_message", observe):
            runs.start("alice", self.cid, "Question", False)
            task = runs.ACTIVE_RUNS[self.cid]["task"]
            await asyncio.wait_for(saved.wait(), 2)
            runs.cancel(self.cid)
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(self.message()["status"], "cancelled")
        await self.retry_once()
        self.assertEqual(self.calls[("stage1", "test/a")], 0)
        self.assertEqual(self.calls[("stage1", "test/b")], 1)

    async def test_restart_keeps_checkpoint_and_resume_works(self):
        storage.update_last_assistant_message("alice", self.cid, stage1=[{"model": "test/a", "response": "Saved"}],
                                              current_stage="stage1", completed_stages=[])
        storage.mark_interrupted_runs()
        self.assertEqual(self.message()["failed_stage"], "stage1")
        await self.retry_once()
        self.assertEqual(self.calls[("stage1", "test/a")], 0)

    async def test_legacy_synthesis_error_can_resume(self):
        await self.run_once()
        conversation = storage.get_conversation("alice", self.cid)
        message = conversation["messages"][-1]
        message.pop("completed_stages")
        message.pop("run_config")
        message["stage3"]["response"] = "Ошибка: не удалось сгенерировать итоговый синтез."
        storage.save_conversation("alice", conversation)
        self.assertEqual(self.message()["status"], "error")
        await self.retry_once()
        self.assertEqual(self.calls[("stage1", "test/a")], 1)
        self.assertEqual(self.calls[("stage3", "test/chair")], 2)

    async def test_retry_endpoint_rejects_duplicate_foreign_and_complete_runs(self):
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "alice"}
        self.addCleanup(main.app.dependency_overrides.clear)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as api:
            self.assertEqual((await api.post(f"/api/conversations/{self.cid}/retry")).status_code, 400)
            storage.update_last_assistant_message("alice", self.cid, status="error")
            with patch.object(runs, "_run", AsyncMock(side_effect=lambda *args, **kwargs: None)):
                self.assertTrue(runs.start("alice", self.cid, "Question", False))
                task = runs.ACTIVE_RUNS[self.cid]["task"]
                try:
                    self.assertEqual((await api.post(f"/api/conversations/{self.cid}/retry")).status_code, 409)
                finally:
                    await task
                    runs.ACTIVE_RUNS.pop(self.cid, None)
            main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "bob"}
            self.assertEqual((await api.post(f"/api/conversations/{self.cid}/retry")).status_code, 404)
        with self.assertRaises(ValueError):
            runs.retry("bob", self.cid)


class CustomConnectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.stack.enter_context(patch.object(settings_store, "USER_DATA_ROOT", root))
        self.stack.enter_context(patch.object(storage, "USER_DATA_ROOT", root))
        self.model = CustomModel(id="custom/" + "a" * 32, url="https://example.org/v1/chat/completions/",
                                 model="vendor/model", api_key="synthetic-personal-key", reasoning_effort="high")

    def save(self, model=None):
        model = model or self.model
        return settings_store.save_settings("alice", [model.id], model.id,
            SearchSettings(model=model.id), custom_models=[model])

    def test_round_trip_redacts_and_preserves_keys_and_isolates_users(self):
        public = self.save()
        self.assertNotIn("synthetic-personal-key", json.dumps(public))
        self.assertTrue(public["custom_models"][0]["key_configured"])
        self.assertEqual(public["custom_models"][0]["url"], "https://example.org/v1")
        self.save(CustomModel.model_validate(public["custom_models"][0]))
        settings_store.save_settings("alice", [self.model.id], self.model.id)
        self.assertEqual(settings_store.get_model_connections("alice")[self.model.id]["api_key"], "synthetic-personal-key")
        self.assertEqual(settings_store.get_model_connections("bob"), {})
        self.assertEqual(settings_store.get_settings("bob")["custom_models"], [])

    def test_url_change_does_not_reuse_old_key_and_explicit_replacement_works(self):
        public = self.save()["custom_models"][0]
        public["url"] = "https://new.example.org/v1"
        self.save(CustomModel.model_validate(public))
        self.assertFalse(settings_store.get_model_connections("alice")[self.model.id]["api_key"])
        public["api_key"] = "replacement"
        self.save(CustomModel.model_validate(public))
        self.assertEqual(settings_store.get_model_connections("alice")[self.model.id]["api_key"], "replacement")

    def test_invalid_urls_and_reasoning_are_rejected(self):
        for url in ("file:///secret", "ftp://example.org", "https://user:key@example.org/v1", "https://example.org/v1?key=secret", "https://example.org:wrong", "   "):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                CustomModel.model_validate({**self.model.model_dump(), "url": url})
        with self.assertRaises(ValidationError):
            CustomModel.model_validate({**self.model.model_dump(), "reasoning_effort": "invalid"})
        with self.assertRaises(ValueError):
            settings_store.save_settings("bob", [self.model.id], self.model.id)

    async def test_http_routes_exact_model_key_and_optional_reasoning_per_task(self):
        original_http = httpx.AsyncClient
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})

        def http(**kwargs):
            return original_http(transport=httpx.MockTransport(respond), **kwargs)

        async def query(connection):
            with client.use_model_connections({self.model.id: connection}):
                await asyncio.sleep(0)
                return await client.query_model(*settings_store.model_id_to_key(self.model.id), [{"role": "user", "content": "Test"}])

        with patch.object(client.httpx, "AsyncClient", http), patch.object(client, "OPENAI_COMPATIBLE_KEY", "global-secret"):
            await asyncio.gather(query(self.model.model_dump()), query({**self.model.model_dump(),
                "url": "http://localhost:9000/v1", "api_key": "", "reasoning_effort": None}))
            unknown = await client.query_model("custom", "missing", [])
        self.assertIsNone(unknown)
        self.assertEqual(len(requests), 2)
        personal, local = requests
        self.assertEqual(str(personal.url), "https://example.org/v1/chat/completions")
        self.assertEqual(personal.headers["Authorization"], "Bearer synthetic-personal-key")
        self.assertEqual(json.loads(personal.content)["model"], "vendor/model")
        self.assertEqual(json.loads(personal.content)["reasoning_effort"], "high")
        self.assertNotIn("Authorization", local.headers)
        self.assertNotIn("reasoning_effort", json.loads(local.content))

    async def test_empty_response_is_a_failure(self):
        original_http = httpx.AsyncClient
        def respond(request):
            return httpx.Response(200, json={"choices": [{"message": {"content": "  "}}]})
        with patch.object(client.httpx, "AsyncClient", lambda **kwargs: original_http(transport=httpx.MockTransport(respond), **kwargs)):
            self.assertIsNone(await client.query_model("test", "model", []))

    async def test_model_test_reports_upstream_errors_without_exposing_keys(self):
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "alice"}
        self.addCleanup(main.app.dependency_overrides.clear)
        original_http = httpx.AsyncClient
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(401, json={"error": {"message":
                "Invalid API-key: synthetic-personal-key; global-secret"}})

        async with original_http(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as api:
            with patch.object(client.httpx, "AsyncClient", lambda **kwargs: original_http(
                transport=httpx.MockTransport(respond), **kwargs
            )), patch.object(client, "OPENAI_COMPATIBLE_KEY", "global-secret"), patch("builtins.print") as log:
                response = await api.post("/api/settings/test-model", json={"model": self.model.id,
                    "custom_models": [self.model.model_dump()]})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertFalse(result["ok"])
        self.assertIn("HTTP 401", result["error"])
        self.assertIn("https://example.org/v1/chat/completions", result["error"])
        self.assertIn("Invalid API-key", result["error"])
        self.assertNotIn("synthetic-personal-key", response.text + str(log.call_args_list))
        self.assertNotIn("global-secret", response.text + str(log.call_args_list))
        self.assertEqual(len(requests), 1)
        self.assertEqual(str(requests[0].url), "https://example.org/v1/chat/completions")
        self.assertEqual(json.loads(requests[0].content)["model"], "vendor/model")

    async def test_diagnostics_handle_non_json_errors_and_timeout(self):
        original_http = httpx.AsyncClient
        scenarios = [
            (httpx.Response(404, text="Unknown endpoint"), "HTTP 404"),
            (httpx.Response(200, json={"choices": [{"message": {"content": " "}}]}), "пустой ответ"),
            (httpx.ReadTimeout("timeout"), "время ожидания"),
        ]
        for outcome, expected in scenarios:
            with self.subTest(expected=expected):
                def respond(request):
                    if isinstance(outcome, Exception):
                        raise outcome
                    return outcome

                with client.use_model_connections({self.model.id: self.model.model_dump()}), patch.object(
                    client.httpx, "AsyncClient", lambda **kwargs: original_http(
                        transport=httpx.MockTransport(respond), **kwargs)
                ), patch("builtins.print"):
                    with self.assertRaisesRegex(client.ModelQueryError, expected):
                        await client.query_model(*settings_store.model_id_to_key(self.model.id), [], raise_on_error=True)

    async def test_run_snapshots_connection_and_retry_uses_updated_key_without_repeating_answers(self):
        self.save()
        cid = str(uuid.uuid4())
        storage.create_conversation("alice", cid)
        storage.add_user_message("alice", cid, "Question")
        storage.add_assistant_placeholder("alice", cid)
        original_http = httpx.AsyncClient
        requests = []

        def respond(request):
            requests.append(request)
            if len(requests) == 3:
                return httpx.Response(503)
            return httpx.Response(200, json={"choices": [{"message": {"content": "FINAL RANKING:\n1. Response A"}}]})

        with patch.object(client.httpx, "AsyncClient", lambda **kwargs: original_http(transport=httpx.MockTransport(respond), **kwargs)):
            runs.start("alice", cid, "Question", False)
            updated = CustomModel.model_validate({**self.model.model_dump(), "api_key": "replacement-key"})
            self.save(updated)
            await runs.ACTIVE_RUNS[cid]["task"]
            self.assertEqual([r.headers["Authorization"] for r in requests], ["Bearer synthetic-personal-key"] * 3)
            before = storage.get_conversation("alice", cid)
            self.assertEqual(before["messages"][-1]["failed_stage"], "stage3")
            self.assertIn("HTTP 503", before["messages"][-1]["error"])
            with patch.object(runs, "generate_conversation_title", AsyncMock(return_value="Question")):
                runs.retry("alice", cid)
                await runs.ACTIVE_RUNS[cid]["task"]
        after = storage.get_conversation("alice", cid)
        self.assertEqual(len(requests), 4)
        self.assertEqual(requests[-1].headers["Authorization"], "Bearer replacement-key")
        self.assertEqual(after["messages"][-1]["status"], "complete")
        self.assertEqual(before["messages"][-1]["stage1"], after["messages"][-1]["stage1"])
        self.assertNotIn("synthetic-personal-key", json.dumps(after))
        self.assertNotIn("replacement-key", json.dumps(after))

    async def test_run_saves_timeout_and_http_causes_and_retries_only_missing_answer(self):
        other = CustomModel.model_validate({**self.model.model_dump(), "id": "custom/" + "b" * 32,
                                            "model": "vendor/other"})
        settings_store.save_settings("alice", [self.model.id, other.id], self.model.id,
                                     custom_models=[self.model, other])
        cid = str(uuid.uuid4())
        storage.create_conversation("alice", cid)
        storage.update_conversation_title("alice", cid, "Question")
        storage.add_user_message("alice", cid, "Question")
        storage.add_assistant_placeholder("alice", cid)
        original_http = httpx.AsyncClient
        requests = []
        failure = "timeout"

        def respond(request):
            body = json.loads(request.content)
            requests.append(body["model"])
            self.assertEqual(body["reasoning_effort"], "high")
            self.assertEqual(request.extensions["timeout"]["read"], 1800)
            if body["model"] == self.model.model and failure == "timeout":
                raise httpx.ReadTimeout("upstream stalled", request=request)
            if body["model"] == self.model.model and failure == "rate_limit":
                return httpx.Response(429, json={"error": {"message":
                    "Rate limit for synthetic-personal-key"}})
            return httpx.Response(200, json={"choices": [{"message": {
                "content": "FINAL RANKING:\n1. Response A\n2. Response B"}}]})

        with patch.object(client.httpx, "AsyncClient", lambda **kwargs: original_http(
            transport=httpx.MockTransport(respond), **kwargs
        )), patch("builtins.print"):
            runs.start("alice", cid, "Question", False)
            await runs.ACTIVE_RUNS[cid]["task"]
            first = storage.get_conversation("alice", cid)["messages"][-1]
            self.assertIn("vendor/model:", first["error"])
            self.assertIn("ReadTimeout", first["error"])
            self.assertIn("таймаут 1800 с", first["error"])
            self.assertEqual([r["model"] for r in first["stage1"]], [other.id])

            failure = "rate_limit"
            runs.retry("alice", cid)
            await runs.ACTIVE_RUNS[cid]["task"]
            second = storage.get_conversation("alice", cid)["messages"][-1]
            self.assertIn("HTTP 429", second["error"])
            self.assertNotIn("ReadTimeout", second["error"])
            self.assertNotIn("synthetic-personal-key", json.dumps(second))
            self.assertEqual(second["stage1"], first["stage1"])
            self.assertEqual(requests, [self.model.model, other.model, self.model.model])

            failure = None
            runs.retry("alice", cid)
            await runs.ACTIVE_RUNS[cid]["task"]
        last = storage.get_conversation("alice", cid)["messages"][-1]
        self.assertEqual(last["status"], "complete")
        self.assertIsNone(last["error"])
        self.assertEqual(last["stage1"][1], first["stage1"][0])

    async def test_research_uses_the_custom_connection(self):
        original_http = httpx.AsyncClient
        requests = []

        def respond(request):
            requests.append(request)
            content = json.dumps({"questions": ["Question"], "queries": ["Search query"]})
            return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

        with client.use_model_connections({self.model.id: self.model.model_dump()}), patch.object(
            client.httpx, "AsyncClient", lambda **kwargs: original_http(transport=httpx.MockTransport(respond), **kwargs)
        ):
            result = await research.ask_json(SearchSettings(model=self.model.id), research.Plan, "Make a plan", {})
        self.assertEqual(result.queries, ["Search query"])
        self.assertEqual(json.loads(requests[0].content)["model"], "vendor/model")
        self.assertEqual(requests[0].headers["Authorization"], "Bearer synthetic-personal-key")

    async def test_settings_api_and_draft_test_do_not_expose_or_persist_keys(self):
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "alice"}
        self.addCleanup(main.app.dependency_overrides.clear)
        original_query = main.query_model
        observed = []

        async def check(*args, **kwargs):
            observed.append(client._connections.get())
            return {"content": "OK"}

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as api:
            with patch.object(main, "query_model", check):
                response = await api.post("/api/settings/test-model", json={"model": self.model.id, "custom_models": [self.model.model_dump()]})
            self.assertTrue(response.json()["ok"])
            self.assertEqual(observed[0][self.model.id]["api_key"], "synthetic-personal-key")
            self.assertEqual(settings_store.get_model_connections("alice"), {})
            response = await api.post("/api/settings", json={"council_models": [self.model.id], "chairman_model": self.model.id,
                "custom_models": [self.model.model_dump()]})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("synthetic-personal-key", response.text)
            with patch.object(main, "fetch_available_models", AsyncMock(return_value=[])):
                response = await api.get("/api/settings")
            self.assertIn(self.model.id, response.json()["available_models"])
            self.assertNotIn("synthetic-personal-key", response.text)
        self.assertIs(main.query_model, original_query)


if __name__ == "__main__":
    unittest.main()
