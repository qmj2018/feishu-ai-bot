import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexUsageSnapshot, type UsageSnapshot, type QuotaWindow } from './codex.js';
import type { Environment } from './types.js';

export interface ContextUsage { used: number; size: number; measuredAt?: string }
export interface UsageReport extends UsageSnapshot { context?: ContextUsage }
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

// Only read the exact thread returned by Codex, and only its bounded tail.
// Transcript text is never included in the report.
export async function readContextUsage(file: string, sessionId: string, env: Environment = process.env): Promise<ContextUsage | undefined> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const home = await fs.realpath(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'));
    const realFile = await fs.realpath(file);
    const relative = path.relative(home, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(realFile).endsWith(`-${sessionId}.jsonl`)) return;
    handle = await fs.open(realFile, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const start = Math.max(0, stat.size - 1024 * 1024);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (const line of lines.reverse()) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      // A pre-compaction value no longer describes the compacted context.
      if (event.type === 'compacted') return;
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
      const info = event.payload.info;
      const used = info?.last_token_usage?.total_tokens;
      const size = info?.model_context_window;
      if (!nonnegative(used) || !nonnegative(size) || size === 0) continue;
      return { used, size, measuredAt: typeof event.timestamp === 'string' ? event.timestamp : undefined };
    }
  } catch { /* Older clients, missing files, and remote threads have no local snapshot. */ }
  finally { await handle?.close(); }
}

export async function readUsage({ sessionId, env = process.env }: { sessionId?: string; env?: Environment } = {}): Promise<UsageReport> {
  const snapshot = await readCodexUsageSnapshot({ sessionId, env });
  const context = snapshot.threadPath && sessionId ? await readContextUsage(snapshot.threadPath, sessionId, env) : undefined;
  return { ...snapshot, context };
}

function dateTime(seconds: number) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(seconds * 1000));
}
function windowText(window: QuotaWindow) {
  const minutes = window.windowDurationMins;
  const name = minutes === 10080 ? '周额度（7 天窗口）' : minutes === 300 ? '5 小时额度'
    : nonnegative(minutes) && minutes > 0 ? `${minutes} 分钟额度` : '额度窗口';
  const remaining = Math.max(0, 100 - window.usedPercent);
  const reset = nonnegative(window.resetsAt) && window.resetsAt < 8.64e12 ? `；重置 ${dateTime(window.resetsAt)}（北京时间）` : '';
  return `${name}：已用 ${window.usedPercent.toFixed(1)}%，剩余 ${remaining.toFixed(1)}%${reset}`;
}

export function formatUsage(report: UsageReport, { hasSession = false, running = false }: { hasSession?: boolean; running?: boolean } = {}) {
  const lines = ['Codex 用量', '账号额度（本机登录账号共享）：'];
  const byId = Object.entries(report.account?.rateLimitsByLimitId || {}).filter(([, value]) => value);
  const buckets = byId.length ? byId : report.account?.rateLimits ? [[report.account.rateLimits.limitId || 'codex', report.account.rateLimits] as const] : [];
  let windows = 0;
  for (const [id, bucket] of buckets) {
    for (const window of [bucket?.primary, bucket?.secondary]) {
      if (!window || !nonnegative(window.usedPercent)) continue;
      lines.push(`${buckets.length > 1 ? `${bucket?.limitName || id} / ` : ''}${windowText(window)}`);
      windows++;
    }
  }
  if (!windows) lines.push('暂不可用（账号或当前客户端未提供额度数据）。');
  if (report.account?.ordinaryUsageAllowed === false) lines.push('服务端报告：当前不可使用普通包含额度。');
  lines.push('', '当前会话上下文：');
  const context = report.context;
  if (context && nonnegative(context.used) && nonnegative(context.size) && context.size > 0) {
    const percent = 100 * context.used / context.size;
    lines.push(`已用 ${percent.toFixed(1)}%，剩余 ${Math.max(0, 100 - percent).toFixed(1)}%`);
    lines.push(`${context.used.toLocaleString('en-US')} / ${context.size.toLocaleString('en-US')} tokens（最近一次模型调用快照）`);
    if (context.measuredAt && Number.isFinite(Date.parse(context.measuredAt))) lines.push(`快照时间：${dateTime(Date.parse(context.measuredAt) / 1000)}（北京时间）`);
  } else lines.push(hasSession ? '暂不可用，尚无可读取的当前会话上下文快照。' : '尚未建立会话，发送任务后可查询。');
  if (running) lines.push('任务正在执行；上下文数据会随模型调用更新。');
  return lines.join('\n');
}
