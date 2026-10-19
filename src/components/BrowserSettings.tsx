import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Select, Tag } from "antd";
import { GlobalOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { BrowserRuntime } from "../api";
import { connectEmbedded, desktopHost, nativeHostInfo } from "../browserHost";
import type { Workspace } from "../hooks/useWorkspace";
import { errorText } from "../model";

export function BrowserSettings({ workspace }: { workspace: Workspace }) {
  const { message } = App.useApp();
  const [runtime, setRuntime] = useState<BrowserRuntime | null>(null);
  const [selected, setSelected] = useState("auto");
  const [path, setPath] = useState("");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:9222");
  const [targets, setTargets] = useState<
    { id: string; title: string; url: string }[]
  >([]);
  const [targetId, setTargetId] = useState<string>();
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api
      .browserRuntime()
      .then((value) => {
        if (!cancelled) {
          setRuntime(value);
          setSelected(value.current.id);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error));
      });
    void nativeHostInfo()
      .then((info) => {
        if (!cancelled) setNative(info?.available === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      if ((await api.agentHealth()).running) throw new Error("Agent 正在執行，請先停止或等待完成後再切換瀏覽器。");
      const page =
        selected === "embedded"
          ? await connectEmbedded()
          : await api.configureBrowser({
              id: selected,
              ...(selected === "custom" ? { path } : {}),
              ...(selected === "cdp"
                ? { endpoint, targetId: targetId || "" }
                : {}),
            });
      workspace.setBrowser(page);
      setRuntime(await api.browserRuntime());
      await workspace.refresh();
      void message.success("瀏覽器已連線；各瀏覽器的登入狀態獨立保存。");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section panel">
      <div className="settings-section-title">
        <GlobalOutlined />
        <div>
          <h2>瀏覽器</h2>
          <p>共用 Agent 與流程庫；切換會結束目前由程式啟動的瀏覽器</p>
        </div>
        <Tag>{runtime?.current.label || "尚未讀取"}</Tag>
      </div>
      <div className="setting-row">
        <div>
          <strong>執行環境</strong>
          <span>內嵌模式需要 Tauri 桌面版；外置模式使用獨立設定檔</span>
        </div>
        <Select
          aria-label="瀏覽器執行環境"
          value={selected}
          disabled={busy || !!workspace.runningId}
          style={{ minWidth: 200 }}
          onChange={(value) => {
            setSelected(value);
            setError("");
          }}
          options={[
            {
              value: "embedded",
              label: native
                ? "Tauri 內嵌 WebView2"
                : desktopHost
                  ? "此系統尚未支援內嵌 CDP"
                  : "Tauri 內嵌（需桌面版）",
              disabled: !native,
            },
            { value: "auto", label: "自動選擇 Chromium" },
            ...(runtime?.browsers ?? []).map((item) => ({
              value: item.id,
              label: item.label + (item.available ? "" : "（未安裝）"),
              disabled: !item.available,
            })),
            { value: "custom", label: "自訂 Chromium 執行檔" },
            { value: "cdp", label: "連接本機 CDP 分頁" },
          ]}
        />
      </div>
      {selected === "custom" && (
        <div className="browser-configuration">
          <label htmlFor="browser-executable">瀏覽器執行檔</label>
          <Input
            id="browser-executable"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="C:\\...\\chrome.exe"
          />
        </div>
      )}
      {selected === "cdp" && (
        <div className="browser-configuration">
          <label htmlFor="browser-endpoint">本機 CDP 端點</label>
          <Input
            id="browser-endpoint"
            value={endpoint}
            onChange={(event) => {
              setEndpoint(event.target.value);
              setTargets([]);
              setTargetId(undefined);
            }}
          />
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setTargets(await api.browserTargets(endpoint));
                setError("");
              } catch (error) {
                setError(errorText(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            讀取分頁
          </Button>
          <Select
            aria-label="CDP 目標分頁"
            placeholder="選擇要接管的分頁"
            value={targetId}
            onChange={setTargetId}
            options={targets.map((target) => ({
              value: target.id,
              label: target.title || target.url,
            }))}
          />
        </div>
      )}
      <div className="browser-configuration">
        <Button
          onClick={() => void apply()}
          loading={busy}
          disabled={
            !workspace.online ||
            !!workspace.runningId ||
            (selected === "cdp" && !targetId) ||
            (selected === "embedded" && !native)
          }
        >
          連線至所選瀏覽器
        </Button>
        <span>Firefox / Safari 不是 Chromium，尚未提供此執行器。</span>
      </div>
      {error && <Alert type="warning" title={error} showIcon />}
    </section>
  );
}
