# Pilotry Engine

Python 引擎透過 zendriver + CDP 管理一個可見的 Chrome 工作階段，並提供頁面快照、截圖與任務 API。Agent 串流由 `../agent/server.mjs` 的 AI SDK `streamText` 負責，瀏覽器操作仍在 Python 引擎執行。

```powershell
..\.venv\Scripts\python.exe engine/main.py
```

`POST /api/agent/tool` 接收受限工具呼叫。工具可開啟真實網站、讀取頁面內容，並透過 CDP 點選快照中唯一且可見的連結或一般按鈕。訂單提交和帳號操作需由使用者處理。引擎不實作自動付款。

任務目前保存在記憶體，不具備背景監控或持久化功能；尚未實作網站訂單擷取。完整開發啟動方式見上一層 README。
