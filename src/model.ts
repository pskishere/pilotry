import type { BrowserStateDetail } from "./api";
import type { Conversation, TicketTask } from "./types";

export const PLATFORMS = [
  { label: "大麦", value: "damai" },
  { label: "猫眼", value: "maoyan" },
  { label: "Cityline", value: "cityline" },
  { label: "Tixcraft", value: "tixcraft" },
  { label: "Ticketmaster", value: "ticketmaster" },
  { label: "KKTIX", value: "kktix" },
  { label: "纷玩岛", value: "fenwandao" },
  { label: "票星球", value: "piaoxingqiu" },
];
export const STATUS_META: Record<
  TicketTask["status"],
  { label: string; color: string }
> = {
  created: { label: "已建立", color: "default" },
  monitoring: { label: "监控中", color: "processing" },
  selecting: { label: "选择中", color: "processing" },
  awaiting_approval: { label: "待确认", color: "warning" },
  order_created: { label: "已建立订单", color: "success" },
  manual_payment: { label: "待人工付款", color: "warning" },
  stopped: { label: "已停止", color: "default" },
  failed: { label: "失败", color: "error" },
};
export const PAGE_LABELS: Record<string, string> = {
  home: "首页",
  event_detail: "活动详情",
  performance: "场次选择",
  area: "票区选择",
  ticket: "张数表单",
  login: "登录页面",
  captcha: "验证码",
  payment: "付款页面",
  unknown: "未分类",
  offline: "未打开",
};
export const ACTION_LABELS: Record<string, string> = {
  extract_data: "提取数据",
  open_url: "打开页面",
  analyze_page: "分析页面",
  click_element: "点选元素",
  click_link: "点选链接",
  wait_for_page: "等待页面加载",
  request_human: "请求人工处理",
  finish: "完成",
  get_page: "读取页面",
};
export const OFFLINE_BROWSER: BrowserStateDetail = {
  connected: false,
  url: "",
  pageType: "offline",
  confidence: 0,
  title: "尚未打开页面",
  buttons: [],
  forms: [],
};
export function newConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "新对话",
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
    browse: "网页浏览",
    extract: "数据提取",
    form: "表单操作",
    ticket: "购票流程",
  };
  if (scenes[value]) return scenes[value];
  return PLATFORMS.find((platform) => platform.value === value)?.label ?? value;
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后再试。";
}
