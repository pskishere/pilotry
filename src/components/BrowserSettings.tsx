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
  const lcu = runtime?.current.id === "lcu";
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
      if ((await api.agentHealth()).running) throw new Error("Agent 正在执行，请先停止或等待完成后再切换浏览器。");
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
      void message.success("浏览器已连接；各浏览器的登录状态独立保存。");
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
          <h2>浏览器</h2>
          <p>共用 Agent 与流程库；切换会结束目前由程序启动的浏览器</p>
        </div>
        <Tag>{runtime?.current.label || "尚未读取"}</Tag>
      </div>
      <div className="setting-row">
        <div>
          <strong>执行环境</strong>
          <span>内嵌模式需要 Tauri 桌面版；外置模式使用独立配置文件</span>
        </div>
        <Select
          aria-label="浏览器执行环境"
          value={selected}
          disabled={busy || !!workspace.runningId || lcu}
          style={{ minWidth: 200 }}
          onChange={(value) => {
            setSelected(value);
            setError("");
          }}
          options={[
            ...(lcu
              ? [{ value: "lcu", label: "本机 Chrome（LCU）" }]
              : []),
            {
              value: "embedded",
              label: native
                ? "Tauri 内嵌 WebView2"
                : desktopHost
                  ? "此系统尚未支持内嵌 CDP"
                  : "Tauri 内嵌（需桌面版）",
              disabled: !native,
            },
            { value: "auto", label: "自动选择 Chromium" },
            ...(runtime?.browsers ?? []).map((item) => ({
              value: item.id,
              label: item.label + (item.available ? "" : "（未安装）"),
              disabled: !item.available,
            })),
            { value: "custom", label: "自订 Chromium 可执行文件" },
            { value: "cdp", label: "连接本机 CDP 分页" },
          ]}
        />
      </div>
      {selected === "custom" && (
        <div className="browser-configuration">
          <label htmlFor="browser-executable">浏览器可执行文件</label>
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
          <label htmlFor="browser-endpoint">本机 CDP 端点</label>
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
            读取分页
          </Button>
          <Select
            aria-label="CDP 目标分页"
            placeholder="选择要接管的分页"
            value={targetId}
            onChange={setTargetId}
            options={targets.map((target) => ({
              value: target.id,
              label: target.title || target.url,
            }))}
          />
        </div>
      )}
      {lcu ? (
        <Alert
          type="info"
          showIcon
          title="当前使用 LCU 本机 Chrome：直接复用你日常 Chrome 的登录状态，浏览器选择由 LCU 管理。"
        />
      ) : (
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
            连接至所选浏览器
          </Button>
          <span>Firefox / Safari 不是 Chromium，尚未提供此执行器。</span>
        </div>
      )}
      {error && <Alert type="warning" title={error} showIcon />}
    </section>
  );
}
