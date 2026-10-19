import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin, urlparse

from browser import manager
from browser_runtime import cdp_targets
from magpie import MagpieClient, MagpieConfig

APP_VERSION = "0.1.0"
tasks: list[dict] = []
tasks_lock = threading.Lock()
orders: list[dict] = []
ALLOWED_ORIGINS = {"http://localhost:1420", "http://127.0.0.1:1420", "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"}
magpie = MagpieClient(MagpieConfig.from_env())
COMMIT_LABELS = re.compile(
    r"付款|支付|提交|送出|確認訂|确认订|建立訂|创建订|登入|登录|登出|刪除|删除|subscribe|checkout|pay|confirm|submit|sign.?in|log.?in|delete",
    re.IGNORECASE,
)


def execute_agent_action(action: str, args: dict) -> dict:
    if action == "open_url":
        return {"success": True, "page": manager.open(str(args.get("url", "")).strip())}
    page = manager.state()
    if not page.get("connected"):
        return {"success": False, "error": "尚未開啟瀏覽器頁面。"}
    if action == "analyze_page":
        return {"success": True, **manager.wait_for_page()}
    if action == "wait_for_page":
        return {"success": True, **manager.wait_for_page()}
    if action == "extract_data":
        if page.get("pageType") in {"login", "captcha", "payment"}:
            return {"success": False, "error": "此頁面可能含敏感資料，請由使用者接手。"}
        return manager.extract(str(args.get("kind", "")))
    if action == "click_element":
        if str(args.get("snapshotUrl", "")) != page.get("url"):
            return {"success": False, "error": "頁面已變更，請重新分析後再點選。"}
        if page.get("pageType") in {"login", "captcha", "payment"}:
            return {"success": False, "error": "目前頁面需要使用者手動處理。"}
        element_id = str(args.get("id", ""))
        text = str(args.get("text", ""))
        compact_text = "".join(text.split())
        if element_id and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_:.-]{0,127}", element_id):
            return {"success": False, "error": "請使用快照中實際觀察到的元素 ID。"}
        matches = [item for item in page.get("buttons", []) if (not element_id or item.get("id") == element_id) and (item.get("tag") != "a" or not item.get("href")) and "".join(item.get("text", "").split()) == compact_text and not item.get("disabled")]
        if len(matches) != 1:
            return {"success": False, "error": "按鈕已變更或無法唯一定位，請重新分析。"}
        if COMMIT_LABELS.search(compact_text):
            return {"success": False, "error": "這個按鈕涉及帳號或確認提交，請由使用者接手。"}
        return manager.click_element(element_id, text)
    if action == "click_link":
        if page.get("pageType") in {"login", "captcha", "payment"}:
            return {"success": False, "error": "目前頁面需要使用者手動處理。"}
        text = str(args.get("text", "")).strip()
        href = str(args.get("href", "")).strip()
        matches = [item for item in page.get("buttons", []) if item.get("tag") == "a" and item.get("text", "").strip() == text and item.get("href") == href and not item.get("disabled")]
        if len(matches) != 1:
            return {"success": False, "error": "連結不在目前快照中，或無法唯一辨識，請重新分析。"}
        target = urlparse(urljoin(page["url"], href))
        if target.scheme not in {"http", "https"} or target.username or target.password:
            return {"success": False, "error": "此連結無法以一般網頁導覽開啟。"}
        if COMMIT_LABELS.search(text) or re.search(r"(?:^|/)(?:pay|checkout|payment|order|login|signin|delete)(?:/|[.?#]|$)", target.path, re.IGNORECASE):
            return {"success": False, "error": "此連結涉及帳號或提交操作，請由使用者接手。"}
        return manager.click_link(text, href)
    return {"success": False, "error": "不支援的工具。"}


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
            self._send_json(403, {"error": "不允許此網頁來源。"})
            return
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                self._send_json(200, {"status": "ok", "version": APP_VERSION, "ai": magpie.status(), "browser": {"driver": "zendriver", "connected": manager.connected}})
            elif path == "/api/ai/status":
                self._send_json(200, magpie.status(force=True))
            elif path == "/api/browser/state":
                self._send_json(200, manager.state())
            elif path == "/api/browser/runtime":
                self._send_json(200, manager.runtime())
            elif path == "/api/browser/screenshot":
                self._send_json(200, {"data": manager.screenshot()})
            elif path == "/api/tasks":
                with tasks_lock:
                    self._send_json(200, tasks.copy())
            elif path == "/api/orders":
                self._send_json(200, orders)
            else:
                self._send_json(404, {"error": "找不到此端點。"})
        except Exception:
            self._send_json(503, {"error": "暫時無法讀取瀏覽器，請稍後再試。"})

    def do_POST(self) -> None:
        if self.headers.get("Origin") and self.headers["Origin"] not in ALLOWED_ORIGINS:
            self._send_json(403, {"error": "不允許此網頁來源。"})
            return
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "請求格式不正確。"})
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
            if path == "/api/browser/analyze":
                self._send_json(200, execute_agent_action("analyze_page", {}))
                return
            if path == "/api/agent/tool":
                args = body.get("args", {})
                if not isinstance(args, dict):
                    raise ValueError("Invalid arguments")
                self._send_json(200, execute_agent_action(str(body.get("action", "")), args))
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
            self._send_json(404, {"error": "找不到此端點。"})
        except (ValueError, TypeError) as exc:
            self._send_json(400, {"error": str(exc) if path in {"/api/browser/runtime", "/api/browser/targets"} else "請檢查網址或輸入資料。"})
        except Exception:
            self._send_json(503, {"error": "操作未完成，請確認目前頁面後再試。"})

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
