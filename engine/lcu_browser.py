import hashlib
import json
import threading
import time

from browser import BrowserManager, compact_label
from lcu_bridge import LcuClient, LcuError, lcu_available


SENSITIVE_CHALLENGES = {"login", "captcha", "2fa", "payment"}


def _comparable(page: dict) -> tuple:
    return (
        page.get("url"),
        page.get("title"),
        page.get("text"),
        page.get("buttons"),
    )


class LcuBrowserManager:
    """Browser backend that drives the user's real Chrome through LCU.

    LCU exposes the Chrome tab through its official extension. Pilotry keeps
    one long-lived MCP process, so the selected tab binding survives across
    engine calls and the user's existing login cookies are reused. Tabs are
    fully managed: stale tabs from previous sessions are swept at startup,
    a dead binding is rebuilt transparently on the next call, and the tab
    is closed when the engine stops.
    """

    SESSION_NAME = "🤖 Pilotry"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._client: LcuClient | None = None
        self._tab_ready = False
        self._last_error = ""
        self._trusted: set[str] = set()
        self._startup_swept = False
        self._runtime = {
            "id": "lcu",
            "label": "本机 Chrome（LCU）",
            "mode": "external",
            "endpoint": "",
        }

    # ---- process / tab lifecycle -------------------------------------------------

    _validate_url = staticmethod(BrowserManager._validate_url)

    @property
    def driver_name(self) -> str:
        return "lcu"

    @property
    def connected(self) -> bool:
        with self._lock:
            return bool(
                self._tab_ready
                and self._client
                and self._client.alive
            )

    def _ensure_client(self) -> None:
        with self._lock:
            if self._client and self._client.alive:
                if not self._startup_swept:
                    self._startup_swept = True
                    self._sweep_stale_tabs()
                return
            if self._client:
                self._client.stop()
            if not lcu_available():
                raise LcuError("未找到 LCU，请先安装 LCU。")
            client = LcuClient()
            client.start()
            try:
                client.call_js("await cua.getState();", "初始化 LCU", timeout=45)
            except Exception:
                client.stop()
                raise
            self._client = client
            self._tab_ready = False
            if not self._startup_swept:
                self._startup_swept = True
                self._sweep_stale_tabs()

    def _sweep_stale_tabs(self) -> None:
        """关闭上一个 Pilotry 会话遗留的标签页（会话隔离下只能在新会话里试）。"""
        assert self._client is not None
        try:
            result = self._client.call_js(
                "const tabs = await cua.listTabs();"
                'nodeRepl.write("PILOTRY:" + JSON.stringify(tabs.map(t => ({ id: t.id, title: t.title || "" }))));',
                "检查遗留标签页",
                timeout=30,
            )
            if result["isError"]:
                return
            tabs = []
            for text in result["texts"]:
                index = text.find("PILOTRY:")
                if index >= 0:
                    tabs = json.loads(text[index + 8:].strip())
                    break
            closed = 0
            for tab in tabs:
                # 会话隔离下新会话关不掉旧会话的标签页，但值得尝试；失败即忽略。
                try:
                    self._client.call_js(
                        "const tab = await cua.getTab(%s);\nawait tab.close();"
                        % json.dumps(tab["id"]),
                        "清理遗留标签页",
                        timeout=15,
                    )
                    closed += 1
                except LcuError:
                    continue
            if closed:
                print(f"Pilotry LCU: 清理了 {closed} 个遗留标签页", flush=True)
        except Exception:
            # 启动清理失败不影响引擎可用性。
            pass

    def _js(self, code: str, title: str, timeout: float = 60) -> dict:
        self._ensure_client()
        assert self._client is not None
        try:
            result = self._client.call_js(code, title, timeout=timeout)
        except LcuError as exc:
            self._last_error = str(exc)
            raise
        if result["isError"]:
            message = " ".join(text for text in result["texts"] if text.strip())
            self._last_error = message or "LCU 操作失败。"
            # 标签页绑定失效（Chrome 重启/标签页被关/会话失效）→ 重建绑定后由调用方重试。
            if "not part of browser session" in message or "Browser is not available" in message:
                with self._lock:
                    self._tab_ready = False
                    if self._client:
                        self._client.stop()
                    self._client = None
            raise LcuError(self._last_error)
        self._last_error = ""
        return result

    def _eval(self, expression: str, arg=None, timeout: float = 25):
        code = (
            'nodeRepl.write("PILOTRY:" + JSON.stringify(await tab.playwright.evaluate(%s, %s, { timeoutMs: %d })));'
            % (json.dumps(expression), json.dumps(arg), int(timeout * 1000))
        )
        result = self._js(code, "读取页面", timeout=timeout + 10)
        marker = "PILOTRY:"
        for text in result["texts"]:
            index = text.find(marker)
            if index >= 0:
                return json.loads(text[index + len(marker):].strip())
        raise LcuError("LCU 没有返回页面数据。")

    def _create_tab(self, url: str) -> None:
        code = (
            'let tab = await cua.createBrowserTab("chrome", %s, { sessionName: %s });'
            % (json.dumps(url), json.dumps(self.SESSION_NAME))
        )
        self._js(code, "在 Chrome 中打开页面", timeout=60)
        self._tab_ready = True
        try:
            self._js(
                'await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15000 });',
                "等待页面加载",
                timeout=25,
            )
        except LcuError:
            pass

    def _open(self, url: str) -> dict:
        BrowserManager._validate_url(url)
        with self._lock:
            self._ensure_client()
            if not self._tab_ready:
                self._create_tab(url)
            else:
                try:
                    self._js(
                        'await tab.goto(%s); await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15000 });'
                        % json.dumps(url),
                        "打开页面",
                        timeout=45,
                    )
                except LcuError:
                    # 绑定失效（Chrome 重启/标签页被关）：重建会话与标签页再试一次。
                    self._tab_ready = False
                    self._ensure_client()
                    self._create_tab(url)
            time.sleep(0.35)
            return self.state()

    def recover(self) -> dict:
        """检查并自动重建失效的标签页绑定；返回恢复后的页面状态。"""
        with self._lock:
            if self.connected:
                return self.state()
            self._ensure_client()
            if not self._tab_ready:
                self._create_tab("about:blank")
            return self.state()

    def release(self) -> dict:
        """任务结束即关闭受控标签页（保留 LCU 会话，下次操作自动开新页）。"""
        with self._lock:
            closed = False
            if self._tab_ready and self._client and self._client.alive:
                try:
                    self._client.call_js("await tab.close();", "任务结束关闭标签页", timeout=10)
                    closed = True
                except Exception:
                    pass
            self._tab_ready = False
            return {"released": True, "closed": closed}

    # ---- public browser API ------------------------------------------------------

    def open(self, url: str) -> dict:
        return self._open(url)

    def start(self, url: str = "about:blank") -> dict:
        return self._open(url)

    def stop(self) -> None:
        with self._lock:
            if self._tab_ready and self._client and self._client.alive:
                try:
                    self._client.call_js("await tab.close();", "关闭 LCU 标签页", timeout=10)
                except Exception:
                    pass
            self._tab_ready = False
            if self._client:
                self._client.stop()
            self._client = None

    def runtime(self) -> dict:
        return {
            "current": dict(self._runtime),
            "browsers": [
                {
                    "id": "lcu",
                    "label": "本机 Chrome（LCU）",
                    "available": lcu_available(),
                    "path": "",
                }
            ],
        }

    def configure(self, configuration: dict) -> dict:
        key = str((configuration or {}).get("id", "lcu"))
        if key not in {"lcu", "auto"}:
            raise ValueError("目前使用 LCU 本机 Chrome 后端；如需切换请设置 PILOTRY_BROWSER_BACKEND=zendriver。")
        return self.state()

    # ---- page observation --------------------------------------------------------

    def _offline(self, error: str = "") -> dict:
        return {
            "connected": False,
            "runtime": dict(self._runtime),
            "url": "",
            "pageType": "offline",
            "confidence": 0.0,
            "title": "浏览器尚未启动",
            "buttons": [],
            "forms": [],
            "challenge": {"type": "none", "evidence": []},
            "fingerprint": "",
            "error": error or self._last_error,
        }

    def state(self) -> dict:
        with self._lock:
            if not self._tab_ready or not self._client or not self._client.alive:
                return self._offline()
            try:
                raw = self._eval(BrowserManager.SNAPSHOT_JS)
            except LcuError as exc:
                self._tab_ready = False
                return self._offline(str(exc))
            url = str(raw.get("url", ""))
            title = str(raw.get("title", ""))
            buttons = raw.get("buttons", [])
            forms = raw.get("forms", [])
            fields = raw.get("fields", [])
            text = raw.get("text", "")
            challenge = BrowserManager._detect_challenge(url, title, text, forms, fields)
            page_type, confidence = BrowserManager._classify(
                url.lower(), title.lower(), buttons, forms
            )
            fingerprint = hashlib.sha256(
                json.dumps(
                    [url, title, text[:6000], buttons[:20]],
                    ensure_ascii=False,
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest()[:32]
            return {
                "connected": True,
                "runtime": dict(self._runtime),
                "url": url,
                "pageType": page_type,
                "confidence": confidence,
                "title": title,
                "buttons": buttons,
                "forms": forms,
                "text": text,
                "challenge": challenge,
                "fingerprint": fingerprint,
                "error": "",
            }

    def human_status(self) -> dict:
        state = self.state()
        challenge = state.get("challenge") or {"type": "none", "evidence": []}
        url = state.get("url", "")
        trusted = self.is_trusted(url)
        needs_human = challenge.get("type") in SENSITIVE_CHALLENGES and not trusted
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

    def screenshot(self) -> dict:
        with self._lock:
            if not self._tab_ready or not self._client or not self._client.alive:
                return {"data": "", "mime": "image/png"}
            try:
                result = self._js(
                    'let data = await tab.screenshot({}); nodeRepl.emitImage(data);',
                    "截取浏览器画面",
                    timeout=30,
                )
            except LcuError:
                return {"data": "", "mime": "image/png"}
            for image in result["images"]:
                data = image.get("data", "")
                if data:
                    return {
                        "data": data,
                        "mime": image.get("mimeType") or "image/png",
                    }
            return {"data": "", "mime": "image/png"}

    # ---- clicks ------------------------------------------------------------------

    def _wait_changed(self, before: dict, timeout: float = 12) -> dict | None:
        """点击后等待页面变化；大麦等站点的异步弹层可能要近十秒才渲染。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.3)
            page = self.state()
            if not page.get("connected"):
                return None
            if _comparable(page) != _comparable(before):
                return page
        return None

    def _click_locator(self, locator: str) -> tuple[bool, str]:
        # inTableRow(rowNth(n)|rowWithText(t), targetText) 把点击收窄到某一行内的目标按钮。
        row_scope = ""
        target_text = ""
        if locator.startswith("inTableRow("):
            inner = locator[len("inTableRow("):-1]
            row_scope, target_text = inner.split(", ", 1)
            target_text = json.loads(target_text)
        if row_scope:
            # 行内点击全部走 Playwright 原生 API：evaluate 沙箱剥 DOM 方法（无 click、
            # 无 MouseEvent），locator() 也只收选择器字符串——行内目标必须用
            # row.getByRole(...) 这类挂在行 locator 上的工厂方法。
            # 行取 .last()：容器（如 rs-table-body-row-wrapper）与行同名 class 嵌套时，最深者才是行。
            row_selector = 'tr, [role="row"], li, div[class*="row"], div[class*="popover"], div[class*="dropdown"], div[class*="menu"], div[class*="drawer"], div[class*="overlay"]'
            # 行内目标优先 getByRole(button)；组件库菜单项多为 span/li 无 button role，退化 getByText。
            target_json = json.dumps(target_text)
            if row_scope.startswith("rowNth("):
                nth = row_scope[len("rowNth("):-1]
                code = (
                    "let rows = tab.playwright.locator(%s);\n"
                    "let total = await rows.count();\n"
                    "if (total <= %s) { nodeRepl.write(\"PILOTRY:ROW:\" + total); }\n"
                    "else {\n"
                    "  let row = rows.nth(%s);\n"
                    "  let btn = row.getByRole(\"button\", { name: %s, exact: true });\n"
                    "  let count = await btn.filter({ visible: true }).count();\n"
                    "  if (count !== 1) { btn = row.getByText(%s, { exact: true }); count = await btn.filter({ visible: true }).count(); }\n"
                    "  if (count !== 1) { nodeRepl.write(\"PILOTRY:COUNT:\" + count); }\n"
                    "  else { await btn.first().click({ timeoutMs: 8000 }); nodeRepl.write(\"PILOTRY:OK\"); }\n"
                    "}\n" % (json.dumps(row_selector), nth, nth, target_json, target_json)
                )
            else:
                text_json = row_scope[len("rowWithText("):-1]
                code = (
                    "let rows = tab.playwright.locator(%s).filter({ hasText: %s });\n"
                    "let total = await rows.count();\n"
                    "if (total === 0) { nodeRepl.write(\"PILOTRY:ROW:0\"); }\n"
                    "else {\n"
                    "  let row = rows.last();\n"
                    "  let btn = row.getByRole(\"button\", { name: %s, exact: true });\n"
                    "  let count = await btn.filter({ visible: true }).count();\n"
                    "  if (count !== 1) { btn = row.getByText(%s, { exact: true }); count = await btn.filter({ visible: true }).count(); }\n"
                    "  if (count !== 1) { nodeRepl.write(\"PILOTRY:COUNT:\" + count); }\n"
                    "  else { await btn.first().click({ timeoutMs: 8000 }); nodeRepl.write(\"PILOTRY:OK\"); }\n"
                    "}\n" % (json.dumps(row_selector), text_json, target_json, target_json)
                )
        else:
            code = (
                "let loc = %s;\n" % locator
                + "let visible = loc.filter({ visible: true });\n"
                + "let count = await visible.count();\n"
                + "if (count !== 1) { nodeRepl.write(\"PILOTRY:COUNT:\" + count); }\n"
                + "else { await visible.click({ timeoutMs: 8000 }); nodeRepl.write(\"PILOTRY:OK\"); }"
            )
        result = self._js(code, "点击元素", timeout=30)
        text = " ".join(result["texts"])
        if "PILOTRY:OK" in text:
            return True, ""
        if "PILOTRY:ROW:" in text:
            count = text.split("PILOTRY:ROW:", 1)[1].strip().split()[0]
            return False, "目标所在行无法唯一定位（匹配 " + count + " 行）。"
        if "PILOTRY:MISS" in text:
            return False, "目标行内没有匹配文字的可用按钮，请重新分析。"
        if "PILOTRY:COUNT:" in text:
            count = text.split("PILOTRY:COUNT:", 1)[1].strip().split()[0]
            return False, "目标元素可见数量为 " + count + "，无法唯一定位。"
        return False, "无法唯一定位目标元素。"

    def click_element(self, element_id: str, text: str, row: dict | None = None) -> dict:
        before = self.state()
        if not before.get("connected"):
            return {"success": False, "error": "尚未打开浏览器页面。"}
        matches = [
            item
            for item in before.get("buttons", [])
            if (not element_id or item.get("id") == element_id)
            and (item.get("tag") != "a" or not item.get("href"))
            and compact_label(str(item.get("text", "")))
            == compact_label(text)
            and not item.get("disabled")
        ]
        row_text = compact_label(str((row or {}).get("rowText", "")))
        row_index = (row or {}).get("rowIndex")
        if row_text or (row_index is not None and row_index >= 0):
            matches = [
                item for item in matches
                if (not row_text or row_text in compact_label(str(item.get("rowText", ""))))
                and (row_index is None or row_index < 0 or item.get("rowIndex") == row_index)
            ]
        if len(matches) != 1:
            return {
                "success": False,
                "error": "按钮已变更或无法唯一定位，请重新分析。",
                "candidates": [
                    str(item.get("text", "")).strip()
                    for item in before.get("buttons", [])
                    if str(item.get("text", "")).strip()
                ][:20],
            }
        item = matches[0]
        # 定位必须用快照原文：归一化匹配放行的全角/半角差异，Playwright 逐字比对不认。
        item_text = str(item.get("text", "")).strip()
        # inner 为不带 tab.playwright. 前缀的定位表达式，供行收窄时嵌进 row.locator(...)。
        if element_id:
            selector = '[id="%s"]' % element_id.replace("\\", "\\\\").replace('"', '\\"')
            inner = "tab.playwright.locator(%s)" % json.dumps(selector)
            locator = inner
        else:
            role = str(item.get("role") or "").lower()
            tag = str(item.get("tag") or "").lower()
            if role in {"button", "menuitem", "tab", "link", "option"}:
                inner = "tab.playwright.getByRole(%s, { name: %s, exact: true })" % (
                    json.dumps(role),
                    json.dumps(item_text),
                )
            elif tag == "button":
                inner = 'tab.playwright.getByRole("button", { name: %s, exact: true })' % json.dumps(item_text)
            else:
                inner = "tab.playwright.getByText(%s, { exact: true })" % json.dumps(item_text)
            locator = inner
        # 同名行内按钮：先收窄到所在行再按文字点击按钮本身。
        # rowText 优先，但只取首个字段（如车队名）：快照把整行空白归一成了单空格，
        # 与页面原文（含换行）不一致，整段文字做 hasText 会匹配失败。
        item_row_text = str(item.get("rowText", "")).strip()
        item_row_index = item.get("rowIndex")
        row_key = item_row_text.split(" ")[0] if item_row_text else ""
        if row_key:
            locator = "inTableRow(rowWithText(%s), %s)" % (
                json.dumps(row_key),
                json.dumps(item_text),
            )
        elif item_row_index is not None and item_row_index >= 0:
            locator = "inTableRow(rowNth(%d), %s)" % (item_row_index + 1, json.dumps(item_text))
        clicked, error = self._click_locator(locator)
        if not clicked:
            return {"success": False, "error": error}
        page = self._wait_changed(before)
        if page:
            return {"success": True, "page": page}
        return {
            "success": False,
            "error": "已送出点选，但尚未观察到页面或控制项改变，请检查目前画面。",
            "page": self.state(),
        }

    def click_link(self, text: str, href: str) -> dict:
        before = self.state()
        if not before.get("connected"):
            return {"success": False, "error": "尚未打开浏览器页面。"}
        # 定位用快照原文（归一化放行的全角/半角差异，Playwright 逐字比对不认）。
        link_text = text
        for item in before.get("buttons", []):
            if item.get("tag") == "a" and item.get("href") == href and compact_label(item.get("text", "")) == compact_label(text):
                link_text = str(item.get("text", "")).strip()
                break
        locator = "tab.playwright.getByRole(\"link\", { name: %s, exact: true })" % json.dumps(link_text)
        # js 工具运行在 LCU 宿主环境，没有 location，绝对地址要用快照里的页面网址。
        code = (
            "let loc = %s;\n"
            "let visible = loc.filter({ visible: true });\n"
            "let count = await visible.count();\n"
            "if (count !== 1) { nodeRepl.write(\"PILOTRY:COUNT:\" + count); }\n"
            "else {\n"
            "  let attr = await visible.getAttribute(\"href\");\n"
            "  let abs = attr ? new URL(attr, %s).href : \"\";\n"
            "  if (abs !== %s) { nodeRepl.write(\"PILOTRY:MISMATCH:\" + abs); }\n"
            "  else { await visible.click({ timeoutMs: 8000 }); nodeRepl.write(\"PILOTRY:OK\"); }\n"
            "}"
            % (locator, json.dumps(before.get("url", "")), json.dumps(href))
        )
        result = self._js(code, "点击链接", timeout=30)
        response = " ".join(result["texts"])
        if "PILOTRY:COUNT:" in response:
            count = response.split("PILOTRY:COUNT:", 1)[1].strip().split()[0]
            return {"success": False, "error": "可见链接数量为 " + count + "，无法唯一定位。"}
        if "PILOTRY:MISMATCH:" in response:
            actual = response.split("PILOTRY:MISMATCH:", 1)[1].strip().split()[0]
            return {"success": False, "error": "链接目标与快照不一致：" + actual}
        if "PILOTRY:OK" not in response:
            return {"success": False, "error": "无法唯一定位链接。"}
        page = self._wait_changed(before)
        if page:
            return {"success": True, "page": page}
        return {
            "success": False,
            "error": "已送出点选，但未观察到页面导航，请确认目前页面。",
            "page": self.state(),
        }

    # ---- extraction / waiting ----------------------------------------------------

    def extract(self, kind: str) -> dict:
        if kind not in {"text", "links", "tables"}:
            raise ValueError("请选择文字、链接或表格数据。")
        raw = self._eval(BrowserManager.EXTRACT_JS)
        records = [{"text": raw.get("text", "")}] if kind == "text" else raw.get(kind, [])
        return {
            "success": True,
            "page": self.state(),
            "dataset": {
                "kind": kind,
                "url": raw.get("url", ""),
                "title": raw.get("title", ""),
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "records": records,
                "bounded": True,
            },
        }

    def wait_for_page(self) -> dict:
        with self._lock:
            if not self._tab_ready or not self._client or not self._client.alive:
                return {"settled": False, "page": self._offline()}
            try:
                self._js(
                    'await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 12000 });',
                    "等待页面加载",
                    timeout=20,
                )
            except LcuError:
                pass
            return {"settled": True, "page": self.state()}

    # ---- human handoff / page trust ---------------------------------------------

    def is_trusted(self, url: str) -> bool:
        if not url:
            return False
        with self._lock:
            return str(url).strip() in self._trusted

    def trust(self, url: str, trusted: bool = True) -> dict:
        key = str(url or "").strip()
        if not key:
            raise ValueError("请提供目前页面网址。")
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
