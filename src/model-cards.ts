import type { Provider, Model, Card, CardCallback, ChatMessage } from './types.js';
interface CardEntry { owner: string; chat: string; key: string; provider: Provider; models: Model[]; expires: number; messageId?: string; message?: ChatMessage }
interface CardRequest { owner: string; chat: string; key: string; provider: Provider; models: Model[]; current?: string }
import crypto from 'node:crypto';
import { listAvailableModels } from './codex.js';
import { listClaudeModels } from './claude-client.js';

export async function discoverModels(provider: Provider): Promise<Model[]> {
  if (provider === 'codex') return listAvailableModels();
  if (provider === 'claude') return listClaudeModels();
  throw new Error('Unknown model provider');
}

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
export const effortLabel = (effort: string) => EFFORT_LABELS[effort] || effort;

export function modelChoices(provider: Provider, models: Model[]): Model[] {
  if (provider !== 'codex') return models;
  return models.flatMap(model => {
    const efforts = [...new Set((Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map(option => option?.reasoningEffort).filter(value => typeof value === 'string' && value.length > 0 && value.length <= 64))];
    if (!efforts.length) return [model];
    return efforts.map(effort => ({ ...model, effort,
      name: `${model.name || model.id} / ${effortLabel(effort)}${effort === model.defaultReasoningEffort ? '（默认）' : ''}`,
    }));
  });
}

export class ModelCards {
  entries = new Map<string, CardEntry>();
  ttlMs: number;
  constructor({ ttlMs = 10 * 60_000 } = {}) { this.ttlMs = ttlMs; }
  create({ owner, chat, key, provider, models, current }: CardRequest) {
    for (const [token, entry] of this.entries) if (entry.expires < Date.now()) this.entries.delete(token);
    while (this.entries.size >= 200) this.entries.delete(this.entries.keys().next().value!);
    models = modelChoices(provider, models);
    if (!models.length || models.length > 1000) throw new Error('Model option count out of bounds');
    const token = crypto.randomBytes(24).toString('hex');
    const entry: CardEntry = { owner, chat, key, provider, models, expires: Date.now() + this.ttlMs };
    this.entries.set(token, entry);
    const options = models.map((m, index) => ({ text: { tag: 'plain_text', content: String(m.name || m.id).slice(-80) }, value: String(index) }));
    const card: Card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `${provider === 'codex' ? 'Codex' : 'Claude'} 模型选择` }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `当前：${current || '默认模型'}。选择后仅切换本对话中你的会话；10 分钟内有效。` } },
        ...Array.from({ length: Math.ceil(options.length / 100) }, (_, i) => ({ tag: 'action', actions: [{
          tag: 'select_static', placeholder: { tag: 'plain_text', content: `选择${provider === 'codex' ? '模型与推理强度' : '模型'}${options.length > 100 ? `（${i + 1}）` : ''}` },
          options: options.slice(i * 100, (i + 1) * 100), value: { action: 'model.select', token },
        }] })),
      ],
    };
    return { token, entry, card };
  }
  consume(data: CardCallback, allowedUsers?: string[]) {
    const token = data?.action?.value?.token;
    const entry = this.entries.get(token || '');
    const owner = data?.operator?.open_id;
    const chat = data?.context?.open_chat_id;
    const message = data?.context?.open_message_id;
    const option = data?.action?.option;
    if (!token || data?.action?.value?.action !== 'model.select' || !entry || entry.expires < Date.now() || (!owner || !allowedUsers?.includes(owner))
      || owner !== entry.owner || chat !== entry.chat || !entry.messageId || message !== entry.messageId
      || typeof option !== 'string' || !/^(0|[1-9][0-9]*)$/.test(option) || !entry.models[Number(option)]) return null;
    this.entries.delete(token);
    return { ...entry, model: entry.models[Number(option)] };
  }
}
