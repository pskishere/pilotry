import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(resolve(root, ".env.local"))) process.loadEnvFile(resolve(root, ".env.local"));
const engineUrl = process.env.VITE_ENGINE_URL || "http://127.0.0.1:8765";
const agentUrl = process.env.VITE_AGENT_URL || "http://127.0.0.1:8766";
process.env.ENGINE_PORT ||= new URL(engineUrl).port;
process.env.ENGINE_URL ||= engineUrl;
process.env.AGENT_PORT ||= new URL(agentUrl).port;
const python =
  process.env.PILOTRY_PYTHON ||
  resolve(
    root,
    "..",
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const children = [];
let stopping = false;

async function reachable(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1200) })).ok;
  } catch {
    return false;
  }
}
function launch(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (!stopping) shutdown(code ?? 0);
  });
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
if (!(await reachable(engineUrl + "/api/browser/state"))) {
  if (!existsSync(python))
    throw new Error(
      "找不到 Python 環境，請設定 PILOTRY_PYTHON 為已安裝 zendriver 的 Python 路徑。",
    );
  launch(python, ["engine/main.py"]);
}
if (!(await reachable(agentUrl + "/health")))
  launch(process.execPath, ["agent/server.mjs"]);
if (!(await reachable("http://127.0.0.1:1420/"))) {
  launch(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]);
} else if (!children.length) {
  setInterval(() => {}, 60000);
}
