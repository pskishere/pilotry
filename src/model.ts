import type { BrowserStateDetail } from "./api";
import type { Conversation, TicketTask } from "./types";

export const PLATFORMS = [
  { label: "大麥", value: "damai" },
  { label: "貓眼", value: "maoyan" },
  { label: "Cityline", value: "cityline" },
  { label: "Tixcraft", value: "tixcraft" },
  { label: "Ticketmaster", value: "ticketmaster" },
  { label: "KKTIX", value: "kktix" },
  { label: "紛玩島", value: "fenwandao" },
  { label: "票星球", value: "piaoxingqiu" },
];
export const STATUS_META: Record<
  TicketTask["status"],
  { label: string; color: string }
> = {
  created: { label: "已建立", color: "default" },
  monitoring: { label: "監控中", color: "processing" },
  selecting: { label: "選擇中", color: "processing" },
  awaiting_approval: { label: "待確認", color: "warning" },
  order_created: { label: "已建立訂單", color: "success" },
  manual_payment: { label: "待人工付款", color: "warning" },
  stopped: { label: "已停止", color: "default" },
  failed: { label: "失敗", color: "error" },
};
export const PAGE_LABELS: Record<string, string> = {
  home: "首頁",
  event_detail: "活動詳情",
  performance: "場次選擇",
  area: "票區選擇",
  ticket: "張數表單",
  login: "登入頁面",
  captcha: "驗證碼",
  payment: "付款頁面",
  unknown: "未分類",
  offline: "未開啟",
};
export const ACTION_LABELS: Record<string, string> = {
  extract_data: "擷取資料",
  open_url: "開啟頁面",
  analyze_page: "分析頁面",
  click_element: "點選元素",
  click_link: "點選連結",
  wait_for_page: "等待頁面載入",
  request_human: "等待人工處理",
  finish: "完成",
  get_page: "讀取頁面",
};
export const OFFLINE_BROWSER: BrowserStateDetail = {
  connected: false,
  url: "",
  pageType: "offline",
  confidence: 0,
  title: "尚未開啟頁面",
  buttons: [],
  forms: [],
};
export function newConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "新對話",
    messages: [],
    steps: [],
    updatedAt: new Date().toISOString(),
  };
}
export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function platformName(value: string) {
  const scenes: Record<string, string> = {
    web: "一般操作",
    browse: "網頁瀏覽",
    extract: "資料擷取",
    form: "表單操作",
    ticket: "購票流程",
  };
  if (scenes[value]) return scenes[value];
  return PLATFORMS.find((platform) => platform.value === value)?.label ?? value;
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作失敗，請稍後再試。";
}
