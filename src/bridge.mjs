import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connectAgent } from './acp-client.mjs';
import { run, resolveProjectPath } from './core.mjs';

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

export class ApprovalBroker {
  pending = new Map();
  constructor({ timeoutMs = 300_000 } = {}) { this.timeoutMs = timeoutMs; }
  async request({ owner, chat, options, title, send }) {
    const allowed = options.filter(o => ['allow_once', 'reject_once'].includes(o.kind));
    if (!allowed.some(o => o.kind === 'allow_once')) return { outcome: { outcome: 'cancelled' } };
    const token = crypto.randomBytes(12).toString('hex');
    let entry;
    const answer = new Promise(resolve => {
      const timer = setTimeout(() => this.finish(token), this.timeoutMs);
      entry = { owner, chat, allowed, resolve, timer };
      this.pending.set(token, entry);
    });
    try { await send(`权限确认：${String(title || '工具调用').slice(0, 1500)}\n仅本次允许：/approve ${token}\n拒绝：/deny ${token}\n${this.timeoutMs / 1000} 秒后自动拒绝。`); }
    catch { this.finish(token); }
    return answer;
  }
  finish(token, optionId) {
    const entry = this.pending.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(token);
    entry.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
  }
  answer(text, owner, chat) {
    const match = /^\/(approve|deny) ([a-f0-9]{24})$/.exec(text);
    if (!match) return false;
    const entry = this.pending.get(match[2]);
    if (!entry || entry.owner !== owner || entry.chat !== chat) return true;
    const option = entry.allowed.find(o => o.kind === (match[1] === 'approve' ? 'allow_once' : 'reject_once'));
    this.finish(match[2], option?.optionId);
    return true;
  }
  cancel(owner, chat) {
    for (const [token, entry] of this.pending) if (entry.owner === owner && entry.chat === chat) this.finish(token);
  }
}

export function acceptedMessage(data, config, botId) {
  const { message: m, sender } = data;
  const owner = sender?.sender_id?.open_id;
  if (!m?.message_id || sender?.sender_type !== 'user' || !config.feishu.allowedUsers?.includes(owner)) return null;
  if (m.message_type !== 'text') return null;
  if (m.chat_type !== 'p2p' && !(botId && m.mentions?.some(v => v.id?.open_id === botId))) return null;
  let text;
  try { text = JSON.parse(m.content).text; } catch { return null; }
  if (typeof text !== 'string' || text.length > 30_000) return null;
  for (const mention of m.mentions || []) text = text.replaceAll(mention.key, '');
  text = text.trim();
  if (!text) return null;
  return { owner, chat: m.chat_id, id: m.message_id, text, thread: m.thread_id || m.root_id || '' };
}

export class Bridge {
  constructor({ root, config, send, botId, agentFactory = connectAgent }) {
    Object.assign(this, { root, config, send, botId, agentFactory });
    this.broker = new ApprovalBroker();
    this.active = new Map();
    this.queues = new Map();
    this.stateFile = path.join(root, 'sessions.json');
    this.state = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : { sessions: {}, seen: {} };
  }
  persist() { saveJson(this.stateFile, this.state); }
  handle(data) {
    const m = acceptedMessage(data, this.config, this.botId);
    if (!m || this.state.seen[m.id]) return;
    this.state.seen[m.id] = Date.now();
    const cutoff = Date.now() - 168 * 3600_000;
    this.state.seen = Object.fromEntries(Object.entries(this.state.seen).filter(([, date]) => date > cutoff).slice(-10000));
    this.persist(); // Persist before queuing: never automatically replay side effects.
    const reply = text => this.send(m.id, text);
    if (this.broker.answer(m.text, m.owner, m.chat)) return;
    const key = crypto.createHash('sha256').update(JSON.stringify([m.owner, m.chat, m.thread])).digest('hex');
    if (m.text === '/cancel') {
      this.broker.cancel(m.owner, m.chat);
      void this.active.get(key)?.cancel().catch(() => {});
      void reply('已请求取消。').catch(() => {});
      return;
    }
    const queue = this.queues.get(key) || { chain: Promise.resolve(), size: 0 };
    if (queue.size >= 3 || (!this.queues.has(key) && this.queues.size >= 4)) {
      void reply('任务队列已满，请稍后重试。').catch(() => {}); return;
    }
    queue.size++;
    queue.chain = queue.chain.then(async () => {
      if (m.text === '/new') {
        delete this.state.sessions[key]; this.persist();
        await reply('新会话已建立，下条消息将创建独立 worktree。'); return;
      }
      await this.prompt(key, m, reply);
    }).catch(async () => { await reply('任务失败。请检查本机登录、连接及配置；可用 /new 开始新会话。').catch(() => {}); })
      .finally(() => { if (--queue.size === 0) this.queues.delete(key); });
    this.queues.set(key, queue);
  }
  async prompt(key, m, reply) {
    let saved = this.state.sessions[key];
    if (!saved) {
      const project = resolveProjectPath(this.config.project.path);
      const cwd = path.join(this.root, 'worktrees', crypto.randomUUID());
      fs.mkdirSync(path.dirname(cwd), { recursive: true, mode: 0o700 });
      run('git', ['-C', project, 'worktree', 'add', '--detach', cwd, 'HEAD']);
      saved = this.state.sessions[key] = { cwd }; this.persist();
    }
    let agent;
    let text = '';
    let timer;
    try {
      agent = await this.agentFactory({ ...saved, model: process.env.CODEX_CONFIG ? JSON.parse(process.env.CODEX_CONFIG).model : undefined,
        onText: chunk => { if (text.length < 100_000) text += chunk; },
        requestPermission: p => this.broker.request({ owner: m.owner, chat: m.chat, options: p.options,
          title: p.toolCall?.title, send: reply }),
      });
      saved.sessionId = agent.sessionId; this.persist();
      this.active.set(key, agent);
      await Promise.race([agent.prompt(m.text), new Promise((_, reject) => {
        timer = setTimeout(() => { agent.close(); reject(new Error('Turn timed out')); }, 30 * 60_000);
      })]);
      for (let offset = 0; offset < text.length; offset += 3000) await reply(text.slice(offset, offset + 3000));
      if (!text.trim()) await reply('任务结束，没有文本输出。');
    } finally {
      clearTimeout(timer);
      this.broker.cancel(m.owner, m.chat);
      this.active.delete(key);
      agent?.close();
    }
  }
  close() { for (const agent of this.active.values()) agent.close(); for (const token of this.broker.pending.keys()) this.broker.finish(token); }
}

export async function startBridge(root, config) {
  if (!config.feishu?.allowedUsers?.length) throw new Error('必须配置 feishu.allowedUsers（飞书 open_id 白名单）');
  resolveProjectPath(config.project?.path);
  const lark = await import('@larksuiteoapi/node-sdk');
  const options = { appId: config.feishu.appId, appSecret: config.feishu.appSecret,
    domain: config.feishu.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } };
  const client = new lark.Client(options);
  const identity = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
  const botId = identity.bot?.open_id;
  if (!botId) throw new Error('无法获取飞书 Bot 身份');
  const bridge = new Bridge({ root, config, botId, send: async (id, text) => {
    const result = await client.im.v1.message.reply({ path: { message_id: id }, data: {
      msg_type: 'text', content: JSON.stringify({ text }),
    } });
    if (result.code) throw new Error('飞书回复失败');
  } });
  const ws = new lark.WSClient(options);
  await ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': data => { bridge.handle(data); },
  }) });
  const close = () => { bridge.close(); ws.close({ force: true }); };
  try {
    const deadline = Date.now() + 30_000;
    while (ws.getConnectionStatus().state !== 'connected') {
      if (Date.now() > deadline || ws.getConnectionStatus().state === 'failed') throw new Error('飞书长连接失败');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) { close(); throw error; }
  return close;
}
