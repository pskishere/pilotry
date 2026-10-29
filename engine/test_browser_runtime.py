import unittest
import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch
from unittest.mock import AsyncMock

from browser import BrowserManager
from browser_runtime import AttachedBrowser, discover_browsers, resolve_runtime, validate_endpoint
import main
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


class RowClickTests(unittest.TestCase):
    """main.py click_element 的行内匹配：rowText/rowIndex 过滤同名按钮。"""

    PAGE = {
        "connected": True,
        "url": "http://vm/team-setup",
        "pageType": "unknown",
        "challenge": {"type": "none", "evidence": []},
        "buttons": [
            {"text": "操作", "tag": "button", "id": "", "href": "", "disabled": False, "rowText": "星际舰队 2026 vmAdmin", "rowIndex": 0},
            {"text": "操作", "tag": "button", "id": "", "href": "", "disabled": False, "rowText": "123车队 2026 vmAdmin", "rowIndex": 1},
            {"text": "操作", "tag": "button", "id": "", "href": "", "disabled": False, "rowText": "中国队 2022 vmAdmin", "rowIndex": 2},
        ],
    }

    def click(self, page, args):
        manager = MagicMock()
        with patch.object(main.manager, "state", return_value=page), patch.object(main.manager, "click_element", return_value={"success": True}) as click:
            result = main.execute_agent_action("click_element", args)
        return result, click

    def test_row_text_disambiguates_same_name_buttons(self):
        result, click = self.click(self.PAGE, {"id": "", "text": "操作", "snapshotUrl": "http://vm/team-setup", "rowText": "123车队"})
        self.assertEqual(result, {"success": True})
        self.assertEqual(click.call_args.kwargs["row"]["rowIndex"], 1)

    def test_row_index_selects_the_third_row(self):
        result, click = self.click(self.PAGE, {"id": "", "text": "操作", "snapshotUrl": "http://vm/team-setup", "rowIndex": 2})
        self.assertEqual(result, {"success": True})
        self.assertEqual(click.call_args.kwargs["row"]["rowIndex"], 2)

    def test_row_match_failure_returns_row_candidates(self):
        result, click = self.click(self.PAGE, {"id": "", "text": "操作", "snapshotUrl": "http://vm/team-setup", "rowText": "不存在的行"})
        self.assertFalse(result["success"])
        self.assertEqual(len(result["rows"]), 3)
        self.assertEqual(result["rows"][1]["rowText"].split(" ")[0], "123车队")
        click.assert_not_called()

    def test_unique_text_without_row_still_works(self):
        page = dict(self.PAGE)
        page["buttons"] = [{"text": "唯一按钮", "tag": "button", "id": "", "href": "", "disabled": False}]
        result, click = self.click(page, {"id": "", "text": "唯一按钮", "snapshotUrl": "http://vm/team-setup"})
        self.assertEqual(result, {"success": True})
        click.assert_called_once()


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
