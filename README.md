# Pilotry

Tauri、React 与 Ant Design X 组成的通用网页操作工作台。浏览、数据提取、一般按钮操作及可重用流程共用同一个 Agent，不依赖特定网站或购票场景。浏览器使用 zendriver + CDP；Agent 使用 AI SDK `streamText` 通过 Magpie 流式回复与呼叫工具。

## 开发启动

需要 Node.js 22 以上，以及已安装 zendriver 的 Python 环境。默认使用上一层 `.venv`；其他环境可设置 `PILOTRY_PYTHON`。

```powershell
npm install
npm run dev:stack
```

此指令启动 Python 引擎（8765）、Agent 流式服务（8766）与 Vite（1420），既有的引擎与 Agent 服务会直接重用。打开 `http://127.0.0.1:1420`。

Tauri 开发窗口使用 `npm run desktop`，需要 Rust、Cargo 与系统建置工具。它会启动开发服务；已启动的服务与 Vite 会直接重用。

```powershell
npm run desktop
```

目前提供开发启动方式；Python 与 Node 执行环境尚未整合进 Tauri 发行版安装程序。

服务默认端口为 8765 / 8766。可在忽略版本控制的 `.env.local` 设置 `VITE_ENGINE_URL`、`VITE_AGENT_URL`、`ENGINE_PORT`、`AGENT_PORT` 和 `ENGINE_URL`；`dev:stack` 会读取此文件。切换端口时不必结束其他工作中的服务。

## 浏览器模式

- 本机 Chrome（LCU，默认）：安装 LCU、ChatGPT 桌面版与官方 Chrome 扩展后，引擎通过 LCU 在用户日常 Chrome 中新建标签页，复用现有 Cookie 与登录状态；页面快照与点击使用扩展提供的 Playwright DOM 接口，画面使用标签页截图。首次访问网站时扩展可能要求授权；若拒绝，引擎会回报具体错误。设置 `PILOTRY_BROWSER_BACKEND=zendriver` 可切回独立配置文件的 Chrome。
- Windows Tauri 桌面版：右侧是真实的 WebView2 子网页，可手动操作与接管；Python 连接这个网页的 CDP 目标，不另外启动 Chrome。新工作阶段尚未选择执行环境时会尝试使用内嵌模式。
- 外置模式：检测 Chrome、Edge、Brave、Chromium 的安装位置，也可指定 Chromium 可执行文件。未安装的项目会停用；每种浏览器使用独立的应用程序配置文件，不读取既有的个人浏览器配置文件。
- 本机 CDP：明确选择要接管的分页，不自动接管第一个分页。只允许本机 HTTP 端点；中断连接不会关闭原宿主。
- 网页开发预览仍使用即时截图，只有 Tauri 桌面版能显示原生子网页。macOS / Linux 的系统 WebView 及 Firefox / Safari 尚未提供此 CDP 执行器；可以使用外置 Chromium。

Tauri 子 WebView 使用 `unstable` 功能。外站子网页没有本机 IPC 能力；主界面与外站网页分开管理。内嵌模式目前将一般新窗口链接留在同一个网页；依赖原始弹出窗口或 `window.opener` 的网站请使用外置模式。切换环境不会搬移 Cookie。

## 使用

- 工作台：输入网址，通过 Pilotry 对话执行操作；桌面版可使用真实内嵌网页。
- 版面：对话默认占分屏约六成，可拖曳分隔线或用方向键调整；右上方可切换全宽对话、分屏与全宽浏览器。比例与侧栏状态会保留。
- 执行工作区：浏览器、执行记录与页面信息共用右侧空间。执行记录分页内可保存流程；窄屏幕默认显示全宽对话。
- 执行记录：即时显示操作摘要、工具参数、执行状态与结果，可展开检查。
- 流程库：将成功步骤保存为流程、预览与编辑定位，带入参数后直接重跑。
- 任务管理：保存任务名称、网址、操作目标与场景标签；可把目标送到工作台对话。新增任务不会启动背景监控，任务状态目前仍是需求管理数据，不是排程器。
- 数据提取：取得目前已加载页面的文字、链接或 HTML 表格，在执行记录下载 JSON / CSV。文字最多 30000 字元、链接最多 200 笔、表格最多 10 个且每表最多 200 列；不宣称遍历整个网站。
- 设置：管理浏览器模式、连接状态、预览与执行预算。

可在聊天中输入：

```text
打开 https://www.cityline.com/，分析页面并点选一个公开活动链接，读取新页面内容。
打开 https://www.iana.org/domains/reserved，提取公开链接。跑通后保存为流程「IANA 公开链接提取」。
重跑流程「IANA 公开链接提取」。
```

直接操作真实网站：打开网址、分析页面文字、链接与表单，并通过 LCU/Playwright 或 CDP 点选唯一可辨识的公开链接或一般按钮。没有 href 的按钮使用快照中的元素 ID 和文字定位；没有 ID 时只允许可见文字唯一相符的按钮。执行后会验证页面或状态确实改变。登录、验证码、敏感数据、确认提交与付款由用户处理。场景标签不代表已实现所有表单或交易操作。

## 数据与流式

### 保存与重跑流程

1. 完成一次网页操作后，在「执行记录」按「保存流程」。
2. 选择成功步骤、确认起始网址。可将点选文字或链接目标设成每次执行前可修改的参数。
3. 到「流程库」预览流程，再按「重跑」。每次重跑会建立独立对话并即时显示执行进度。

也可以直接对话：「把刚才的成功步骤保存为流程，名称叫活动购票入口」或「重跑流程：活动购票入口」。对话会使用流程工具读取记录、保存或执行，不会只回复操作建议。通过对话启动仍需要模型理解指令；流程本身的正常步骤不再逐步呼叫模型。

正常重跑直接呼叫 Python / CDP，不逐步呼叫模型。定位失效时才以 streamText 的结构化输出从目前页面的真实候选项目重新辨识，每次执行最多 3 次。结果无法确认、页面来源不符，或实际到达网址与预期不符时停止，不会在操作后盲目再点一次。

遇到登录、验证码、两步验证或付款页面时，Agent 会调用 request_human 暂停，执行记录标记「等待人工」，流程重跑则记录暂停步骤（resumeIndex）。用户在外置 Chrome 或桌面版内嵌 WebView 完成操作后点「我已完成，继续」或「从当前步骤继续」；Agent 会先分析目前页面再继续，不会从头重跑，也不会接收或保存账号密码、验证码与支付信息。

页面快照与点选除了 button、链接、role=button，也涵盖 role=menuitem、role=tab、role=link、onclick 与 tabindex 等自定义交互元素，因此 Ant Design 等导航菜单可以直接点选。敏感页判定只使用密码框、验证码输入框、支付表单或支付网址等实际证据，不会因为页面文字出现「支付」「提现」就封锁操作；若仍发生误判，可在接管横幅按「误判？信任此页继续」，信任仅对当前网址有效，重启引擎后清除。

使用默认参数重跑且整段流程成功时，通过验证的定位修正会保存，下次可直接执行。若流程已被另行修改，修正不会覆盖新版。使用不同参数时，当次的定位修正不会改写默认流程。

流程文件存放于用户家目录的 .pilotry/workflows.json，不受对话记录截断影响。可通过 PILOTRY_DATA_DIR 变更文件夹。文件以原子替换写入，损毁时回报错误并保留原文件。保存的内容只包含操作、定位、参数、网址验证条件与最近一次执行统计，不包含整页文字、Cookie 或密码。

目前流程重用涵盖打开、读取、等待、数据提取、链接及一般按钮操作，每个流程最多 256 步。它不新增表单填写、背景监控或自动付款能力。参数导致后续目标网址改变时，请在流程的进阶编辑中同步调整预期网址。

对话与偏好设置存放于目前浏览器或 WebView 的 localStorage，最多保留 12 段对话，每段保留最近 60 则消息与 256 个步骤的操作与页面中继数据。每段对话只快取最近一份且小于 128 KiB 的提取结果；较大的数据请在提取后下载保留。任务由 Python 引擎保存在内存，重启会清除。目前尚未实现网站订单提取。

Agent 使用原生工具呼叫，默认 64 回合、15 分钟，可在设置调整为 32 / 64 / 128 / 256 回合及 5 / 15 / 30 / 60 分钟。这是单次工作的资源预算，不是模型额度。工具连续失败 3 次，或对同一页面连续分析 6 次仍未变更时会暂停；等待网站加载不计入重复分析。达限后显示具体原因，可从目前页面继续，不自动从起点重跑。

SSE 发送文字增量、执行状态与工具事件，不转送模型隐藏推理。停止回复会中止模型流式及后续工具呼叫；已交给 Python 的操作可能仍会完成。长期排程与无限循环尚未实现。

与浏览器无关、可独立完成的推理、换算或文案类子任务，可通过 `run_dsh_task` 委派给本机 DeepSeek Harness（`dsh --profile headless --json`）执行；运行状态与最终答案经工具事件回传对话，dsh 仍使用设置的 Magpie 网关，`/health` 会回报其可用性。可用 `PILOTRY_DSH_PATH`、`PILOTRY_DSH_PROFILE`（默认 headless）与 `PILOTRY_DSH_TIMEOUT_SECONDS`（默认 600 秒）调整。

Magpie 默认使用 `http://127.0.0.1:3425/v1` 与 `zhipu/glm-5.3-flash`。可使用 `MAGPIE_BASE_URL`、`MAGPIE_MODEL`、`MAGPIE_TOKEN` 调整，凭证仅在服务端读取。页面分析数据会传给所设置的模型服务。Python 引擎侧的模型访问同样指向该网关，基于 LangChain（`langchain-openai`）实现：状态探测走 OpenAI SDK，另提供 `POST /api/ai/ask` 单轮补全端点，详见 `engine/README.md`。

## 验证

```powershell
npm run build
npm test
node --check agent/server.mjs
node --check scripts/dev-stack.mjs
..\.venv\Scripts\python.exe -m py_compile engine/main.py engine/browser.py engine/lcu_bridge.py engine/lcu_browser.py engine/magpie.py
..\.venv\Scripts\python.exe -m unittest discover -s engine -p "test_*.py"
cargo check --manifest-path src-tauri/Cargo.toml
```

前端组件位于 `src/components/`，工作区状态与流式生命周期由 `src/hooks/useWorkspace.ts` 管理。模型服务位于 `agent/server.mjs`；浏览器工具的执行限制由 `engine/main.py` 再次检查。
