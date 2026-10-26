import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { App, Button, Image, Input, Tooltip, Alert } from "antd";
import {
  ArrowRightOutlined,
  GlobalOutlined,
  LinkOutlined,
  ReloadOutlined,
  ExpandOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import type { Workspace } from "../hooks/useWorkspace";
import { api } from "../api";
import { errorText, PAGE_LABELS } from "../model";
import { desktopHost, nativeHostInfo } from "../browserHost";
import { useNativeViewport } from "../hooks/useNativeViewport";

export function BrowserPanel({
  workspace,
  headerTabs,
  active = true,
}: {
  workspace: Workspace;
  headerTabs?: ReactNode;
  active?: boolean;
}) {
  const { message } = App.useApp();
  const { browser, online, preferences } = workspace;
  const [hostEndpoint, setHostEndpoint] = useState("");
  useEffect(() => {
    void nativeHostInfo()
      .then((info) => setHostEndpoint(info?.endpoint || ""))
      .catch(() => {});
  }, []);
  const native =
    desktopHost &&
    Boolean(hostEndpoint) &&
    browser.runtime?.mode === "embedded" &&
    browser.runtime.endpoint === hostEndpoint;
  const nativeViewport = useNativeViewport(native && active);
  const [url, setUrl] = useState("");
  const [opening, setOpening] = useState(false);
  const [frame, setFrame] = useState("");
  const [frameError, setFrameError] = useState("");
  const [paused, setPaused] = useState(false);
  const [preview, setPreview] = useState(false);
  const [frameAt, setFrameAt] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setUrl(browser.url.startsWith("about:blank") ? "" : browser.url);
  }, [browser.url]);
  useEffect(() => {
    setFrame("");
    setFrameAt("");
    setFrameError("");
  }, [browser.url, browser.connected]);
  useEffect(() => {
    if (
      !active ||
      native ||
      !online ||
      !browser.connected ||
      paused ||
      !preferences.livePreview
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const fetchFrame = async () => {
      if (!document.hidden) {
        try {
          const result = await api.browserScreenshot(
            AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
          );
          if (!controller.signal.aborted && result.data) {
            setFrame(
              `data:${result.mime || "image/jpeg"};base64,${result.data}`,
            );
            setFrameError("");
            setFrameAt(
              new Date().toLocaleTimeString("zh-TW", { hour12: false }),
            );
          } else if (!controller.signal.aborted) setFrameError("尚未取得画面");
        } catch {
          if (!controller.signal.aborted)
            setFrameError("画面更新中断，将自动重试");
        }
      }
      if (!controller.signal.aborted)
        timer = setTimeout(fetchFrame, preferences.frameInterval);
    };
    void fetchFrame();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    browser.connected,
    browser.url,
    online,
    paused,
    preferences.livePreview,
    preferences.frameInterval,
    revision,
    active,
    native,
  ]);

  const open = async (target: string) => {
    if (!target.trim()) return;
    try {
      const normalized = /^https?:\/\//i.test(target)
        ? target
        : `https://${target}`;
      const parsed = new URL(normalized);
      if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol))
        throw new Error("请输入有效的 HTTP 或 HTTPS 网址。");
      setOpening(true);
      workspace.setBrowser(await api.openBrowser(parsed.href));
      void workspace.refresh();
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="browser-panel panel" aria-label="浏览器画面">
      <div className="panel-heading">
        {headerTabs || (
          <div className="panel-title">
            <GlobalOutlined />
            <h2>浏览器</h2>
            <span
              className={`subtle-label ${browser.connected ? "connected" : ""}`}
            >
              {browser.connected ? "已连接" : "未打开"}
            </span>
          </div>
        )}
        <div className="panel-actions" hidden={native}>
          <Tooltip title="重新取得画面">
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined />}
              aria-label="重新取得画面"
              disabled={!browser.connected}
              onClick={() => {
                setRevision((value) => value + 1);
                void workspace.refresh();
              }}
            />
          </Tooltip>
          <Tooltip title={paused ? "继续更新画面" : "暂停更新画面"}>
            <Button
              type="text"
              size="small"
              icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />}
              aria-label={paused ? "继续更新画面" : "暂停更新画面"}
              disabled={!browser.connected}
              onClick={() => setPaused((value) => !value)}
            />
          </Tooltip>
          <Tooltip title="放大画面">
            <Button
              type="text"
              size="small"
              icon={<ExpandOutlined />}
              aria-label="放大画面"
              disabled={!frame}
              onClick={() => setPreview(true)}
            />
          </Tooltip>
        </div>
      </div>
      <form
        className="browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          void open(url);
        }}
      >
        <Input
          aria-label="页面网址"
          prefix={<LinkOutlined />}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="输入网页网址"
          disabled={opening || !!workspace.runningId}
        />
        <Button
          type="primary"
          htmlType="submit"
          icon={<ArrowRightOutlined />}
          aria-label="打开网址"
          loading={opening}
          disabled={!online || !url.trim() || !!workspace.runningId}
        />
      </form>
      <div
        className={`browser-canvas ${frame ? "has-frame" : ""} ${native ? "native-canvas" : ""}`}
      >
        {native ? (
          <div
            className="native-browser-viewport"
            ref={nativeViewport.ref}
            aria-label="可直接操作的内嵌网页"
          >
            {nativeViewport.error && (
              <Alert type="warning" title={nativeViewport.error} />
            )}
          </div>
        ) : frame ? (
          <Image
            className="browser-frame"
            src={frame}
            alt={`浏览器画面：${browser.title}`}
            preview={{ open: preview, onOpenChange: setPreview }}
          />
        ) : (
          <div className="browser-empty">
            <GlobalOutlined className="browser-empty-icon" />
            <h3>
              {browser.connected
                ? !preferences.livePreview
                  ? "即时预览已关闭"
                  : "正在读取画面"
                : "尚未打开页面"}
            </h3>
            <p>
              {browser.connected
                ? "浏览器会在独立窗口中执行，你也可以在这里查看画面。"
                : "输入网址打开页面，或在对话中指定操作。"}
            </p>
          </div>
        )}
        {opening && (
          <div className="browser-busy" role="status">
            <ReloadOutlined spin /> 正在打开页面
          </div>
        )}
        {frameError && (
          <div className="frame-error" role="status">
            {frameError}
          </div>
        )}
      </div>
      {browser.error && <Alert type="warning" title={browser.error} showIcon />}
      <div className="browser-caption">
        <span>
          <DesktopOutlined />
          {browser.runtime?.label ? `${browser.runtime.label} · ` : ""}
          {PAGE_LABELS[browser.pageType] ?? browser.pageType}
          {browser.connected
            ? ` · ${Math.round(browser.confidence * 100)}% 辨识信心`
            : " · 等待操作"}
        </span>
        <span>
          {paused
            ? "画面已暂停"
            : frameAt
              ? `更新于 ${frameAt}`
              : "浏览器由本机执行"}
        </span>
      </div>
    </section>
  );
}
