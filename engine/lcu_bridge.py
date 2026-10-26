import json
import os
import subprocess
import threading
import time
from pathlib import Path


class LcuError(RuntimeError):
    """Raised when the LCU runtime cannot be reached or rejects a call."""


def lcu_path() -> str:
    candidates = [
        Path.home() / ".local/share/lcu/current/bin/lcu",
        Path("/opt/lcu/current/bin/lcu"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "LCU/lcu.cmd",
    ]
    override = os.environ.get("PILOTRY_LCU_PATH")
    if override:
        candidates.insert(0, Path(override))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return ""


def lcu_available() -> bool:
    return bool(lcu_path())


class LcuClient:
    """Small MCP stdio client for the LCU computer-use runtime.

    One long-lived process keeps the cua_repl session alive, so a browser tab
    binding stays valid across engine calls.
    """

    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None
        self._lock = threading.RLock()
        self._condition = threading.Condition()
        self._responses: dict[int, dict] = {}
        self._next_id = 1
        self._closed = False
        self._reader: threading.Thread | None = None
        self._pending_elicitation: dict | None = None

    @property
    def pending_elicitation(self) -> dict | None:
        with self._condition:
            return self._pending_elicitation

    @property
    def alive(self) -> bool:
        return bool(self._process and self._process.poll() is None)

    def start(self) -> None:
        with self._lock:
            if self.alive:
                return
            path = lcu_path()
            if not path:
                raise LcuError("未找到 LCU：请安装 LCU 或设置 PILOTRY_LCU_PATH。")
            self._responses.clear()
            self._closed = False
            self._process = subprocess.Popen(
                [path, "--chrome"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            self._reader = threading.Thread(
                target=self._read_loop,
                args=(self._process,),
                name="pilotry-lcu-reader",
                daemon=True,
            )
            self._reader.start()
        self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"elicitation": {}},
                "clientInfo": {"name": "pilotry", "version": "0.1.0"},
            },
            timeout=30,
        )
        self._notify("notifications/initialized")

    def _read_loop(self, process: subprocess.Popen) -> None:
        try:
            for line in process.stdout or []:
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if message.get("method") == "elicitation/create":
                    with self._condition:
                        self._pending_elicitation = message
                    # LCU asks the host to approve a site or app. Without a UI
                    # bridge we refuse it explicitly instead of silently
                    # granting access.
                    self._safe_send(
                        {
                            "jsonrpc": "2.0",
                            "id": message.get("id"),
                            "result": {"action": "decline"},
                        }
                    )
                    continue
                if "id" in message and ("result" in message or "error" in message):
                    with self._condition:
                        self._responses[message["id"]] = message
                        self._condition.notify_all()
        finally:
            with self._condition:
                self._closed = True
                self._condition.notify_all()

    def _safe_send(self, message: dict) -> None:
        try:
            self._send(message)
        except LcuError:
            pass

    def _send(self, message: dict) -> None:
        with self._lock:
            if not self.alive or not self._process or not self._process.stdin:
                raise LcuError("LCU 进程未运行。")
            self._process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            self._process.stdin.flush()

    def _notify(self, method: str, params: dict | None = None) -> None:
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def _request(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        with self._condition:
            request_id = self._next_id
            self._next_id += 1
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self._send(message)
        deadline = time.time() + timeout
        with self._condition:
            while request_id not in self._responses:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise LcuError("LCU 调用超时：" + method)
                if self._closed:
                    raise LcuError("LCU 进程已结束，请重启浏览器引擎。")
                self._condition.wait(min(remaining, 0.5))
            response = self._responses.pop(request_id)
        if "error" in response:
            error = response.get("error") or {}
            raise LcuError(str(error.get("message") or "LCU 调用失败。"))
        return response.get("result") or {}

    def call_js(self, code: str, title: str, timeout: float = 60) -> dict:
        result = self._request(
            "tools/call",
            {
                "name": "js",
                "arguments": {
                    "code": code,
                    "title": title[:80] or "Pilotry 操作",
                    "timeout_ms": max(1, int(timeout * 1000)),
                },
            },
            timeout=timeout + 20,
        )
        texts = []
        images = []
        for item in result.get("content", []):
            if item.get("type") == "text":
                texts.append(item.get("text", ""))
            elif item.get("type") == "image":
                images.append(item)
        return {
            "texts": texts,
            "images": images,
            "isError": bool(result.get("isError")),
            "raw": result,
        }

    def stop(self) -> None:
        with self._lock:
            process = self._process
            self._process = None
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
