# Pilotry Engine

Python 引擎默认通过 LCU 的 MCP 服务操作用户日常 Chrome 的标签页，并提供页面快照、截图与任务 API；没有 LCU 时回退到 zendriver + CDP 的独立 Chrome。LCU 后端复用日常 Chrome 的登录状态，页面快照与点击走官方扩展的 Playwright DOM 接口，截图走标签页截图。设置 `PILOTRY_BROWSER_BACKEND=zendriver` 可强制使用旧后端。Agent 流式由 `../agent/server.mjs` 的 AI SDK `streamText` 负责，浏览器操作仍在 Python 引擎执行。引擎侧的模型访问（状态探测与单轮补全）基于 LangChain：`engine/magpie.py` 用 `langchain-openai` 的 `ChatOpenAI` 对接同一个 Magpie 网关，依赖见 `engine/requirements.txt`。

```powershell
..\.venv\Scripts\python.exe engine/main.py
```

`POST /api/agent/tool` 接收受限工具呼叫。工具可打开真实网站、读取页面内容，并通过 LCU/Playwright 或 CDP 点选快照中唯一且可见的链接或一般按钮。订单提交和账号操作需由用户处理。引擎不实现自动付款。

`POST /api/ai/ask` 提供引擎侧单轮补全：`{"prompt": "…", "system": "可选系统提示"}` 返回 `{"text": "…"}`，经 LangChain LCEL 链（`ChatOpenAI | StrOutputParser`）调用 Magpie 网关；prompt 上限 12000 字，system 上限 4000 字。`GET /api/ai/status` 与 `/api/health` 的 `ai` 字段通过 OpenAI SDK 的 `models.list()` 探测网关，带 15 秒缓存。

任务目前保存在内存，不具备背景监控或持久化功能；尚未实现网站订单提取。完整开发启动方式见上一层 README。
