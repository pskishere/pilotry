import unittest
import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

from langchain_core.messages import HumanMessage, SystemMessage

from main import Handler
from magpie import MagpieClient, MagpieConfig

CONFIG = MagpieConfig(base_url="http://127.0.0.1:3425/v1", model="zhipu/glm-5.3-flash", token="magpie", timeout_seconds=45.0)


class StatusTests(unittest.TestCase):
    def test_available_model_reports_gateway_models(self):
        client = MagpieClient(CONFIG)
        sdk = MagicMock()
        sdk.models.list.return_value = [MagicMock(id="zhipu/glm-5.3-flash"), MagicMock(id="other/model")]
        with patch.object(client, "_sdk", return_value=sdk):
            status = client.status(force=True)
        self.assertEqual(status, {"provider": "magpie", "available": True, "model": "zhipu/glm-5.3-flash", "models": ["zhipu/glm-5.3-flash", "other/model"], "error": ""})

    def test_missing_model_is_reported_not_available(self):
        client = MagpieClient(CONFIG)
        sdk = MagicMock()
        sdk.models.list.return_value = [MagicMock(id="other/model")]
        with patch.object(client, "_sdk", return_value=sdk):
            status = client.status(force=True)
        self.assertFalse(status["available"])
        self.assertEqual(status["error"], "model not found: zhipu/glm-5.3-flash")

    def test_status_is_cached_until_forced(self):
        client = MagpieClient(CONFIG)
        sdk = MagicMock()
        sdk.models.list.return_value = []
        with patch.object(client, "_sdk", return_value=sdk) as factory:
            client.status()
            client.status()
            client.status(force=True)
        self.assertEqual(factory.call_count, 2)

    def test_gateway_failure_is_reported_and_cached(self):
        client = MagpieClient(CONFIG)
        with patch.object(client, "_sdk", side_effect=OSError("connection refused")) as factory:
            status = client.status()
            again = client.status()
        self.assertFalse(status["available"])
        self.assertIn("connection refused", status["error"])
        self.assertEqual(status, again)
        self.assertEqual(factory.call_count, 1)


class AskTests(unittest.TestCase):
    def test_ask_builds_system_then_human_and_strips_reply(self):
        client = MagpieClient(CONFIG)
        chain = MagicMock()
        chain.invoke.return_value = "  这是回答。  "
        model = MagicMock()
        model.__or__.return_value = chain
        with patch.object(client, "_chat_model", return_value=model):
            text = client.ask("帮我总结页面", system="你是浏览助手")
        self.assertEqual(text, "这是回答。")
        messages = chain.invoke.call_args.args[0]
        self.assertIsInstance(messages[0], SystemMessage)
        self.assertEqual(messages[0].content, "你是浏览助手")
        self.assertIsInstance(messages[1], HumanMessage)
        self.assertEqual(messages[1].content, "帮我总结页面")

    def test_ask_without_system_sends_single_message(self):
        client = MagpieClient(CONFIG)
        chain = MagicMock()
        chain.invoke.return_value = "ok"
        model = MagicMock()
        model.__or__.return_value = chain
        with patch.object(client, "_chat_model", return_value=model):
            text = client.ask("你好")
        self.assertEqual(text, "ok")
        messages = chain.invoke.call_args.args[0]
        self.assertEqual([type(message) for message in messages], [HumanMessage])


class AskEndpointTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def post(self, path, body, origin=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port)
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        connection.request("POST", path, json.dumps(body), headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_ask_returns_model_text(self):
        with patch("main.magpie.ask", return_value="答案") as ask:
            status, result = self.post("/api/ai/ask", {"prompt": "问题", "system": "你是助手"}, "http://127.0.0.1:1420")
        self.assertEqual(status, 200)
        self.assertEqual(result, {"text": "答案"})
        ask.assert_called_once_with("问题", "你是助手")

    def test_ask_rejects_blank_or_oversized_prompt(self):
        with patch("main.magpie.ask") as ask:
            status, _ = self.post("/api/ai/ask", {"prompt": "   "})
            self.assertEqual(status, 400)
            status, _ = self.post("/api/ai/ask", {"prompt": "x" * 12001})
            self.assertEqual(status, 400)
        ask.assert_not_called()

    def test_ask_reports_gateway_failure(self):
        with patch("main.magpie.ask", side_effect=RuntimeError("gateway down")):
            status, result = self.post("/api/ai/ask", {"prompt": "问题"})
        self.assertEqual(status, 503)
        self.assertIn("AI 请求失败", result["error"])


if __name__ == "__main__":
    unittest.main()
