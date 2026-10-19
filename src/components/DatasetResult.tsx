import { Button, Space } from "antd";
import { DownloadOutlined } from "@ant-design/icons";

interface Dataset {
  kind: string;
  url: string;
  title: string;
  capturedAt: string;
  records: Record<string, unknown>[];
}
function download(dataset: Dataset, format: "json" | "csv") {
  const cell = (value: unknown) => {
    let text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const keys = [...new Set(dataset.records.flatMap((row) => Object.keys(row)))];
  const content =
    format === "json"
      ? JSON.stringify(dataset, null, 2)
      : "\uFEFF" +
        [
          keys.map(cell).join(","),
          ...dataset.records.map((row) =>
            keys.map((key) => cell(row[key])).join(","),
          ),
        ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([content], {
      type:
        format === "json"
          ? "application/json;charset=utf-8"
          : "text/csv;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `page-data-${Date.now()}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DatasetResult({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const dataset = value as Dataset;
  if (!Array.isArray(dataset.records)) return null;
  return (
    <div className="dataset-result">
      <strong>
        已擷取 {dataset.records.length} 筆
        {dataset.kind === "tables"
          ? "表格列"
          : dataset.kind === "links"
            ? "連結"
            : "文字資料"}
      </strong>
      <Space wrap>
        <Button
          size="small"
          icon={<DownloadOutlined />}
          onClick={() => download(dataset, "json")}
        >
          下載 JSON
        </Button>
        <Button size="small" onClick={() => download(dataset, "csv")}>
          下載 CSV
        </Button>
      </Space>
      <span>範圍：目前已載入的頁面</span>
    </div>
  );
}
