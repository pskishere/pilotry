import atexit
import json
import os
import re
import signal
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin, urlparse

from browser import BrowserManager, compact_label
from browser_runtime import cdp_targets
from lcu_bridge import lcu_available
from lcu_browser import LcuBrowserManager
from magpie import MagpieClient, MagpieConfig

_BACKEND = os.getenv("PILOTRY_BROWSER_BACKEND", "auto").strip().lower()
if _BACKEND in {"lcu", "auto"} and lcu_available():
    manager = LcuBrowserManager()
else:
    manager = BrowserManager()
atexit.register(manager.stop)


def _shutdown(*_args) -> None:
    try:
        manager.stop()
    finally:
        raise SystemExit(0)


signal.signal(signal.SIGTERM, _shutdown)
signal.signal(signal.SIGINT, _shutdown)

APP_VERSION = "0.1.0"
tasks: list[dict] = []
tasks_lock = threading.Lock()
orders: list[dict] = []
ALLOWED_ORIGINS = {"http://localhost:1420", "http://127.0.0.1:1420", "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"}
magpie = MagpieClient(MagpieConfig.from_env())
COMMIT_LABELS = re.compile(
    r"付款|支付|提交|送出|确认订|建立订|创建订|登录|退出登录|删除|subscribe|checkout|pay|confirm|submit|sign.?in|log.?in|delete",
    re.IGNORECASE,
)


def page_needs_human(page: dict) -> bool:
    if manager.is_trusted(page.get("url", "")):
        return False
    challenge = (page.get("challenge") or {}).get("type", "none")
    return page.get("pageType") in {"login", "captcha", "payment"} or challenge in {
        "login",
        "captcha",
        "2fa",
        "payment",
    }


def page_candidates(page: dict, limit: int = 20) -> list[str]:
    texts = [str(item.get("text", "")).strip() for item in page.get("buttons", [])]
    return [text for text in texts if text][:limit]


def execute_agent_action(action: str, args: dict) -> dict:
    if action == "open_url":
        return {"success": True, "page": manager.open(str(args.get("url", "")).strip())}
    page = manager.state()
    if not page.get("connected"):
        return {"success": False, "error": "尚未打开浏览器页面。"}
    if action == "analyze_page":
        return {"success": True, **manager.wait_for_page()}
    if action == "wait_for_page":
        return {"success": True, **manager.wait_for_page()}
    if action == "extract_data":
        if page_needs_human(page):
            return {"success": False, "error": "此页面可能含敏感数据，请由用户接手。"}
        return manager.extract(str(args.get("kind", "")))
    if action == "click_element":
        if str(args.get("snapshotUrl", "")) != page.get("url"):
            return {"success": False, "error": "页面已变更，请重新分析后再点选。"}
        if page_needs_human(page):
            return {
                "success": False,
                "error": "目前页面需要用户手动处理。",
                "humanReason": (page.get("challenge") or {}).get("type", "unknown"),
                "hint": "若确认这是误判，可在界面选择信任此页面后继续。",
            }
        element_id = str(args.get("id", ""))
        text = str(args.get("text", ""))
        compact_text = compact_label(text)
        row_text = compact_label(str(args.get("rowText", "")))
        row_index = args.get("rowIndex")
        row_index = int(row_index) if isinstance(row_index, (int, float)) else None
        if element_id and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_:.-]{0,127}", element_id):
            return {"success": False, "error": "请使用快照中实际观察到的元素 ID。"}
        matches = [item for item in page.get("buttons", []) if (not element_id or item.get("id") == element_id) and (item.get("tag") != "a" or not item.get("href")) and compact_label(item.get("text", "")) == compact_text and not item.get("disabled")]
        if row_text or row_index is not None:
            # 表格行内操作：同名按钮靠所在行的文字或行序区分。
            matches = [
                item for item in matches
                if (not row_text or row_text in compact_label(item.get("rowText", "")))
                and (row_index is None or item.get("rowIndex") == row_index)
            ]
            if len(matches) != 1:
                rows = sorted({
                    (item.get("rowIndex"), str(item.get("rowText", ""))[:60])
                    for item in page.get("buttons", [])
                    if compact_label(item.get("text", "")) == compact_text
                })
                return {
                    "success": False,
                    "error": "行定位不唯一或不存在，请用 rowText（行内文字关键词）或 rowIndex（快照标注的行序）重试。",
                    "rows": [{"rowIndex": index, "rowText": text} for index, text in rows],
                }
        if len(matches) != 1:
            return {
                "success": False,
                "error": "按钮已变更或无法唯一定位，请从 candidates 重新选择可见文字。",
                "candidates": page_candidates(page),
            }
        if COMMIT_LABELS.search(compact_text):
            return {"success": False, "error": "这个按钮涉及账号或确认提交，请由用户接手。"}
        return manager.click_element(element_id, text, row=matches[0])
    if action == "click_link":
        if page_needs_human(page):
            return {"success": False, "error": "目前页面需要用户手动处理。"}
        text = str(args.get("text", "")).strip()
        href = str(args.get("href", "")).strip()
        matches = [item for item in page.get("buttons", []) if item.get("tag") == "a" and compact_label(item.get("text", "")) == compact_label(text) and item.get("href") == href and not item.get("disabled")]
        if len(matches) != 1:
            return {
                "success": False,
                "error": "链接不在目前快照中，或无法唯一辨识，请从 candidates 重新选择。",
                "candidates": page_candidates(page),
            }
        target = urlparse(urljoin(page["url"], href))
        if target.scheme not in {"http", "https"} or target.username or target.password:
            return {"success": False, "error": "此链接无法以一般网页导航打开。"}
        if COMMIT_LABELS.search(text) or re.search(r"(?:^|/)(?:pay|checkout|payment|order|login|signin|delete)(?:/|[.?#]|$)", target.path, re.IGNORECASE):
            return {"success": False, "error": "此链接涉及账号或提交操作，请由用户接手。"}
        return manager.click_link(text, href)
    return {"success": False, "error": "不支持的工具。"}


class Handler(BaseHTTPRequestHandler):
    server_version = "PilotryEngine"

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 131072:
            raise ValueError("Invalid request size")
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(body, dict):
            raise ValueError("Invalid request")
        return body

    def do_OPTIONS(self) -> None:
        self._send_json(204, {})

    def do_GET(self) -> None:
        if self.headers.get("Origin") and self.headers["Origin"] not in ALLOWED_ORIGINS:
            self._send_json(403, {"error": "不允许此网页来源。"})
            return
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                self._send_json(200, {"status": "ok", "version": APP_VERSION, "ai": magpie.status(), "browser": {"driver": getattr(manager, "driver_name", "zendriver"), "connected": manager.connected}})
            elif path == "/api/ai/status":
                self._send_json(200, magpie.status(force=True))
            elif path == "/api/browser/state":
                self._send_json(200, manager.state())
            elif path == "/api/human/status":
                self._send_json(200, manager.human_status())
            elif path == "/api/browser/runtime":
                self._send_json(200, manager.runtime())
            elif path == "/api/browser/screenshot":
                shot = manager.screenshot()
                if isinstance(shot, str):
                    shot = {"data": shot, "mime": "image/jpeg"}
                self._send_json(200, shot)
            elif path == "/api/tasks":
                with tasks_lock:
                    self._send_json(200, tasks.copy())
            elif path == "/api/orders":
                self._send_json(200, orders)
            else:
                self._send_json(404, {"error": "找不到此端点。"})
        except Exception:
            self._send_json(503, {"error": "暂时无法读取浏览器，请稍后再试。"})

    def do_POST(self) -> None:
        if self.headers.get("Origin") and self.headers["Origin"] not in ALLOWED_ORIGINS:
            self._send_json(403, {"error": "不允许此网页来源。"})
            return
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "请求格式不正确。"})
            return
        now = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
        try:
            if path == "/api/browser/runtime":
                self._send_json(200, manager.configure(body))
                return
            if path == "/api/browser/targets":
                self._send_json(200, [{"id": item.get("id"), "title": item.get("title"), "url": item.get("url")} for item in cdp_targets(str(body.get("endpoint", ""))) if item.get("type") == "page"])
                return
            if path == "/api/browser/open":
                self._send_json(200, manager.open(str(body.get("url", "")).strip()))
                return
            if path == "/api/human/trust":
                self._send_json(200, manager.trust(str(body.get("url", "")).strip(), bool(body.get("trusted", True))))
                return
            if path == "/api/browser/analyze":
                self._send_json(200, execute_agent_action("analyze_page", {}))
                return
            if path == "/api/agent/tool":
                args = body.get("args", {})
                if not isinstance(args, dict):
                    raise ValueError("Invalid arguments")
                self._send_json(200, execute_agent_action(str(body.get("action", "")), args))
                return
            if path == "/api/ai/ask":
                prompt = str(body.get("prompt", "")).strip()
                system = str(body.get("system", "")).strip() or None
                if not prompt or len(prompt) > 12000 or (system and len(system) > 4000):
                    self._send_json(400, {"error": "请提供 1-12000 字的 prompt，system 不超过 4000 字。"})
                    return
                try:
                    text = magpie.ask(prompt, system)
                except Exception as exc:
                    self._send_json(503, {"error": f"AI 请求失败：{exc}"})
                    return
                self._send_json(200, {"text": text})
                return
            if path == "/api/tasks":
                number = int(body.get("ticketNumber", 1))
                event = str(body.get("event", "")).strip()
                goal = str(body.get("goal", "")).strip()
                url = str(body.get("url", "")).strip()
                if url:
                    manager._validate_url(url)
                if len(goal) > 4000:
                    raise ValueError("Invalid goal")
                if not event or len(event) > 120 or not 1 <= number <= 10:
                    raise ValueError("Invalid task")
                task = {"id": uuid.uuid4().hex, "platform": str(body.get("platform", "web")), "event": event, "url": url, "goal": goal, "status": "created", "needsHuman": False, "createdAt": now, "updatedAt": now}
                if body.get("ticketNumber") is not None:
                    task.update(ticketNumber=number, maxPrice=body.get("maxPrice"))
                with tasks_lock:
                    tasks.insert(0, task)
                self._send_json(200, task)
                return
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] in {"approve", "stop"}:
                with tasks_lock:
                    task = next((item for item in tasks if item["id"] == parts[2]), None)
                    if task:
                        task.update(needsHuman=False, status="created" if parts[3] == "approve" else "stopped", updatedAt=now)
                        self._send_json(200, task)
                        return
            self._send_json(404, {"error": "找不到此端点。"})
        except (ValueError, TypeError) as exc:
            self._send_json(400, {"error": str(exc) if path in {"/api/browser/runtime", "/api/browser/targets"} else "请检查网址或输入数据。"})
        except Exception as exc:
            self._send_json(503, {"error": f"操作未完成：{exc}" if path == "/api/agent/tool" else "操作未完成，请确认目前页面后再试。"})

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    port = int(os.getenv("ENGINE_PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Pilotry engine: http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    finally:
        manager.stop()
        server.server_close()


if __name__ == "__main__":
    main()
