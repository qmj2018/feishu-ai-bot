import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";

function redact(message, env) {
  let text = String(message);
  for (const [key, value] of Object.entries(env)) {
    if (value && (/proxy/i.test(key) || ["OPENAI_API_KEY", "CODEX_API_KEY"].includes(key))) text = text.replaceAll(value, "[redacted]");
  }
  return text;
}

function launch(args, { env = process.env, command = "codex-acp", prefixArgs = ["cli"], timeoutMs = 60_000, initialRequest } = {}, onLine) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("测试超时必须为正数");
  const child = spawn(command, [...prefixArgs, ...args], { env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const lines = readline.createInterface({ input: child.stdout });
  let settled = false;
  let timer;
  let killTimer;
  const terminate = () => {
    const signal = value => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    signal("SIGTERM");
    killTimer = setTimeout(() => signal("SIGKILL"), 2000);
    killTimer.unref();
  };
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (child.pid && child.exitCode === null) terminate();
      if (error) reject(new Error(redact(error.message, env)));
      else resolve(value);
    };
    child.once("error", error => finish(new Error(`无法启动 Codex ACP，请先运行 install: ${error.code}`)));
    child.once("exit", () => clearTimeout(killTimer));
    child.once("close", code => {
      if (!settled) finish(new Error(`Codex 测试进程提前退出 (${code})；请检查登录、代理和模型配置`));
    });
    child.stdin.on("error", error => finish(error));
    child.once("spawn", () => {
      if (initialRequest) child.stdin.write(JSON.stringify(initialRequest) + "\n");
      else child.stdin.end();
    });
    child.stderr.resume();
    lines.on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      try { onLine(event, child, finish); } catch (error) { finish(error); }
    });
    timer = setTimeout(() => finish(new Error(`Codex 检查超时 (${timeoutMs / 1000}s)，请检查网络/代理和登录状态`)), timeoutMs);
  });
}

export async function listAvailableModels(options = {}) {
  let sent = false;
  const allModels = [];
  const request = (child, id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  const command = options.command || "codex-acp";
  const prefixArgs = options.prefixArgs || ["cli"];
  const initialRequest = { id: 1, method: "initialize", params: { clientInfo: { name: "devbox-codex-bot", version: "0.2.0" }, capabilities: { experimentalApi: true } } };
  return launch(["app-server"], { ...options, command, prefixArgs, initialRequest }, (event, child, finish) => {
    if (event.id === 1) {
      if (event.error) return finish(new Error(event.error.message));
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      request(child, 2, "model/list", { includeHidden: false, limit: 100 });
      sent = true;
    }
    if (event.id === 2 && sent) {
      if (event.error) return finish(new Error(event.error.message));
      const models = event.result?.data;
      if (!Array.isArray(models)) return finish(new Error("模型列表响应格式无效"));
      allModels.push(...models);
      if (event.result.nextCursor) return request(child, 2, "model/list", { includeHidden: false, limit: 100, cursor: event.result.nextCursor });
      if (!allModels.length) return finish(new Error("当前登录账号未返回可用模型"));
      finish(null, allModels.map(model => ({ id: model.model || model.id, name: model.displayName, isDefault: !!model.isDefault })));
    }
  });
}

export function chooseModel(models, requested, previous) {
  if (requested && requested !== "auto") return requested;
  if (requested !== "auto" && previous) return previous;
  const model = models.find(item => item.isDefault) || models[0];
  if (!model?.id) throw new Error("未找到可用模型，请使用 --model 指定模型 ID");
  return model.id;
}

export async function probeModel({ model, ...options }) {
  if (typeof model !== "string" || !model) throw new Error("模型测试需要模型 ID");
  const started = Date.now();
  let response = "";
  let completed = false;
  return launch(["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", os.tmpdir(), "--model", model, "--json", "Reply with DEPLOY_OK only. Do not use tools."], options, (event, child, finish) => {
    if (event.type === "error" || event.type === "turn.failed") return finish(new Error(event.message || event.error?.message || "模型测试失败"));
    if (event.type === "item.completed" && event.item?.type === "agent_message") response += event.item.text || "";
    if (event.type === "turn.completed") completed = true;
    if (completed && response.trim() === "DEPLOY_OK") finish(null, { ok: true, model, elapsedMs: Date.now() - started });
    else if (completed) finish(new Error("模型没有返回预期的测试回复"));
  });
}
