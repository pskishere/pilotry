import unittest
import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from unittest.mock import AsyncMock

from browser import BrowserManager
from browser_runtime import AttachedBrowser, discover_browsers, resolve_runtime, validate_endpoint
from main import Handler, page_needs_human


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

    def test_trust_endpoint_accepts_the_current_page(self):
        with patch("main.manager.trust", return_value={"url": "http://localhost/page", "trusted": True, "trustedUrls": ["http://localhost/page"]}) as trust:
            status, result = self.post("/api/human/trust", {"url": "http://localhost/page", "trusted": True}, "http://127.0.0.1:1420")
            self.assertEqual(status, 200)
            self.assertTrue(result["trusted"])
            trust.assert_called_once_with("http://localhost/page", True)


class ChallengeTests(unittest.TestCase):
    def test_password_field_is_login_even_without_login_url(self):
        forms = [{"fields": [{"type": "password"}]}]
        challenge = BrowserManager._detect_challenge("https://example.org/account", "账户", "", forms)
        self.assertEqual(challenge["type"], "login")
        self.assertIn("password_field", challenge["evidence"])
        self.assertEqual(BrowserManager._classify("https://example.org/account", "账户", [], forms)[0], "login")

    def test_captcha_needs_a_code_field_and_text(self):
        fields = [{"type": "text", "placeholder": "请输入验证码"}]
        challenge = BrowserManager._detect_challenge("https://example.org/verify", "安全验证", "请输入验证码", [], fields)
        self.assertEqual(challenge["type"], "captcha")
        self.assertIn("code_field", challenge["evidence"])
        text_only = BrowserManager._detect_challenge("https://example.org/help", "帮助", "什么是验证码？", [], [])
        self.assertEqual(text_only["type"], "none")

    def test_two_factor_takes_precedence(self):
        fields = [{"type": "text", "placeholder": "动态码"}]
        challenge = BrowserManager._detect_challenge("https://example.org/verify", "两步验证", "请输入动态码", [], fields)
        self.assertEqual(challenge["type"], "2fa")

    def test_payment_words_alone_do_not_block_a_normal_page(self):
        challenge = BrowserManager._detect_challenge(
            "http://nezha.example/#/projectManageNew/projectDeployList",
            "项目管理",
            "项目列表 支付中心 余额提现 订单确认",
            [],
            [{"type": "text", "name": "keyword"}],
        )
        self.assertEqual(challenge["type"], "none")
        self.assertEqual(challenge["evidence"], [])

    def test_payment_form_field_is_detected(self):
        fields = [{"type": "text", "name": "cardNumber", "autocomplete": "cc-number"}]
        challenge = BrowserManager._detect_challenge("https://shop.example.org/cashier", "收银台", "", [], fields)
        self.assertEqual(challenge["type"], "payment")
        self.assertIn("card_field", challenge["evidence"])

    def test_payment_url_is_detected(self):
        challenge = BrowserManager._detect_challenge("https://shop.example.org/checkout", "Checkout", "", [])
        self.assertEqual(challenge["type"], "payment")

    def test_normal_page_has_no_challenge(self):
        challenge = BrowserManager._detect_challenge("https://example.org/article", "Article", "普通内容", [])
        self.assertEqual(challenge["type"], "none")
        self.assertEqual(challenge["evidence"], [])

    def test_sensitive_pages_need_human(self):
        self.assertTrue(page_needs_human({"pageType": "login"}))
        self.assertTrue(page_needs_human({"pageType": "unknown", "challenge": {"type": "2fa"}}))
        self.assertFalse(page_needs_human({"pageType": "event_detail", "challenge": {"type": "none"}}))

    def test_trusted_page_bypasses_human_gate(self):
        with patch("main.manager.is_trusted", return_value=True):
            self.assertFalse(page_needs_human({"url": "http://localhost/page", "pageType": "login"}))


if __name__ == "__main__":
    unittest.main()
