import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

@dataclass(frozen=True)
class MagpieConfig:
    base_url: str
    model: str
    token: str
    timeout_seconds: float

    @classmethod
    def from_env(cls) -> "MagpieConfig":
        return cls(
            base_url=os.getenv("MAGPIE_BASE_URL", "http://127.0.0.1:3425/v1").rstrip("/"),
            model=os.getenv("MAGPIE_MODEL", "zhipu/glm-5.3-flash"),
            token=os.getenv("MAGPIE_TOKEN", "magpie"),
            timeout_seconds=float(os.getenv("MAGPIE_TIMEOUT_SECONDS", "45")),
        )


class MagpieClient:
    """Small OpenAI Responses API client for the local Magpie gateway."""

    def __init__(self, config: MagpieConfig):
        self.config = config
        self._status_cache: tuple[float, dict] | None = None
        self._status_ttl = 15.0

    @property
    def model(self) -> str:
        return self.config.model

    def _request(self, path: str, payload: dict | None = None) -> dict:
        url = f"{self.config.base_url}{path}"
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method="POST" if payload is not None else "GET",
            headers={
                "Authorization": f"Bearer {self.config.token}",
                "x-openai-actor-authorization": self.config.token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def status(self, force: bool = False) -> dict:
        now = time.monotonic()
        if not force and self._status_cache and now - self._status_cache[0] < self._status_ttl:
            return self._status_cache[1]

        try:
            response = self._request("/models")
            model_ids = [item.get("id") for item in response.get("data", [])]
            available = self.config.model in model_ids
            result = {
                "provider": "magpie",
                "available": available,
                "model": self.config.model,
                "models": model_ids,
                "error": "" if available else f"model not found: {self.config.model}",
            }
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            result = {
                "provider": "magpie",
                "available": False,
                "model": self.config.model,
                "models": [],
                "error": str(exc),
            }

        self._status_cache = (now, result)
        return result
