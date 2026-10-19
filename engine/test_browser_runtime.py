import unittest
import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from unittest.mock import AsyncMock

from browser_runtime import AttachedBrowser, discover_browsers, resolve_runtime, validate_endpoint
from main import Handler


class RuntimeTests(unittest.TestCase):
    def test_loopback_only(self):
        self.assertEqual(validate_endpoint("http://127.0.0.1:9222"), ("127.0.0.1", 9222))
        for value in ("https://127.0.0.1:9222", "http://example.org:9222", "http://127.0.0.1", "http://user@localhost:9222", "http://localhost:9222/path", "http://localhost:9222?secret=1"):
            with self.assertRaises(ValueError):
                validate_endpoint(value)

    def test_catalog_is_explicit(self):
        self.assertEqual({item["id"] for item in discover_browsers()}, {"chrome", "edge", "brave", "chromium"})
        with self.assertRaises(ValueError):
            resolve_runtime({"id": "firefox"})
        with self.assertRaises(ValueError):
            resolve_runtime({"id": "custom", "path": "C:/Windows/System32/cmd.exe"})


class OwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_attached_browser_only_disconnects(self):
        browser = object.__new__(AttachedBrowser)
        connection = AsyncMock()
        target = AsyncMock()
        browser.connection = connection
        browser.targets = [target]
        await browser.stop()
        connection.send.assert_not_called()
        connection.aclose.assert_awaited_once()
        target.aclose.assert_awaited_once()


class HandlerTests(unittest.TestCase):
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

    def test_runtime_reads_body_before_configure(self):
        with patch("main.manager.configure", return_value={"connected": False}) as configure:
            status, _ = self.post("/api/browser/runtime", {"id": "edge"})
            self.assertEqual(status, 200)
            configure.assert_called_once_with({"id": "edge"})

    def test_targets_reads_body_and_excludes_non_page_targets(self):
        with patch("main.cdp_targets", return_value=[{"type": "page", "id": "page"}, {"type": "service_worker", "id": "worker"}]) as targets:
            status, result = self.post("/api/browser/targets", {"endpoint": "http://127.0.0.1:9222"})
            self.assertEqual(status, 200)
            self.assertEqual(len(result), 1)
            targets.assert_called_once_with("http://127.0.0.1:9222")

    def test_foreign_websites_cannot_switch_browsers(self):
        with patch("main.manager.configure") as configure:
            status, _ = self.post("/api/browser/runtime", {"id": "edge"}, "https://foreign.example")
            self.assertEqual(status, 403)
            configure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
