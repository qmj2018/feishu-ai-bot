import crypto from 'node:crypto';
import type { Card, CardCallback, ChatMessage } from './types.js';

export type BusyChoice = 'queue' | 'parallel' | 'discard';
export interface BusyTask {
  message: ChatMessage; key: string; scopeKey: string; expires: number; messageId?: string;
}
const choices = new Set(['queue', 'parallel', 'discard']);

export class BusyTasks {
  entries = new Map<string, BusyTask>();
  create(message: ChatMessage, key: string, scopeKey: string, sharedDirectory: boolean) {
    for (const [token, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(token);
    if (this.entries.size >= 200 || [...this.entries.values()].filter(e => e.scopeKey === scopeKey).length >= 3) {
      throw new Error('待选择的消息已满，请先处理之前的选择。');
    }
    const token = crypto.randomBytes(16).toString('hex');
    const entry: BusyTask = { message, key, scopeKey, expires: Date.now() + 10 * 60_000 };
    this.entries.set(token, entry);
    const card: Card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '当前会话有任务正在执行' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `新消息尚未执行，请选择处理方式（10 分钟内有效）。\n${message.text.slice(0, 300)}\n新会话使用独立上下文，原任务继续执行。${sharedDirectory ? '并行会话共享项目目录，请避免同时修改同一文件。' : '新会话会创建独立 worktree。'}` } },
        { tag: 'action', actions: [{ tag: 'select_static', placeholder: { tag: 'plain_text', content: '选择处理方式' },
          options: [
            { text: { tag: 'plain_text', content: '排队等待当前任务结束' }, value: 'queue' },
            { text: { tag: 'plain_text', content: '新会话并行处理' }, value: 'parallel' },
            { text: { tag: 'plain_text', content: '取消这条消息' }, value: 'discard' },
          ], value: { action: 'task.choose', token } } ] },
      ],
    };
    return { token, entry, card };
  }
  fromCard(data: CardCallback, allowedUsers?: string[]) {
    const token = data.action?.value?.token || '';
    const entry = this.entries.get(token);
    const choice = data.action?.option;
    if (!entry || entry.expires <= Date.now() || data.action?.value?.action !== 'task.choose'
      || !allowedUsers?.includes(data.operator?.open_id || '') || entry.message.owner !== data.operator?.open_id
      || entry.message.chat !== data.context?.open_chat_id || !entry.messageId || entry.messageId !== data.context?.open_message_id
      || !choice || !choices.has(choice)) return null;
    return { token, entry, choice: choice as BusyChoice };
  }
  fromText(message: ChatMessage, scopeKey: string) {
    const match = /^\/task ([a-f0-9]{32}) (queue|parallel|discard)$/.exec(message.text);
    if (!match) return null;
    const entry = this.entries.get(match[1]);
    if (!entry || entry.expires <= Date.now() || entry.message.owner !== message.owner || entry.message.chat !== message.chat || entry.scopeKey !== scopeKey) return null;
    return { token: match[1], entry, choice: match[2] as BusyChoice };
  }
}
