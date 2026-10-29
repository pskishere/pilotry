# Pilotry Engine

Python 引擎默认通过 LCU 的 MCP 服务操作用户日常 Chrome 的标签页，并提供页面快照、截图与任务 API；没有 LCU 时回退到 zendriver + CDP 的独立 Chrome。LCU 后端复用日常 Chrome 的登录状态，页面快照与点击走官方扩展的 Playwright DOM 接口，截图走标签页截图。设置 `PILOTRY_BROWSER_BACKEND=zendriver` 可强制使用旧后端。Agent 流式由 `../agent/server.mjs` 的 AI SDK `streamText` 负责，浏览器操作仍在 Python 引擎执行。引擎侧的模型访问（状态探测与单轮补全）基于 LangChain：`engine/magpie.py` 用 `langchain-openai` 的 `ChatOpenAI` 对接同一个 Magpie 网关，依赖见 `engine/requirements.txt`。

```powershell
..\.venv\Scripts\python.exe engine/main.py
```

`POST /api/agent/tool` 接收受限工具呼叫。工具可打开真实网站、读取页面内容，并通过 LCU/Playwright 或 CDP 点选快照中唯一且可见的链接或一般按钮。订单提交和账号操作需由用户处理。引擎不实现自动付款。

`POST /api/browser/recover` 在标签页绑定失效（Chrome 重启、标签页被手动关闭）时重建 LCU 会话与标签页；`POST /api/browser/release` 在任务结束时关闭受控标签页（agent 于对话轮与流程重放的收尾自动调用，仅真正完成才关，暂停续跑保留页面）。受控标签页带「🤖 Pilotry」会话名，引擎启动时会尝试清扫上一会话的遗留页。

快照为表格与浮层提供行上下文：每个元素带 `rowText`（所在表格行或浮层容器的文字）与 `rowIndex`，浮层（菜单/弹窗/抽屉）内的元素优先收录；`click_element` 接受 `rowText`/`rowIndex` 精确点击每行重复的同名按钮（编辑/删除/操作等），匹配失败时回传行候选清单。

`POST /api/ai/ask` 提供引擎侧单轮补全：`{"prompt": "…", "system": "可选系统提示"}` 返回 `{"text": "…"}`，经 LangChain LCEL 链（`ChatOpenAI | StrOutputParser`）调用 Magpie 网关；prompt 上限 12000 字，system 上限 4000 字。`GET /api/ai/status` 与 `/api/health` 的 `ai` 字段通过 OpenAI SDK 的 `models.list()` 探测网关，带 15 秒缓存。

任务目前保存在内存，不具备背景监控或持久化功能；尚未实现网站订单提取。完整开发启动方式见上一层 README。
