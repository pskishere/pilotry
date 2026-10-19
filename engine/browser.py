import asyncio
import json
import os
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse
import zendriver as uc
from browser_runtime import AttachedBrowser, DATA_DIR, discover_browsers, load_runtime, resolve_runtime, save_runtime, validate_endpoint


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


class BrowserManager:
    """Owns one visible zendriver/Chrome session on a dedicated asyncio loop."""

    SNAPSHOT_JS = """
    (() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
          && !!(el.offsetParent || el.getClientRects().length);
      };
      const buttons = Array.from(document.querySelectorAll(
        'button, a[href], [role="button"], input[type="submit"]'
      ))
        .filter(visible)
        .slice(0, 40)
        .map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
          id: el.id || '',
          cls: typeof el.className === 'string' ? el.className.slice(0, 180) : '',
          href: el.getAttribute('href') || '',
          disabled: Boolean(el.disabled),
          type: el.type || '',
          role: el.getAttribute('role') || '',
          formAction: el.form?.action || '',
        }));
      const forms = Array.from(document.querySelectorAll('form'))
        .filter((form) => visible(form) || Array.from(form.elements).some(visible))
        .slice(0, 20).map((form, index) => ({
        index,
        id: form.id || '',
        cls: typeof form.className === 'string' ? form.className.slice(0, 180) : '',
        action: form.action || '',
        fields: Array.from(form.querySelectorAll('input, select, textarea')).filter(visible).slice(0, 40).map((field) => ({
          tag: field.tagName.toLowerCase(),
          type: field.type || '',
          name: field.name || '',
          id: field.id || '',
          required: Boolean(field.required),
          disabled: Boolean(field.disabled),
        })),
      }));
      return { url: location.href, title: document.title, buttons, forms,
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
        self._runtime = {"label": "自動選擇", **self._configuration}
        self._commands = threading.RLock()

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
                raise ValueError("所選 CDP 分頁已關閉。")
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
            raw = {"url": self._tab.url or "", "title": "", "buttons": [], "forms": []}

        url = raw.get("url", self._tab.url or "")
        title = raw.get("title", "")
        buttons = raw.get("buttons", [])
        page_type, confidence = self._classify(url.lower(), title.lower(), buttons)
        return PageSnapshot(url, title, page_type, confidence, buttons, raw.get("forms", []), raw.get("text", ""))

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
        selector = f"[id={json.dumps(element_id)}]" if element_id else 'button, [role="button"], input[type="submit"]'
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
    def _classify(url: str, title: str, buttons: list[dict]) -> tuple[str, float]:
        text = " ".join(str(item.get("text", "")) for item in buttons).lower()
        if any(word in url for word in ["login", "signin", "auth"]):
            return "login", 0.92
        if any(word in url for word in ["payment", "checkout", "pay"]):
            return "payment", 0.95
        if any(word in text for word in ["验证码", "captcha"]):
            return "captcha", 0.88
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
                "title": "瀏覽器尚未啟動",
                "buttons": [],
                "forms": [],
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
                "title": "頁面讀取失敗",
                "buttons": [],
                "forms": [],
                "error": self._last_error,
            }

    def click_link(self, text: str, href: str) -> dict:
        before = self.state().get("url", "")
        clicked = self._call_on_loop(self._click_link(text, href), timeout=15)
        if not clicked:
            return {"success": False, "error": "無法唯一定位可見連結，請重新分析頁面。"}
        for _ in range(6):
            state = self.state()
            if state.get("url") and state["url"] != before:
                return {"success": True, "page": state}
            time.sleep(0.3)
        return {"success": False, "error": "已送出點選，但未觀察到頁面導覽，請確認目前頁面。", "page": state}

    def screenshot(self) -> str:
        if not self._tab:
            return ""
        return self._call_on_loop(self._tab.screenshot_b64(format="jpeg"), timeout=10)

    def extract(self, kind: str) -> dict:
        if kind not in {"text", "links", "tables"} or not self._tab:
            raise ValueError("請選擇文字、連結或表格資料。")
        raw = self._call_on_loop(self._tab.evaluate(self.EXTRACT_JS), timeout=12)
        records = [{"text": raw["text"]}] if kind == "text" else raw[kind]
        return {"success": True, "page": self.state(), "dataset": {"kind": kind, "url": raw["url"], "title": raw["title"], "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "records": records, "bounded": True}}

    def click_element(self, element_id: str, text: str) -> dict:
        before = self.state()
        clicked = self._call_on_loop(self._click_element(element_id, text), timeout=15)
        if not clicked:
            return {"success": False, "error": "無法唯一定位可見且啟用的按鈕，請重新分析。"}
        comparable = lambda page: (page.get("url"), page.get("title"), page.get("text"), page.get("buttons"))
        for _ in range(12):
            page = self.state()
            if comparable(page) != comparable(before):
                return {"success": True, **self.wait_for_page()}
            time.sleep(0.3)
        return {"success": False, "error": "已送出點選，但尚未觀察到頁面或控制項改變，請檢查目前畫面。", "page": page}

    def wait_for_page(self) -> dict:
        settled = self._call_on_loop(self._wait_for_page(), timeout=12)
        return {"settled": settled, "page": self.state()}

    def stop(self) -> None:
        if self.connected:
            self._call_on_loop(self.stop_async(), timeout=15)


manager = BrowserManager()
