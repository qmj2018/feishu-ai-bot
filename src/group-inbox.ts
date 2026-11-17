import fs from 'node:fs';
import path from 'node:path';
import { saveJson } from './storage.js';
import type { FeishuMessageEvent } from './types.js';

export interface GroupMessage {
  id: string; chat: string; sender: string; type: string; text: string;
  thread: string; timestamp: number; truncated: boolean;
}
const RETENTION_MS = 7 * 24 * 3600_000;
const MAX_TOTAL = 500;
const MAX_PER_CHAT = 100;

function messageText(type: string, content: string) {
  if (type !== 'text' && type !== 'post') return `[${type}]`;
  let value;
  try { value = JSON.parse(content); } catch { return; }
  if (type === 'text') return typeof value.text === 'string' ? value.text : undefined;
  const post = Array.isArray(value.content) ? value : Object.values(value).find((item: any) => Array.isArray(item?.content)) as any;
  if (!post) return;
  return [post.title || '', ...post.content.map((row: any[]) => row.map(item => {
    if (typeof item.text === 'string') return item.text;
    if (item.tag === 'a') return item.href || '';
    if (item.tag === 'at') return '@' + (item.user_name || item.user_id || '');
    return item.tag === 'img' ? '[image]' : '';
  }).join(''))].filter(Boolean).join('\n');
}

export class GroupInbox {
  file: string;
  entries: GroupMessage[];
  constructor(root: string) {
    this.file = path.join(root, 'group-inbox.json');
    try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.entries = Array.isArray(data) ? data : []; }
    catch { this.entries = []; }
    this.prune();
  }
  private prune(persist = true) {
    const originalCount = this.entries.length;
    const counts = new Map<string, number>();
    this.entries = this.entries.filter(item => item && typeof item.id === 'string' && typeof item.chat === 'string'
      && typeof item.timestamp === 'number' && item.timestamp >= Date.now() - RETENTION_MS)
      .sort((a, b) => a.timestamp - b.timestamp).reverse().filter(item => {
        const count = counts.get(item.chat) || 0; counts.set(item.chat, count + 1); return count < MAX_PER_CHAT;
      }).slice(0, MAX_TOTAL).reverse();
    if (persist && this.entries.length !== originalCount && fs.existsSync(this.file)) saveJson(this.file, this.entries);
  }
  cleanup() { this.prune(); }
  observe(event: FeishuMessageEvent, listenChats: string[] = []) {
    const message = event.message, sender = event.sender;
    if (!message?.message_id || !message.chat_id || message.chat_type !== 'group'
      || sender?.sender_type !== 'user' || !sender.sender_id?.open_id || !listenChats.includes(message.chat_id)) return;
    this.prune();
    if (this.entries.some(item => item.id === message.message_id)) return;
    const text = messageText(message.message_type || 'unknown', message.content || '');
    if (text === undefined) return;
    const characters = Array.from(text);
    const eventTime = Number(message.create_time);
    const timestamp = Number.isFinite(eventTime) && eventTime > 0 ? Math.min(eventTime, Date.now()) : Date.now();
    this.entries.push({ id: message.message_id, chat: message.chat_id, sender: sender.sender_id.open_id,
      type: message.message_type || 'unknown', text: characters.slice(0, 4000).join(''),
      thread: message.thread_id || message.root_id || '', timestamp, truncated: characters.length > 4000 });
    this.prune(false); saveJson(this.file, this.entries);
  }
  recent(chat: string, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit 必须为 1-100');
    this.prune(); return this.entries.filter(item => item.chat === chat).slice(-limit);
  }
}
