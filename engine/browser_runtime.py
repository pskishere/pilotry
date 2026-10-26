import json
import os
import shutil
import sys
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import ProxyHandler, build_opener

import zendriver as uc

DATA_DIR = Path(os.getenv("PILOTRY_DATA_DIR") or Path.home() / ".pilotry")
BROWSERS = {
    "chrome": ("Google Chrome", ["Google/Chrome/Application/chrome.exe"], ["google-chrome", "google-chrome-stable"], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "edge": ("Microsoft Edge", ["Microsoft/Edge/Application/msedge.exe"], ["microsoft-edge", "microsoft-edge-stable"], "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    "brave": ("Brave", ["BraveSoftware/Brave-Browser/Application/brave.exe"], ["brave-browser", "brave"], "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
    "chromium": ("Chromium", ["Chromium/Application/chrome.exe"], ["chromium", "chromium-browser"], "/Applications/Chromium.app/Contents/MacOS/Chromium"),
}


def load_runtime() -> dict:
    try:
        value = json.loads((DATA_DIR / "browser.json").read_text(encoding="utf-8"))
        return value if value.get("id") in {*BROWSERS, "auto", "custom"} else {"id": "auto"}
    except (OSError, ValueError, AttributeError):
        return {"id": "auto"}


def save_runtime(value: dict) -> None:
    if value["id"] == "cdp":
        return
    if value["id"] == "embedded":
        value = {"id": "auto", "label": "自动选择"}
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary = DATA_DIR / "browser.json.tmp"
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(DATA_DIR / "browser.json")


def discover_browsers() -> list[dict]:
    found = []
    for key, (label, windows, commands, mac) in BROWSERS.items():
        candidates = [Path(mac)] if sys.platform == "darwin" else []
        if sys.platform == "win32":
            for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
                if os.getenv(variable):
                    candidates.extend(Path(os.environ[variable]) / name for name in windows)
        candidates.extend(Path(path) for name in commands if (path := shutil.which(name)))
        path = next((str(path) for path in candidates if path.is_file()), "")
        found.append({"id": key, "label": label, "available": bool(path), "path": path})
    return found


def validate_endpoint(value: str) -> tuple[str, int]:
    parsed = urlparse(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("CDP 只允许本机 HTTP 端点，不接受远端主机或凭证。")
    if not parsed.port or not 1 <= parsed.port <= 65535:
        raise ValueError("请指定有效的本机 CDP 端口。")
    return parsed.hostname, parsed.port


def cdp_targets(endpoint: str) -> list[dict]:
    validate_endpoint(endpoint)
    with build_opener(ProxyHandler({})).open(endpoint.rstrip("/") + "/json/list", timeout=5) as response:
        data = json.loads(response.read(1024 * 1024))
    if not isinstance(data, list):
        raise ValueError("CDP 端点未回传分页清单。")
    return data


def resolve_runtime(input: dict) -> dict:
    if not isinstance(input, dict):
        raise ValueError("浏览器设置格式不正确。")
    key = str(input.get("id", "auto"))
    if key in {"embedded", "cdp"}:
        endpoint = str(input.get("endpoint", ""))
        validate_endpoint(endpoint)
        target_id = str(input.get("targetId", ""))
        marker = str(input.get("marker", ""))
        targets = [target for target in cdp_targets(endpoint) if target.get("type") == "page"]
        matches = [target for target in targets if (target_id and target.get("id") == target_id) or (marker and target.get("url") == marker)]
        if len(matches) != 1:
            raise ValueError("请选择一个明确的 CDP 分页；不会自动接管其他页面。")
        return {"id": key, "label": "Tauri 内嵌" if key == "embedded" else "本机 CDP", "endpoint": endpoint, "targetId": matches[0]["id"]}
    installed = discover_browsers()
    if key == "custom":
        path = Path(str(input.get("path", "")))
        if not path.is_absolute() or not path.is_file() or path.name.lower() not in {"chrome.exe", "msedge.exe", "brave.exe", "chrome", "chromium", "chromium-browser", "google chrome", "microsoft edge", "brave browser"}:
            raise ValueError("请指定 Chrome、Edge、Brave 或 Chromium 的完整可执行文件路径。")
        return {"id": key, "label": "自订 Chromium", "path": str(path.resolve())}
    if key == "auto":
        override = os.getenv("PILOTRY_CHROME_PATH")
        if override:
            return resolve_runtime({"id": "custom", "path": override})
        match = next((browser for browser in installed if browser["available"]), None)
    else:
        match = next((browser for browser in installed if browser["id"] == key and browser["available"]), None)
    if not match:
        raise ValueError("找不到所选浏览器。请先安装，或指定自订 Chromium 路径。")
    return {"id": match["id"], "label": match["label"], "path": match["path"]}


class AttachedBrowser(uc.Browser):
    """Disconnect from a borrowed CDP session without closing its host process."""

    async def stop(self) -> None:
        for target in self.targets:
            await target.aclose()
        self.targets.clear()
        if self.connection:
            await self.connection.aclose()
            self.connection = None
