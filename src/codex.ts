import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Environment, Model } from './types.js';
interface ModelWire extends Omit<Model, 'id'> { id?: string; model?: string; displayName?: string }
interface CodexEvent {
  id?: number; type?: string; message?: string;
  error?: { message?: string }; result?: AccountUsage & { data?: ModelWire[]; nextCursor?: string; thread?: { id: string; path?: string | null } };
  item?: { type?: string; text?: string };
}
interface CodexOptions { env?: Environment; command?: string; prefixArgs?: string[]; timeoutMs?: number; initialRequest?: unknown }
type Finish<T> = (error: Error | null, value?: T) => void;
export interface ProbeResult { ok: boolean; model: string; elapsedMs: number }
export interface QuotaWindow { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }
export interface QuotaBucket { limitId?: string | null; limitName?: string | null; primary?: QuotaWindow | null; secondary?: QuotaWindow | null }
export interface AccountUsage {
  rateLimits?: QuotaBucket;
  rateLimitsByLimitId?: Record<string, QuotaBucket | undefined> | null;
  ordinaryUsageAllowed?: boolean | null;
}
export interface UsageSnapshot { account?: AccountUsage; threadPath?: string }
import { spawn } from "node:child_process";
import readline from "node:readline";
import os from "node:os";
import { localCodexPath } from "./local-codex.js";
import { APP_ID } from './identity.js';

function redact(message: unknown, env: Environment) {
  let text = String(message);
  for (const [key, value] of Object.entries(env)) {
    if (value && (/proxy/i.test(key) || ["OPENAI_API_KEY", "CODEX_API_KEY"].includes(key))) text = text.replaceAll(value, "[redacted]");
  }
  return text;
}

function launch<T>(args: string[], { env = process.env, command = localCodexPath(env), prefixArgs = [], timeoutMs = 60_000, initialRequest }: CodexOptions = {}, onLine: (event: CodexEvent, child: ChildProcessWithoutNullStreams, finish: Finish<T>) => void): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("测试超时必须为正数");
  const child = spawn(command, [...prefixArgs, ...args], { env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const lines = readline.createInterface({ input: child.stdout });
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    signal("SIGTERM");
    killTimer = setTimeout(() => signal("SIGKILL"), 2000);
    killTimer.unref();
  };
  return new Promise<T>((resolve, reject) => {
    const finish: Finish<T> = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (child.pid && child.exitCode === null) terminate();
      if (error) reject(new Error(redact(error.message, env)));
      else resolve(value as T);
    };
    child.once("error", (error: NodeJS.ErrnoException) => finish(new Error(`无法启动本机 Codex (${command})，请运行部署或启动命令安装/升级: ${error.code}`)));
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
      let event: CodexEvent;
      try { event = JSON.parse(line); } catch { return; }
      try { onLine(event, child, finish); } catch (error) { finish(error); }
    });
    timer = setTimeout(() => finish(new Error(`Codex 检查超时 (${timeoutMs / 1000}s)，请检查网络/代理和登录状态`)), timeoutMs);
  });
}

export async function listAvailableModels(options: CodexOptions = {}): Promise<Model[]> {
  let sent = false;
  const allModels: ModelWire[] = [];
  const request = (child: ChildProcessWithoutNullStreams, id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  const command = options.command || localCodexPath(options.env);
  const prefixArgs = options.prefixArgs || [];
  const initialRequest = { id: 1, method: "initialize", params: { clientInfo: { name: APP_ID, version: "0.2.0" }, capabilities: { experimentalApi: true } } };
  return launch<Model[]>(["app-server"], { ...options, command, prefixArgs, initialRequest }, (event, child, finish) => {
    if (event.id === 1) {
      if (event.error) return finish(new Error(event.error.message || "Codex protocol error"));
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      request(child, 2, "model/list", { includeHidden: false, limit: 100 });
      sent = true;
    }
    if (event.id === 2 && sent) {
      if (event.error) return finish(new Error(event.error.message || "Codex protocol error"));
      const models = event.result?.data;
      if (!Array.isArray(models)) return finish(new Error("模型列表响应格式无效"));
      allModels.push(...models);
      const cursor = event.result?.nextCursor;
      if (cursor) return request(child, 2, "model/list", { includeHidden: false, limit: 100, cursor });
      if (!allModels.length) return finish(new Error("当前登录账号未返回可用模型"));
      finish(null, allModels.map(model => ({
        id: model.model || model.id || "", name: model.displayName, isDefault: !!model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [],
      })));
    }
  });
}

export function chooseModel(models: Model[], requested?: string, previous?: string) {
  if (requested && requested !== "auto") return requested;
  if (requested !== "auto" && previous) return previous;
  const model = models.find(item => item.isDefault) || models[0];
  if (!model?.id) throw new Error("未找到可用模型，请使用 --model 指定模型 ID");
  return model.id;
}

// Read telemetry only: never resume a thread or send a model prompt.
export async function readCodexUsageSnapshot({ sessionId, ...options }: CodexOptions & { sessionId?: string } = {}): Promise<UsageSnapshot> {
  const snapshot: UsageSnapshot = {};
  const pending = new Set(sessionId ? [2, 3] : [2]);
  const initialRequest = { id: 1, method: 'initialize', params: {
    clientInfo: { name: APP_ID, version: '0.3.0' }, capabilities: { experimentalApi: true },
  } };
  return launch<UsageSnapshot>(['app-server'], { timeoutMs: 10_000, ...options, initialRequest }, (event, child, finish) => {
    if (event.id === 1) {
      if (event.error) return finish(new Error('Codex 用量接口初始化失败'));
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }) + '\n');
      if (sessionId) child.stdin.write(JSON.stringify({ id: 3, method: 'thread/read', params: { threadId: sessionId, includeTurns: false } }) + '\n');
    }
    if (event.id === undefined || !pending.delete(event.id)) return;
    if (!event.error && event.id === 2) snapshot.account = event.result;
    const thread = event.result?.thread;
    if (!event.error && event.id === 3 && thread && thread.id === sessionId) snapshot.threadPath = thread.path || undefined;
    if (!pending.size) finish(null, snapshot);
  });
}

export async function probeModel({ model, ...options }: CodexOptions & { model: string }): Promise<ProbeResult> {
  if (typeof model !== "string" || !model) throw new Error("模型测试需要模型 ID");
  const started = Date.now();
  let response = "";
  let completed = false;
  return launch<ProbeResult>(["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", os.tmpdir(), "--model", model, "--json", "Reply with DEPLOY_OK only. Do not use tools."], options, (event, child, finish) => {
    if (event.type === "error" || event.type === "turn.failed") return finish(new Error(event.message || event.error?.message || "模型测试失败"));
    if (event.type === "item.completed" && event.item?.type === "agent_message") response += event.item.text || "";
    if (event.type === "turn.completed") completed = true;
    if (completed && response.trim() === "DEPLOY_OK") finish(null, { ok: true, model, elapsedMs: Date.now() - started });
    else if (completed) finish(new Error("模型没有返回预期的测试回复"));
  });
}
