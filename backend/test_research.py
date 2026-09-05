"""Offline regression tests: python -m unittest backend.test_research -v."""

import asyncio
import copy
import json
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from . import research, storage, settings_store, runs, council, main, auth
from .research import Plan, Selection, Assessment, run_research, ask_json
from .search_config import SearchSettings
from .search_provider import TavilyProvider, SearchProviderError, public_url


PAGE = "The service supports batch extraction of public documents. Each result has a source URL. " * 8


def assessment(sufficient=True, evidence="S1E1", queries=None):
    return Assessment(
        sufficient=sufficient,
        findings=[{"text": "Batch extraction is supported.", "evidence_ids": [evidence]}],
        coverage=[{"question_index": 0, "evidence_ids": [evidence]}] if sufficient else [],
        gaps=[] if sufficient else ["Need the current batch limit."], next_queries=queries or [],
    )


class FakeProvider:
    def __init__(self, *, blocked=False, basic_fails=False, error=False):
        self.usage = {"search_requests": 0, "extract_requests": 0, "credits": 0}
        self.closed = False
        self.blocked, self.basic_fails, self.error = blocked, basic_fails, error
        self.extracted = []

    async def search(self, query):
        self.usage["search_requests"] += 1
        if self.error:
            raise SearchProviderError("Service unavailable")
        number = self.usage["search_requests"]
        return {"results": [{"url": f"https://example.org/{number}", "title": f"Document {number}",
                             "content": "Unverified search snippet"}]}

    async def extract(self, urls, advanced=False):
        self.usage["extract_requests"] += 1
        self.extracted.append((urls, advanced))
        return {"results": [{"url": url, "raw_content":
                 "Verify you are human. Checking your browser. " * 4
                 if self.blocked or (self.basic_fails and not advanced) else PAGE + url} for url in urls]}

    async def close(self):
        self.closed = True


class ResearchTests(unittest.IsolatedAsyncioTestCase):
    async def run_flow(self, decisions, provider=None, **limits):
        snapshots = []
        provider = provider or FakeProvider()
        with patch.object(research, "ask_json", AsyncMock(side_effect=decisions)):
            result, context = await run_research("How does batch extraction work?", SearchSettings(**limits),
                "test-key", lambda state, docs: snapshots.append((copy.deepcopy(state), copy.deepcopy(docs))),
                provider=provider)
        return result, context, provider, snapshots

    async def test_success_retains_original_evidence_and_stops_early(self):
        state, context, provider, snapshots = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(),
        ])
        self.assertEqual(state["status"], "complete")
        self.assertEqual(provider.usage["search_requests"], 1)
        self.assertTrue(provider.closed)
        self.assertIn("https://example.org/1", context)
        self.assertIn("The service supports batch extraction", context)
        self.assertNotIn("Unverified search snippet", context)
        self.assertIn("S1", snapshots[-1][1])
        self.assertEqual(snapshots[-1][0]["phase"], "done")
        self.assertLessEqual(len(context), SearchSettings().context_chars)
        for excerpt in state["sources"][0]["excerpts"]:
            self.assertIn(excerpt["text"], snapshots[-1][1]["S1"]["content"])

    async def test_second_round_targets_gaps(self):
        state, _, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(False, queries=["current batch limit"]),
            Selection(source_ids=["S2"]), assessment(evidence="S2E1"),
        ])
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["round"], 2)
        self.assertEqual(provider.usage["search_requests"], 2)
        self.assertEqual(state["queries"][1]["query"], "current batch limit")

    async def test_page_limit_prevents_further_search(self):
        state, _, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(False, queries=["another query"]),
        ], max_pages=1, max_rounds=3)
        self.assertEqual(state["status"], "partial")
        self.assertEqual(state["stop_reason"], "page_limit")
        self.assertEqual(provider.usage["search_requests"], 1)

    async def test_repeated_query_is_not_executed(self):
        state, _, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(False, queries=["BATCH extraction"]),
        ])
        self.assertEqual(state["stop_reason"], "no_new_queries")
        self.assertEqual(provider.usage["search_requests"], 1)

    async def test_query_cap_is_enforced_before_parallel_dispatch(self):
        state, _, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["first", "second", "third"]),
            Selection(source_ids=["S1"]), assessment(False, queries=["fourth"]),
        ], max_queries=1)
        self.assertEqual(state["stop_reason"], "query_limit")
        self.assertEqual(provider.usage["search_requests"], 1)

    async def test_empty_model_queries_fall_back_to_the_question(self):
        state, _, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["   "]),
            Selection(source_ids=["S1"]), assessment(),
        ])
        self.assertEqual(state["status"], "complete")
        self.assertEqual(provider.usage["search_requests"], 1)
        self.assertEqual(state["queries"][0]["query"], "How does batch extraction work?")

    async def test_unknown_evidence_cannot_mark_question_covered(self):
        state, context, _, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(evidence="S999E1"),
        ])
        self.assertEqual(state["status"], "partial")
        self.assertEqual(state["findings"], [])
        self.assertTrue(state["gaps"])
        self.assertNotIn("S999E1", context)

    async def test_blocked_page_is_not_treated_as_evidence(self):
        state, context, provider, snapshots = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(),
        ], provider=FakeProvider(blocked=True))
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["sources"][0]["status"], "failed")
        self.assertEqual(snapshots[-1][1], {})
        self.assertEqual(provider.usage["extract_requests"], 2)
        self.assertNotIn("Checking your browser", context)
        self.assertIn("Прочитанных веб-источников нет", context)

    async def test_advanced_retry_recovers_page(self):
        state, _, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
            Selection(source_ids=["S1"]), assessment(),
        ], provider=FakeProvider(basic_fails=True))
        self.assertEqual(state["status"], "complete")
        self.assertEqual([advanced for _, advanced in provider.extracted], [False, True])
        self.assertNotIn("error", state["sources"][0])

    async def test_provider_failure_is_visible_and_bounded(self):
        state, context, provider, _ = await self.run_flow([
            Plan(questions=["Batch support?"], queries=["batch extraction"]),
        ], provider=FakeProvider(error=True))
        self.assertEqual(state["status"], "failed")
        self.assertIn("Service unavailable", context)
        self.assertEqual(provider.usage["extract_requests"], 0)

    async def test_timeout_preserves_completed_extraction(self):
        snapshots, provider = [], FakeProvider()
        async def decision(settings, schema, *args):
            if schema is Plan:
                return Plan(questions=["Batch support?"], queries=["batch extraction"])
            if schema is Selection:
                return Selection(source_ids=["S1"])
            await asyncio.sleep(10)
        wait_for = asyncio.wait_for
        async def short_wait(coroutine, timeout):
            return await wait_for(coroutine, timeout=.05)
        with patch.object(research, "ask_json", decision), patch.object(research.asyncio, "wait_for",
                short_wait):
            state, context = await run_research("batch?", SearchSettings(), "key",
                lambda s, d: snapshots.append(copy.deepcopy(s)), provider=provider)
        self.assertEqual(state["stop_reason"], "timeout")
        self.assertEqual(state["status"], "partial")
        self.assertIn("S1E1", context)
        self.assertTrue(provider.closed)

    async def test_cancellation_closes_transport_and_persists_status(self):
        reached_assessment = asyncio.Event()
        snapshots, provider = [], FakeProvider()
        async def decision(settings, schema, *args):
            if schema is Plan:
                return Plan(questions=["Batch support?"], queries=["batch extraction"])
            if schema is Selection:
                return Selection(source_ids=["S1"])
            reached_assessment.set()
            await asyncio.sleep(10)
        with patch.object(research, "ask_json", decision):
            task = asyncio.create_task(run_research("batch?", SearchSettings(), "key",
                lambda s, d: snapshots.append(copy.deepcopy(s)), provider=provider))
            await asyncio.wait_for(reached_assessment.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(snapshots[-1]["status"], "cancelled")
        self.assertEqual(snapshots[-1]["sources"][0]["status"], "read")
        self.assertTrue(provider.closed)

    async def test_model_json_repair_is_bounded(self):
        with patch.object(research, "query_model", AsyncMock(side_effect=[
            {"content": "not JSON"}, {"content": '```json\n{"questions":["Q"],"queries":["query"]}\n```'},
        ])) as model:
            result = await ask_json(SearchSettings(), Plan, "Plan", {})
        self.assertIsInstance(result, Plan)
        self.assertEqual(model.await_count, 2)
        with patch.object(research, "query_model", AsyncMock(return_value={"content": "{}"})) as model:
            result = await ask_json(SearchSettings(), Plan, "Plan", {})
        self.assertIsNone(result)
        self.assertEqual(model.await_count, 2)

    async def test_tavily_contract_and_redacted_errors(self):
        seen = []
        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"results": [], "usage": {"credits": 2}})
        provider = TavilyProvider("secret-test-key")
        await provider.close()
        provider.client = httpx.AsyncClient(base_url="https://api.tavily.com", transport=httpx.MockTransport(handler))
        await provider.search("query")
        await provider.extract(["https://example.org/"])
        self.assertFalse(seen[0]["include_answer"])
        self.assertFalse(seen[0]["include_raw_content"])
        self.assertEqual(seen[1]["format"], "markdown")
        self.assertEqual(provider.usage["credits"], 4)
        await provider.close()
        provider.client = httpx.AsyncClient(base_url="https://api.tavily.com", transport=httpx.MockTransport(
            lambda request: httpx.Response(401, text="secret-test-key")))
        with self.assertRaises(SearchProviderError) as error:
            await provider.search("query")
        self.assertNotIn("secret-test-key", str(error.exception))
        await provider.close()


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for module in (storage, settings_store):
            patcher = patch.object(module, "USER_DATA_ROOT", self.tmp.name)
            patcher.start()
            self.addCleanup(patcher.stop)
        key_patch = patch.object(settings_store, "TAVILY_API_KEY", "")
        key_patch.start()
        self.addCleanup(key_patch.stop)
        self.cid, self.rid = str(uuid.uuid4()), str(uuid.uuid4())
        storage.create_conversation("alice", self.cid)

    def test_keys_are_private_preserved_and_removable(self):
        settings = settings_store.save_settings("alice", ["test/model"], "test/chair", SearchSettings(), "private-key")
        self.assertNotIn("private-key", json.dumps(settings))
        self.assertNotIn("private-key", json.dumps(settings_store.get_settings("alice")))
        settings_store.save_settings("alice", ["test/model"], "test/chair")
        self.assertEqual(settings_store.get_search_api_key("alice"), "private-key")
        self.assertEqual(settings_store.get_search_api_key("bob"), "")
        settings_store.save_settings("alice", ["test/model"], "test/chair", remove_tavily_key=True)
        self.assertEqual(settings_store.get_search_api_key("alice"), "")

    def test_missing_key_preserves_empty_conversation_and_source_route_handles_old_messages(self):
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "alice"}
        self.addCleanup(main.app.dependency_overrides.clear)
        with patch.object(main, "fetch_available_models", AsyncMock(return_value=[])):
            client = TestClient(main.app)
            response = client.post(f"/api/conversations/{self.cid}/message", json={"content": "Question", "search_enabled": True})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(storage.get_conversation("alice", self.cid)["messages"], [])
            storage.add_assistant_placeholder("alice", self.cid)
            response = client.get(f"/api/conversations/{self.cid}/research/{self.rid}/sources/S1")
            self.assertEqual(response.status_code, 404)
            settings_store.save_settings("alice", ["test/model"], "test/chair", tavily_api_key="private-key")
            self.assertNotIn("private-key", client.get("/api/settings").text)

    def test_raw_text_is_loaded_separately_and_isolated(self):
        storage.add_assistant_placeholder("alice", self.cid, True)
        state = {"id": self.rid, "sources": [{"id": "S1", "status": "read"}]}
        storage.update_last_assistant_message("alice", self.cid, research=state)
        storage.save_research_documents("alice", self.cid, self.rid, {"S1": {"content": PAGE}})
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "alice"}
        self.addCleanup(main.app.dependency_overrides.clear)
        client = TestClient(main.app)
        self.assertNotIn(PAGE, client.get(f"/api/conversations/{self.cid}").text)
        url = f"/api/conversations/{self.cid}/research/{self.rid}/sources/S1"
        self.assertEqual(client.get(url).json()["content"], PAGE)
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "bob"}
        self.assertEqual(client.get(url).status_code, 404)
        storage.delete_conversation("alice", self.cid)
        self.assertIsNone(storage.get_research_document("alice", self.cid, self.rid, "S1"))

    def test_restart_marks_research_interrupted(self):
        storage.add_assistant_placeholder("alice", self.cid, True)
        storage.update_last_assistant_message("alice", self.cid, research=research.new_research(SearchSettings()))
        storage.mark_interrupted_runs()
        message = storage.get_conversation("alice", self.cid)["messages"][-1]
        self.assertEqual(message["status"], "interrupted")
        self.assertEqual(message["research"]["status"], "interrupted")


class CouncilTests(unittest.IsolatedAsyncioTestCase):
    async def test_background_run_snapshots_settings_and_persists_research_before_council(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(storage, "USER_DATA_ROOT", directory), patch.object(settings_store, "USER_DATA_ROOT", directory):
            cid = str(uuid.uuid4())
            storage.create_conversation("alice", cid)
            storage.add_assistant_placeholder("alice", cid, True)
            settings_store.save_settings("alice", ["test/original"], "test/chair", SearchSettings(model="test/research"), "test-key")
            first = AsyncMock(return_value=[{"model": "test/original", "response": "Answer [S1E1]"}])
            second = AsyncMock(return_value=([{"model": "test/original", "ranking": "FINAL RANKING:\n1. Response A", "parsed_ranking": ["Response A"]}], {"Response A": "test/original"}))
            third = AsyncMock(return_value={"model": "test/chair", "response": "Final [S1E1]"})
            with patch.object(research, "TavilyProvider", lambda key: FakeProvider()), patch.object(research, "ask_json", AsyncMock(side_effect=[
                Plan(questions=["Batch support?"], queries=["batch extraction"]), Selection(source_ids=["S1"]), assessment(),
            ])), patch.object(runs, "stage1_collect_responses", first), patch.object(runs, "stage2_collect_rankings", second), patch.object(runs, "stage3_synthesize_final", third):
                self.assertTrue(runs.start("alice", cid, "Question", False, True))
                settings_store.save_settings("alice", ["test/changed"], "test/changed", SearchSettings(model="test/changed"))
                await runs.ACTIVE_RUNS[cid]["task"]
            message = storage.get_conversation("alice", cid)["messages"][-1]
            self.assertEqual(message["status"], "complete")
            self.assertEqual(message["research"]["model"], "test/research")
            self.assertIn("[S1E1](https://example.org/1)", message["stage3"]["response"])
            self.assertEqual(first.await_args.args[1], [("test", "original")])
            self.assertEqual(first.await_args.args[-1], second.await_args.args[-1])
            self.assertEqual(first.await_args.args[-1], third.await_args.args[-1])
            self.assertIsNotNone(storage.get_research_document("alice", cid, message["research"]["id"], "S1"))
            self.assertNotIn(cid, runs.ACTIVE_RUNS)

    async def test_all_stages_receive_identical_research_and_off_mode_has_no_context(self):
        context = "Original evidence: batch extraction [S1E1]"
        parallel = AsyncMock(return_value={"test/model": {"content": "FINAL RANKING:\n1. Response A"}})
        single = AsyncMock(return_value={"content": "Final [S1E1]"})
        with patch.object(council, "query_models_parallel", parallel), patch.object(council, "query_model", single):
            first = await council.stage1_collect_responses("Question", [("test", "model")], context)
            second, _ = await council.stage2_collect_rankings("Question", first, [("test", "model")], context)
            await council.stage3_synthesize_final("Question", first, second, ("test", "chair"), context)
            calls = [parallel.await_args_list[0].args[1], parallel.await_args_list[1].args[1], single.await_args.args[2]]
            self.assertTrue(all(messages[1] == calls[0][1] for messages in calls))
            self.assertIn(context, calls[0][1]["content"])
            await council.stage1_collect_responses("Question", [("test", "model")])
            self.assertEqual(parallel.await_args.args[1], [{"role": "user", "content": "Question"}])

    def test_citations_use_registry_even_if_model_invents_url(self):
        state = {"sources": [{"id": "S1", "url": "https://example.org/", "status": "read",
                              "excerpts": [{"id": "S1E1", "text": PAGE}]}]}
        result = research.resolve_citations("Fact [S1E1](https://invented.example/) unknown [S2E1]", state)
        self.assertIn("[S1E1](https://example.org/)", result)
        self.assertNotIn("invented.example", result)
        self.assertIn("источник не подтверждён", result)

    def test_source_url_validation(self):
        for url in ("http://127.0.0.1/", "file:///etc/passwd", "https://host.local/", "javascript:alert(1)", "https://user:password@example.org/"):
            self.assertEqual(public_url(url), "")
        self.assertEqual(public_url("https://example.org/page?utm_source=test&v=2#part"), "https://example.org/page?v=2")


if __name__ == "__main__":
    unittest.main()
