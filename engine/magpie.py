import os
import time
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
    """LLM 访问层：LangChain(ChatOpenAI + LCEL)对接本地 Magpie 网关。

    惰性加载 langchain/openai，缺依赖时引擎仍可独立执行浏览器操作。
    """

    def __init__(self, config: MagpieConfig):
        self.config = config
        self._status_cache: tuple[float, dict] | None = None
        self._status_ttl = 15.0
        self._sdk_client = None
        self._llm = None

    @property
    def model(self) -> str:
        return self.config.model

    def _sdk(self):
        if self._sdk_client is None:
            from openai import OpenAI

            self._sdk_client = OpenAI(
                base_url=self.config.base_url,
                api_key=self.config.token,
                timeout=self.config.timeout_seconds,
                default_headers={"x-openai-actor-authorization": self.config.token},
            )
        return self._sdk_client

    def _chat_model(self):
        if self._llm is None:
            from langchain_openai import ChatOpenAI

            self._llm = ChatOpenAI(
                model=self.config.model,
                base_url=self.config.base_url,
                api_key=self.config.token,
                timeout=self.config.timeout_seconds,
                max_retries=0,
                default_headers={"x-openai-actor-authorization": self.config.token},
            )
        return self._llm

    def status(self, force: bool = False) -> dict:
        now = time.monotonic()
        if not force and self._status_cache and now - self._status_cache[0] < self._status_ttl:
            return self._status_cache[1]

        try:
            model_ids = [item.id for item in self._sdk().models.list()]
            available = self.config.model in model_ids
            result = {
                "provider": "magpie",
                "available": available,
                "model": self.config.model,
                "models": model_ids,
                "error": "" if available else f"model not found: {self.config.model}",
            }
        except Exception as exc:  # 网关不可达、依赖缺失等一律视为不可用
            result = {
                "provider": "magpie",
                "available": False,
                "model": self.config.model,
                "models": [],
                "error": str(exc),
            }

        self._status_cache = (now, result)
        return result

    def ask(self, prompt: str, system: str | None = None) -> str:
        """单轮补全：可选拼装 system，经 LCEL 链返回纯文本。"""
        from langchain_core.messages import HumanMessage, SystemMessage
        from langchain_core.output_parsers import StrOutputParser

        messages = []
        if system:
            messages.append(SystemMessage(content=system))
        messages.append(HumanMessage(content=prompt))
        chain = self._chat_model() | StrOutputParser()
        return str(chain.invoke(messages)).strip()
