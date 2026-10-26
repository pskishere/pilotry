import asyncio
import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlparse
import zendriver as uc
from browser_runtime import AttachedBrowser, DATA_DIR, discover_browsers, load_runtime, resolve_runtime, save_runtime, validate_endpoint


def compact_label(text: str) -> str:
    """快照文字与模型传入文字的统一比对形式：NFKC 折叠全角/半角差异并去除空白。"""
    return "".join(unicodedata.normalize("NFKC", str(text)).split())


SAFE_BROWSER_ARGS = [
    "--disable-animations",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-infobars",
    "--disable-notifications",
    "--disable-password-generation",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--disable-session-crashed-bubble",
    "--disable-sync",
    "--disable-translate",
    "--hide-crash-restore-bubble",
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
    "--lang=zh-CN",
]


@dataclass
class PageSnapshot:
    url: str
    title: str
    page_type: str
    confidence: float
    buttons: list[dict]
    forms: list[dict]
    text: str
    challenge: dict
    fingerprint: str


class BrowserManager:
    """Owns one visible zendriver/Chrome session on a dedicated asyncio loop."""

    SNAPSHOT_JS = """
    (() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
          && !!(el.offsetParent || el.getClientRects().length);
      };
      const interactive = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="link"], [role="option"], input[type="submit"], [onclick], [tabindex="0"]';
      const primary = Array.from(document.querySelectorAll(interactive)).filter(visible);
      // 大麦等站点用无 role 的 div 伪按钮（如 buy-link），靠 pointer 光标兜底识别，取最内层避免重复。
      let extras = Array.from(document.querySelectorAll('div, span, li'))
        .filter((el) => visible(el) && getComputedStyle(el).cursor === 'pointer'
          && !el.querySelector(interactive))
        .filter((el) => { const t = (el.innerText || '').trim(); return t.length > 0 && t.length <= 60; })
        .slice(0, 30);
      extras = extras.filter((el) => !extras.some((other) => other !== el && el.contains(other)));
      const buttons = [...primary, ...extras].slice(0, 90)
        .map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
          id: el.id || '',
          cls: typeof el.className === 'string' ? el.className.slice(0, 180) : '',
          href: el.href || el.getAttribute('href') || '',
          disabled: Boolean(el.disabled),
          type: el.type || '',
          role: el.getAttribute('role') || '',
          formAction: el.form?.action || '',
        }));
      const fieldInfo = (field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.type || '',
        name: field.name || '',
        id: field.id || '',
        placeholder: field.placeholder || '',
        ariaLabel: field.getAttribute('aria-label') || '',
        autocomplete: field.autocomplete || '',
        required: Boolean(field.required),
        disabled: Boolean(field.disabled),
      });
      const forms = Array.from(document.querySelectorAll('form'))
        .filter((form) => visible(form) || Array.from(form.elements).some(visible))
        .slice(0, 20).map((form, index) => ({
        index,
        id: form.id || '',
        cls: typeof form.className === 'string' ? form.className.slice(0, 180) : '',
        action: form.action || '',
        fields: Array.from(form.querySelectorAll('input, select, textarea')).filter(visible).slice(0, 40).map(fieldInfo),
      }));
      const fields = Array.from(document.querySelectorAll('input, select, textarea')).filter(visible).slice(0, 60).map(fieldInfo);
      return { url: location.href, title: document.title, buttons, forms, fields,
        text: (document.body?.innerText || '').slice(0, 8000) };
    })()
    """
    EXTRACT_JS = """
    (() => {
      const visible = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const tables = Array.from(document.querySelectorAll('table')).filter(visible).slice(0, 10);
      return {
        url: location.href, title: document.title,
        text: (document.body?.innerText || '').slice(0, 30000),
        links: Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 200)
          .filter(el => /^https?:/.test(el.href)).map(el => ({text: (el.innerText || el.getAttribute('aria-label') || '').trim(), url: el.href})),
        tables: tables.flatMap((table, index) => Array.from(table.rows).slice(0, 200)
          .map((row, rowIndex) => ({table: index + 1, row: rowIndex + 1, values: Array.from(row.cells).map(cell => cell.innerText.trim().slice(0, 2000))}))),
      };
    })()
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._browser: uc.Browser | None = None
        self._tab: uc.Tab | None = None
        self._last_error = ""
        self._configuration = load_runtime()
        self._runtime = {"label": "自动选择", **self._configuration}
        self._commands = threading.RLock()
        self._trusted: set[str] = set()

    @property
    def connected(self) -> bool:
        with self._lock:
            return self._browser is not None and self._tab is not None

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop and not self._loop.is_closed():
                return self._loop
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(
                target=self._loop.run_forever,
                name="pilotry-zendriver",
                daemon=True,
            )
            self._thread.start()
            return self._loop

    def _call_on_loop(self, coro, timeout: float):
        loop = self._ensure_loop()
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)

    async def _start(self, url: str) -> None:
        runtime = resolve_runtime(self._configuration)
        if runtime["id"] in {"cdp", "embedded"}:
            host, port = validate_endpoint(runtime["endpoint"])
            config = uc.Config(host=host, port=port)
            self._browser = await AttachedBrowser.create(config)
            self._tab = next((tab for tab in self._browser.tabs if str(tab.target_id) == runtime["targetId"]), None)
            if self._tab is None:
                await self.stop_async()
                raise ValueError("所选 CDP 分页已关闭。")
            self._runtime = runtime
            if url != "about:blank":
                await self._tab.get(url)
            return
        profile = DATA_DIR / "browser-profiles" / runtime["id"]
        profile.mkdir(parents=True, exist_ok=True)
        config = uc.Config(
            browser_args=SAFE_BROWSER_ARGS,
            sandbox=True,
            headless=False,
            browser_executable_path=runtime["path"],
            user_data_dir=str(profile),
        )
        self._browser = await uc.start(config)
        self._tab = await self._browser.get(url)
        self._runtime = runtime
        self._last_error = ""

    async def _open(self, url: str) -> None:
        if not self._browser or not self._tab:
            await self._start(url)
            return
        try:
            await self._tab.get(url)
            self._last_error = ""
        except Exception:
            await self.stop_async()
            await self._start(url)

    async def _snapshot(self) -> PageSnapshot:
        if not self._tab:
            raise RuntimeError("browser is not started")
        try:
            raw = await self._tab.evaluate(self.SNAPSHOT_JS)
            self._last_error = ""
        except Exception as exc:
            self._last_error = str(exc)
            raw = {"url": self._tab.url or "", "title": "", "buttons": [], "forms": [], "fields": []}

        url = raw.get("url", self._tab.url or "")
        title = raw.get("title", "")
        buttons = raw.get("buttons", [])
        forms = raw.get("forms", [])
        fields = raw.get("fields", [])
        text = raw.get("text", "")
        challenge = self._detect_challenge(url, title, text, forms, fields)
        page_type, confidence = self._classify(url.lower(), title.lower(), buttons, forms)
        fingerprint = hashlib.sha256(
            json.dumps([url, title, text[:6000], buttons[:20]], ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:32]
        return PageSnapshot(url, title, page_type, confidence, buttons, forms, text, challenge, fingerprint)

    async def _click_link(self, text: str, href: str) -> bool:
        if not self._tab:
            raise RuntimeError("browser is not started")
        nodes = await self._tab.select_all("a[href]", timeout=5)
        candidates = []
        wanted = " ".join(text.split()).casefold()
        for node in nodes:
            label = " ".join((node.text_all or node.attrs.get("aria-label", "")).split()).casefold()
            if node.attrs.get("href") == href and label == wanted:
                try:
                    position = await node.get_position()
                except Exception:
                    continue
                if position and position.width > 0 and position.height > 0:
                    candidates.append(node)
        if len(candidates) != 1:
            return False
        before_tabs = len(self._browser.tabs)
        await candidates[0].scroll_into_view()
        await candidates[0].mouse_click()
        await asyncio.sleep(0.7)
        if len(self._browser.tabs) > before_tabs:
            self._tab = self._browser.tabs[-1]
        return True

    async def _click_element(self, element_id: str, text: str) -> bool:
        if not self._tab:
            raise RuntimeError("browser is not started")
        selector = (
            f"[id={json.dumps(element_id)}]"
            if element_id
            else 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="link"], [role="option"], input[type="submit"], [onclick], [tabindex="0"]'
        )
        nodes = await self._tab.select_all(selector, timeout=5)
        candidates = []
        wanted = "".join(text.split()).casefold()
        for node in nodes:
            label = node.text_all or node.attrs.get("aria-label", "") or node.attrs.get("value", "")
            if "".join(label.split()).casefold() != wanted or "disabled" in node.attrs:
                continue
            try:
                position = await node.get_position()
            except Exception:
                continue
            if position and position.width > 0 and position.height > 0:
                candidates.append(node)
        if len(candidates) != 1:
            return False
        before_tabs = len(self._browser.tabs)
        await candidates[0].scroll_into_view()
        await candidates[0].mouse_click()
        await asyncio.sleep(0.7)
        if len(self._browser.tabs) > before_tabs:
            self._tab = self._browser.tabs[-1]
        return True

    async def _wait_for_page(self) -> bool:
        if not self._tab:
            return False
        previous = None
        stable = 0
        for _ in range(24):
            try:
                observation = await self._tab.evaluate("({ready: document.readyState === 'complete', title: document.title, text: (document.body?.innerText || '').slice(0, 2000)})")
                fingerprint = (observation.get("title"), observation.get("text"))
                stable = stable + 1 if fingerprint == previous and observation.get("ready") else 0
                previous = fingerprint
                if stable >= 3:
                    return True
            except Exception:
                stable = 0
            await asyncio.sleep(0.3)
        return False

    @staticmethod
    def _url_has_token(url_lower: str, tokens: tuple[str, ...]) -> bool:
        return any(
            re.search(rf"(?:^|[^a-z0-9]){re.escape(token)}(?:[^a-z0-9]|$)", url_lower)
            for token in tokens
        )

    @staticmethod
    def _detect_challenge(
        url: str,
        title: str,
        text: str,
        forms: list[dict],
        fields: list[dict] | None = None,
    ) -> dict:
        """Detect pages that genuinely need a human.

        Page-wide text alone is never enough: project lists and dashboards often
        contain words like "支付" or "提现" without being payment pages.
        """
        url_lower = url.lower()
        joined = (title + " " + text[:6000]).lower()
        all_fields = list(fields or []) + [
            field for form in (forms or []) for field in form.get("fields", [])
        ]

        def field_text(field: dict) -> str:
            return " ".join(
                str(field.get(key, ""))
                for key in (
                    "type",
                    "name",
                    "id",
                    "placeholder",
                    "ariaLabel",
                    "autocomplete",
                )
            ).lower()

        has_password = any(field.get("type") == "password" for field in all_fields)
        has_login_url = BrowserManager._url_has_token(
            url_lower, ("login", "signin", "sign-in", "auth")
        )
        has_payment_url = BrowserManager._url_has_token(
            url_lower, ("payment", "checkout", "pay")
        )
        code_field = any(
            any(
                token in field_text(field)
                for token in (
                    "captcha",
                    "verify",
                    "verification",
                    "code",
                    "otp",
                    "验证码",
                    "动态码",
                )
            )
            for field in all_fields
        )
        card_field = any(
            any(
                token in field_text(field)
                for token in ("card", "cvv", "cvc", "creditcard", "卡号", "安全码")
            )
            for field in all_fields
        )
        captcha_text = any(
            token in joined
            for token in ("验证码", "captcha", "人机验证", "安全验证", "图形验证")
        )
        two_factor_text = any(
            token in joined
            for token in (
                "两步验证",
                "双因素",
                "2fa",
                "authenticator",
                "动态码",
                "短信验证码",
                "身份验证器",
            )
        )
        captcha_hint = code_field and captcha_text
        two_factor_hint = code_field and two_factor_text
        payment_hint = has_payment_url or card_field

        evidence = []
        if has_password:
            evidence.append("password_field")
        if has_login_url:
            evidence.append("login_url")
        if code_field:
            evidence.append("code_field")
        if captcha_text:
            evidence.append("captcha_text")
        if two_factor_text:
            evidence.append("two_factor_text")
        if has_payment_url:
            evidence.append("payment_url")
        if card_field:
            evidence.append("card_field")
        if two_factor_hint:
            challenge_type = "2fa"
        elif has_password or has_login_url:
            challenge_type = "login"
        elif captcha_hint:
            challenge_type = "captcha"
        elif payment_hint:
            challenge_type = "payment"
        else:
            challenge_type = "none"
        return {"type": challenge_type, "evidence": evidence}

    @staticmethod
    def _classify(url: str, title: str, buttons: list[dict], forms: list[dict] | None = None) -> tuple[str, float]:
        fields = [field for form in (forms or []) for field in form.get("fields", [])]
        if any(field.get("type") == "password" for field in fields):
            return "login", 0.95
        text = " ".join(str(item.get("text", "")) for item in buttons).lower()
        if BrowserManager._url_has_token(url, ("login", "signin", "sign-in", "auth")):
            return "login", 0.92
        if BrowserManager._url_has_token(url, ("payment", "checkout", "pay")):
            return "payment", 0.95
        if "/performance" in url or any(word in text for word in ["场次", "选择场次"]):
            return "performance", 0.88
        if "/area" in url or any(word in text for word in ["票档", "价格", "区域"]):
            return "area", 0.84
        if "/ticket/" in url or any(word in text for word in ["张数", "购票张数", "同意"]):
            return "ticket", 0.86
        if any(word in url for word in ["activity", "eventdetail", "event/", "show"]) or any(
            word in text for word in ["立即购买", "立即购票", "buy ticket", "find tickets"]
        ):
            return "event_detail", 0.82
        if url in {"about:blank", "chrome://new-tab-page", "chrome://newtab/"}:
            return "home", 0.98
        if title:
            return "unknown", 0.35
        return "unknown", 0.1

    async def stop_async(self) -> None:
        browser = self._browser
        self._browser = None
        self._tab = None
        if browser:
            try:
                await browser.stop()
            except Exception as exc:
                self._last_error = str(exc)

    @staticmethod
    def _validate_url(url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("only http(s) URLs are allowed")

    def start(self, url: str = "about:blank") -> dict:
        self._validate_url(url)
        self._call_on_loop(self._start(url), timeout=45)
        return self.state()

    def open(self, url: str) -> dict:
        self._validate_url(url)
        with self._commands:
            if not self.connected:
                return self.start(url)
            self._call_on_loop(self._open(url), timeout=30)
            return self.state()

    def runtime(self) -> dict:
        return {"current": {"id": self._runtime["id"], "label": self._runtime["label"], "mode": "embedded" if self._runtime["id"] == "embedded" else "external", "endpoint": self._runtime.get("endpoint", "")}, "browsers": discover_browsers()}

    def configure(self, configuration: dict) -> dict:
        resolved = resolve_runtime(configuration)
        with self._commands:
            self.stop()
            self._configuration = resolved
            self._runtime = resolved
            try:
                self._call_on_loop(self._start("about:blank"), timeout=45)
                save_runtime(resolved)
            except Exception as exc:
                self._last_error = str(exc)
                self.stop()
                raise
            return self.state()

    def state(self) -> dict:
        if not self.connected:
            return {
                "connected": False,
                "runtime": {"id": self._runtime["id"], "label": self._runtime["label"], "mode": "embedded" if self._runtime["id"] == "embedded" else "external", "endpoint": self._runtime.get("endpoint", "")},
                "url": "",
                "pageType": "offline",
                "confidence": 0.0,
                "title": "浏览器尚未启动",
                "buttons": [],
                "forms": [],
                "challenge": {"type": "none", "evidence": []},
                "fingerprint": "",
                "error": self._last_error,
            }

        try:
            snapshot = self._call_on_loop(self._snapshot(), timeout=8)
            return {
                "connected": True,
                "runtime": {"id": self._runtime["id"], "label": self._runtime["label"], "mode": "embedded" if self._runtime["id"] == "embedded" else "external", "endpoint": self._runtime.get("endpoint", "")},
                "url": snapshot.url,
                "pageType": snapshot.page_type,
                "confidence": snapshot.confidence,
                "title": snapshot.title,
                "buttons": snapshot.buttons,
                "forms": snapshot.forms,
                "text": snapshot.text,
                "challenge": snapshot.challenge,
                "fingerprint": snapshot.fingerprint,
                "error": self._last_error,
            }
        except Exception as exc:
            self._last_error = str(exc)
            return {
                "connected": True,
                "runtime": {"id": self._runtime["id"], "label": self._runtime["label"], "mode": "embedded" if self._runtime["id"] == "embedded" else "external", "endpoint": self._runtime.get("endpoint", "")},
                "url": "",
                "pageType": "unknown",
                "confidence": 0.0,
                "title": "页面读取失败",
                "buttons": [],
                "forms": [],
                "challenge": {"type": "none", "evidence": []},
                "fingerprint": "",
                "error": self._last_error,
            }

    def human_status(self) -> dict:
        state = self.state()
        challenge = state.get("challenge") or {"type": "none", "evidence": []}
        url = state.get("url", "")
        trusted = self.is_trusted(url)
        needs_human = challenge.get("type") in {"login", "captcha", "2fa", "payment"} and not trusted
        return {
            "connected": state.get("connected", False),
            "url": url,
            "title": state.get("title", ""),
            "pageType": state.get("pageType", "offline"),
            "challenge": challenge,
            "fingerprint": state.get("fingerprint", ""),
            "loggedIn": "no" if challenge.get("type") in {"login", "captcha", "2fa"} else "unknown",
            "needsHuman": needs_human,
            "trusted": trusted,
            "error": state.get("error", ""),
        }

    def is_trusted(self, url: str) -> bool:
        if not url:
            return False
        with self._lock:
            return str(url).strip() in self._trusted

    def trust(self, url: str, trusted: bool = True) -> dict:
        key = str(url or "").strip()
        if not key:
            raise ValueError("请提供当前页面网址。")
        with self._lock:
            if trusted:
                self._trusted.add(key)
            else:
                self._trusted.discard(key)
            return {
                "url": key,
                "trusted": trusted,
                "trustedUrls": sorted(self._trusted),
            }

    def click_link(self, text: str, href: str) -> dict:
        before = self.state().get("url", "")
        clicked = self._call_on_loop(self._click_link(text, href), timeout=15)
        if not clicked:
            return {"success": False, "error": "无法唯一定位可见链接，请重新分析页面。"}
        for _ in range(6):
            state = self.state()
            if state.get("url") and state["url"] != before:
                return {"success": True, "page": state}
            time.sleep(0.3)
        return {"success": False, "error": "已送出点选，但未观察到页面导航，请确认目前页面。", "page": state}

    def screenshot(self) -> str:
        if not self._tab:
            return ""
        return self._call_on_loop(self._tab.screenshot_b64(format="jpeg"), timeout=10)

    def extract(self, kind: str) -> dict:
        if kind not in {"text", "links", "tables"} or not self._tab:
            raise ValueError("请选择文字、链接或表格数据。")
        raw = self._call_on_loop(self._tab.evaluate(self.EXTRACT_JS), timeout=12)
        records = [{"text": raw["text"]}] if kind == "text" else raw[kind]
        return {"success": True, "page": self.state(), "dataset": {"kind": kind, "url": raw["url"], "title": raw["title"], "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "records": records, "bounded": True}}

    def click_element(self, element_id: str, text: str) -> dict:
        before = self.state()
        clicked = self._call_on_loop(self._click_element(element_id, text), timeout=15)
        if not clicked:
            return {"success": False, "error": "无法唯一定位可见且启用的按钮，请重新分析。"}
        comparable = lambda page: (page.get("url"), page.get("title"), page.get("text"), page.get("buttons"))
        for _ in range(12):
            page = self.state()
            if comparable(page) != comparable(before):
                return {"success": True, **self.wait_for_page()}
            time.sleep(0.3)
        return {"success": False, "error": "已送出点选，但尚未观察到页面或控制项改变，请检查目前画面。", "page": page}

    def wait_for_page(self) -> dict:
        settled = self._call_on_loop(self._wait_for_page(), timeout=12)
        return {"settled": settled, "page": self.state()}

    def stop(self) -> None:
        if self.connected:
            self._call_on_loop(self.stop_async(), timeout=15)


manager = BrowserManager()
