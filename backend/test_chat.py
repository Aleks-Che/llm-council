"""Offline coverage for multi-turn chat, mode selection, search and saved model defaults."""

import asyncio
from contextlib import ExitStack
import json
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

import httpx

from . import auth, main, research, runs, settings_store, storage
from .search_config import SearchSettings


class ChatTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = self.stack.enter_context(tempfile.TemporaryDirectory())
        for module in (settings_store, storage):
            self.stack.enter_context(patch.object(module, "USER_DATA_ROOT", root))
        self.stack.enter_context(patch.object(settings_store, "TAVILY_API_KEY", ""))
        self.stack.enter_context(patch.object(runs, "generate_conversation_title", AsyncMock(return_value="Chat")))
        self.query = self.stack.enter_context(patch.object(runs, "query_model", AsyncMock(return_value={"content": "Ответ"})))
        self.search = self.stack.enter_context(patch.object(runs, "run_research", AsyncMock()))
        self.stage1 = self.stack.enter_context(patch.object(runs, "stage1_collect_responses", AsyncMock(
            return_value=[{"model": "test/member", "response": "Member answer"}])))
        self.stage2 = self.stack.enter_context(patch.object(runs, "stage2_collect_rankings", AsyncMock(
            return_value=([{"model": "test/member", "ranking": "FINAL RANKING:\n1. Response A", "parsed_ranking": ["Response A"]}],
                          {"Response A": "test/member"}))))
        self.stage3 = self.stack.enter_context(patch.object(runs, "stage3_synthesize_final", AsyncMock(
            return_value={"model": "test/chair", "response": "Council answer"})))
        settings_store.save_settings("alice", ["test/member"], "test/chair", chat_model="test/chat")
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "alice"}
        self.addCleanup(main.app.dependency_overrides.clear)
        self.cid = str(uuid.uuid4())
        storage.create_conversation("alice", self.cid)

    def last(self):
        return storage.get_conversation("alice", self.cid)["messages"][-1]

    async def request(self, method, path, data=None):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as api:
            return await api.request(method, path, json=data)

    async def send(self, content="Question", **options):
        response = await self.request("POST", f"/api/conversations/{self.cid}/message", {"content": content, **options})
        self.assertEqual(response.status_code, 200, response.text)
        if self.cid in runs.ACTIVE_RUNS:
            await runs.ACTIVE_RUNS[self.cid]["task"]

    async def test_chat_is_default_and_next_turn_receives_history_with_attachments(self):
        question = "Запомни имя: Алексей\n\n**Прикреплённые файлы:**\n~~~~text\nDetails\n~~~~"
        await self.send(question)
        self.assertEqual(self.last()["mode"], "chat")
        self.assertEqual(self.last()["content"], "Ответ")
        self.assertIsNone(self.last()["stage1"])
        self.assertIsNone(self.last()["stage3"])
        self.assertEqual(self.query.await_args.args[:2], ("test", "chat"))
        self.search.assert_not_awaited()
        self.stage1.assert_not_awaited()
        await self.send("Как меня зовут?", chat_model="test/another")
        self.assertEqual(self.query.await_args.args[:2], ("test", "another"))
        self.assertEqual(self.query.await_args.args[2], [
            {"role": "user", "content": question}, {"role": "assistant", "content": "Ответ"},
            {"role": "user", "content": "Как меня зовут?"}])
        self.assertEqual(len(storage.get_conversation("alice", self.cid)["messages"]), 4)

    async def test_mode_switch_uses_only_final_council_answer_in_history(self):
        await self.send("Initial chat")
        await self.send("Ask council", council_enabled=True, council_models=["test/member"], chairman_model="test/chair")
        self.assertEqual(self.last()["mode"], "council")
        self.assertIn("Initial chat", self.stage1.await_args.args[0])
        self.assertEqual(self.stage1.await_args.args[1], [("test", "member")])
        self.assertEqual(self.stage3.await_args.args[3], ("test", "chair"))
        await self.send("Explain the result")
        prompt = self.query.await_args.args[2]
        self.assertEqual([m["content"] for m in prompt], ["Initial chat", "Ответ", "Ask council", "Council answer", "Explain the result"])
        self.assertNotIn("Member answer", json.dumps(prompt))

    async def test_chat_retry_uses_current_model_and_reuses_completed_search(self):
        settings_store.save_settings("alice", ["test/member"], "test/chair", tavily_api_key="private-test-key")
        state = research.new_research(SearchSettings())
        state.update(status="complete", phase="done", sources=[{
            "id": "S1", "title": "Evidence", "url": "https://example.org/evidence", "status": "read",
            "excerpts": [{"id": "S1E1", "text": "Evidence text"}],
        }])
        context = research.build_context(state, 24000)
        self.search.return_value = (state, context)

        async def fail_after_search(*args, **kwargs):
            self.search.assert_awaited_once()
            self.assertTrue(any(context in message["content"] for message in args[2]))
            raise RuntimeError("Provider temporarily unavailable")

        self.query.side_effect = fail_after_search
        await self.send("Search question", search_enabled=True)
        self.assertEqual(self.last()["failed_stage"], "chat")
        self.assertEqual(self.last()["completed_stages"], ["research"])
        settings_store.save_settings("alice", ["test/member"], "test/chair", chat_model="test/changed")
        self.query.side_effect = None
        self.query.return_value = {"content": "Fact [S1E1]"}
        self.assertTrue(runs.retry("alice", self.cid))
        await runs.ACTIVE_RUNS[self.cid]["task"]
        self.search.assert_awaited_once()
        self.assertEqual(self.query.await_args.args[:2], ("test", "changed"))
        self.assertEqual(self.last()["model"], "test/changed")
        self.assertEqual(self.last()["run_config"]["chat_model"], "test/changed")
        self.assertEqual(self.last()["research"], state)
        self.assertEqual(self.last()["content"], "Fact [S1E1](https://example.org/evidence)")
        self.assertEqual(self.last()["status"], "complete")
        self.assertNotIn("private-test-key", json.dumps(self.last()))

    async def test_retry_endpoint_uses_explicit_chat_model_and_rejects_invalid_selection(self):
        self.query.side_effect = RuntimeError("Provider unavailable")
        await self.send("Original question with attachment\n~~~~text\nDetails\n~~~~")
        failed = self.last()
        response = await self.request("POST", f"/api/conversations/{self.cid}/retry", {"chat_model": "custom/missing"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.last(), failed)
        self.assertNotIn(self.cid, runs.ACTIVE_RUNS)

        settings_store.save_settings("alice", ["test/member"], "test/chair", chat_model="test/default")
        self.query.side_effect = None
        response = await self.request("POST", f"/api/conversations/{self.cid}/retry", {"chat_model": "test/selected"})
        self.assertEqual(response.status_code, 200, response.text)
        if self.cid in runs.ACTIVE_RUNS:
            await runs.ACTIVE_RUNS[self.cid]["task"]
        self.assertEqual(self.query.await_args.args[:2], ("test", "selected"))
        self.assertEqual(self.query.await_args.args[2], [
            {"role": "user", "content": "Original question with attachment\n~~~~text\nDetails\n~~~~"}])
        self.assertEqual(self.last()["model"], "test/selected")
        self.assertEqual(self.last()["status"], "complete")
        self.assertEqual(len(storage.get_conversation("alice", self.cid)["messages"]), 2)

    async def test_chat_cancellation_blocks_duplicate_then_can_resume(self):
        entered = asyncio.Event()

        async def pending(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        self.query.side_effect = pending
        response = await self.request("POST", f"/api/conversations/{self.cid}/message", {"content": "Wait"})
        self.assertEqual(response.status_code, 200)
        task = runs.ACTIVE_RUNS[self.cid]["task"]
        await asyncio.wait_for(entered.wait(), 2)
        response = await self.request("POST", f"/api/conversations/{self.cid}/message", {"content": "Duplicate"})
        self.assertEqual(response.status_code, 409)
        runs.cancel(self.cid)
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.last()["status"], "cancelled")
        self.query.side_effect = None
        self.assertTrue(runs.retry("alice", self.cid))
        await runs.ACTIVE_RUNS[self.cid]["task"]
        self.assertEqual(self.last()["status"], "complete")
        self.assertEqual(len(storage.get_conversation("alice", self.cid)["messages"]), 2)

    async def test_stopped_prompt_can_be_edited_without_duplicating_it_or_losing_prior_history(self):
        await self.send("Earlier question")
        prefix = storage.get_conversation("alice", self.cid)["messages"]
        entered = asyncio.Event()

        async def pending(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        self.query.side_effect = pending
        original = "Wrong question\n\n---\n\n**Прикреплённые файлы:**\n\n**📎 notes.txt** (7 B):\n\n~~~~text\nDetails\n~~~~"
        await self.request("POST", f"/api/conversations/{self.cid}/message", {"content": original})
        task = runs.ACTIVE_RUNS[self.cid]["task"]
        await asyncio.wait_for(entered.wait(), 2)
        edit = {"content": original.replace("Wrong question", "Correct question\nSecond line"),
                "original_content": original, "expected_message_count": 4, "chat_model": "test/changed"}
        response = await self.request("PATCH", f"/api/conversations/{self.cid}/messages/2", edit)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(storage.get_conversation("alice", self.cid)["messages"][2]["content"], original)
        await self.request("POST", f"/api/conversations/{self.cid}/cancel")
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.last()["status"], "cancelled")

        self.query.side_effect = None
        response = await self.request("PATCH", f"/api/conversations/{self.cid}/messages/2", edit)
        self.assertEqual(response.status_code, 200, response.text)
        if self.cid in runs.ACTIVE_RUNS:
            await runs.ACTIVE_RUNS[self.cid]["task"]
        messages = storage.get_conversation("alice", self.cid)["messages"]
        self.assertEqual(len(messages), 4)
        self.assertEqual(messages[:2], prefix)
        self.assertEqual(messages[2]["content"], edit["content"])
        self.assertTrue(messages[2]["edited_at"])
        self.assertEqual(self.query.await_args.args[:2], ("test", "changed"))
        self.assertEqual(self.query.await_args.args[2], [
            {"role": "user", "content": "Earlier question"}, {"role": "assistant", "content": "Ответ"},
            {"role": "user", "content": edit["content"]}])
        self.assertEqual(self.last()["status"], "complete")

    async def test_editing_earlier_prompt_discards_later_exchanges_and_restarts_search_and_council(self):
        settings_store.save_settings("alice", ["test/member"], "test/chair", tavily_api_key="test-key")
        state = research.new_research(SearchSettings())
        state.update(status="complete", phase="done")
        self.search.return_value = (state, "")
        await self.send("Original", search_enabled=True, council_enabled=True)
        await self.send("Followup")
        next_state = research.new_research(SearchSettings())
        next_state.update(status="complete", phase="done")
        self.search.return_value = (next_state, "")
        response = await self.request("PATCH", f"/api/conversations/{self.cid}/messages/0", {
            "content": "Changed", "original_content": "Original", "expected_message_count": 4,
            "search_enabled": True, "council_enabled": True})
        self.assertEqual(response.status_code, 200, response.text)
        if self.cid in runs.ACTIVE_RUNS:
            await runs.ACTIVE_RUNS[self.cid]["task"]
        messages = storage.get_conversation("alice", self.cid)["messages"]
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["content"], "Changed")
        self.assertEqual(self.stage1.await_args.args[0], "Changed")
        self.assertEqual(self.search.await_count, 2)
        self.assertEqual(self.stage1.await_count, 2)
        self.assertEqual(self.stage2.await_count, 2)
        self.assertEqual(self.stage3.await_count, 2)
        self.assertEqual(self.last()["research"]["id"], next_state["id"])
        self.assertNotEqual(state["id"], next_state["id"])

    async def test_invalid_stale_and_foreign_edits_and_failed_start_preserve_the_conversation(self):
        await self.send("Original")
        before = storage.get_conversation("alice", self.cid)
        edit = {"content": "Changed", "original_content": "Original", "expected_message_count": 2}
        for index, changes, status in [
            (0, {"content": " "}, 400), (0, {"chat_model": "custom/missing"}, 400),
            (0, {"search_enabled": True}, 400), (0, {"original_content": "Stale"}, 409),
            (0, {"expected_message_count": 4}, 409), (1, {}, 400), (-1, {}, 400), (2, {}, 400),
        ]:
            response = await self.request("PATCH", f"/api/conversations/{self.cid}/messages/{index}", {**edit, **changes})
            self.assertEqual(response.status_code, status, response.text)
            self.assertEqual(storage.get_conversation("alice", self.cid), before)
        with patch.object(runs, "start", return_value=False):
            response = await self.request("PATCH", f"/api/conversations/{self.cid}/messages/0", edit)
            self.assertEqual(response.status_code, 409)
        self.assertEqual(storage.get_conversation("alice", self.cid), before)
        with patch.object(runs, "start", side_effect=RuntimeError("Start failed")):
            with self.assertRaisesRegex(RuntimeError, "Start failed"):
                await self.request("PATCH", f"/api/conversations/{self.cid}/messages/0", edit)
        self.assertEqual(storage.get_conversation("alice", self.cid), before)
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "bob"}
        response = await self.request("PATCH", f"/api/conversations/{self.cid}/messages/0", edit)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(storage.get_conversation("alice", self.cid), before)

    async def test_default_selection_is_user_scoped_and_preserves_search_credentials(self):
        search = SearchSettings(model="test/research", max_rounds=3)
        settings_store.save_settings("alice", ["test/member"], "test/chair", search, "private-key")
        response = await self.request("PATCH", "/api/settings", {"chat_model": "test/preferred"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["chat_model"], "test/preferred")
        self.assertEqual(settings_store.get_settings("alice")["search"], search.model_dump())
        self.assertEqual(settings_store.get_search_api_key("alice"), "private-key")
        self.assertNotIn("private-key", response.text)
        settings_store.save_settings("alice", ["test/member"], "test/chair")
        self.assertEqual(settings_store.get_settings("alice")["chat_model"], "test/preferred")
        self.assertNotEqual(settings_store.get_settings("bob")["chat_model"], "test/preferred")
        await self.send()
        self.assertEqual(self.query.await_args.args[:2], ("test", "preferred"))

    async def test_invalid_models_and_foreign_conversations_are_rejected_before_write(self):
        for options in [{"chat_model": ""}, {"chat_model": "custom/missing"},
                        {"council_enabled": True, "council_models": []},
                        {"council_enabled": True, "chairman_model": ""}]:
            response = await self.request("POST", f"/api/conversations/{self.cid}/message", {"content": "Question", **options})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(storage.get_conversation("alice", self.cid)["messages"], [])
        response = await self.request("PATCH", "/api/settings", {"chat_model": "custom/missing"})
        self.assertEqual(response.status_code, 400)
        main.app.dependency_overrides[auth.get_current_user] = lambda: {"id": "bob"}
        response = await self.request("POST", f"/api/conversations/{self.cid}/message", {"content": "Question"})
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
