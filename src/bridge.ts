import type { RuntimeConfig, BridgeState, ActiveSession, Provider, Model, Card, CardCallback, FeishuMessageEvent, ChatMessage, AgentOptions, AgentSession, PermissionOption, PermissionResult } from './types.js';
interface PendingApproval { owner: string; chat: string; allowed: PermissionOption[]; resolve: (result: PermissionResult) => void; timer: NodeJS.Timeout }
interface ApprovalRequest { owner: string; chat: string; options: PermissionOption[]; title?: string | null; send: (text: string) => Promise<unknown> }
interface BridgeOptions {
  root: string; config: RuntimeConfig; botId?: string;
  send: (id: string, text: string) => Promise<unknown>;
  sendMarkdown?: (id: string, text: string) => Promise<unknown>;
  sendCard?: (id: string, card: Card) => Promise<string>;
  workingReaction?: WorkingReaction;
  usageReader?: typeof readUsage;
  loadConfig?: () => RuntimeConfig;
  agentFactory?: (options: AgentOptions & { cwd: string }) => Promise<AgentSession>;
  modelDiscovery?: (provider: Provider) => Promise<Model[]>;
}
interface Queue { chain: Promise<unknown>; size: number }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connectAgent } from './acp-client.js';
import { connectClaude } from './claude-client.js';
import { ModelCards, discoverModels, effortLabel } from './model-cards.js';
import { createWorkingReaction, type WorkingReaction } from './working-reaction.js';
import { readUsage, formatUsage } from './usage.js';
import { createMarkdownReply } from './markdown-reply.js';
import { GroupInbox } from './group-inbox.js';

const connectRuntime = (options: AgentOptions & { cwd: string }) => options.provider === 'claude' ? connectClaude(options) : connectAgent(options);
import { run, resolveProjectPath, assertCredentials } from './core.js';

import { saveJson } from './storage.js';
export { saveJson } from './storage.js';

export class ApprovalBroker {
  pending = new Map<string, PendingApproval>();
  timeoutMs: number;
  constructor({ timeoutMs = 300_000 } = {}) { this.timeoutMs = timeoutMs; }
  async request({ owner, chat, options, title, send }: ApprovalRequest): Promise<PermissionResult> {
    const allowed = options.filter(o => ['allow_once', 'reject_once'].includes(o.kind));
    if (!allowed.some(o => o.kind === 'allow_once')) return { outcome: { outcome: 'cancelled' } };
    const token = crypto.randomBytes(12).toString('hex');
    let entry: PendingApproval;
    const answer = new Promise<PermissionResult>(resolve => {
      const timer = setTimeout(() => this.finish(token), this.timeoutMs);
      entry = { owner, chat, allowed, resolve, timer };
      this.pending.set(token, entry);
    });
    try { await send(`权限确认：${String(title || '工具调用').slice(0, 1500)}\n仅本次允许：/approve ${token}\n拒绝：/deny ${token}\n${this.timeoutMs / 1000} 秒后自动拒绝。`); }
    catch { this.finish(token); }
    return answer;
  }
  finish(token: string, optionId?: string) {
    const entry = this.pending.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(token);
    entry.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
  }
  answer(text: string, owner: string, chat: string) {
    const match = /^\/(approve|deny) ([a-f0-9]{24})$/.exec(text);
    if (!match) return false;
    const entry = this.pending.get(match[2]);
    if (!entry || entry.owner !== owner || entry.chat !== chat) return true;
    const option = entry.allowed.find(o => o.kind === (match[1] === 'approve' ? 'allow_once' : 'reject_once'));
    this.finish(match[2], option?.optionId);
    return true;
  }
  cancel(owner: string, chat: string) {
    for (const [token, entry] of this.pending) if (entry.owner === owner && entry.chat === chat) this.finish(token);
  }
}

export function acceptedMessage(data: FeishuMessageEvent, config: RuntimeConfig, botId?: string): ChatMessage | null {
  const { message: m, sender } = data;
  const owner = sender?.sender_id?.open_id;
  if (!owner || !m?.message_id || !m.chat_id || sender?.sender_type !== 'user' || !config.feishu?.allowedUsers?.includes(owner)) return null;
  if (m.message_type !== 'text') return null;
  if (m.chat_type !== 'p2p' && !(botId && m.mentions?.some(v => v.id?.open_id === botId))) return null;
  let text;
  try { text = JSON.parse(m.content || '').text; } catch { return null; }
  if (typeof text !== 'string' || text.length > 30_000) return null;
  for (const mention of m.mentions || []) text = text.replaceAll(mention.key, '');
  text = text.trim();
  if (!text) return null;
  return { owner, chat: m.chat_id, id: m.message_id, text, thread: m.thread_id || m.root_id || '' };
}

export class Bridge {
  root: string;
  config: RuntimeConfig;
  send: BridgeOptions['send'];
  sendMarkdown?: BridgeOptions['sendMarkdown'];
  sendCard?: BridgeOptions['sendCard'];
  workingReaction?: WorkingReaction;
  usageReader: typeof readUsage;
  loadConfig?: () => RuntimeConfig;
  inbox: GroupInbox;
  usagePending = new Set<string>();
  botId?: string;
  agentFactory: NonNullable<BridgeOptions['agentFactory']>;
  modelDiscovery: NonNullable<BridgeOptions['modelDiscovery']>;
  modelCards: ModelCards;
  broker: ApprovalBroker;
  active: Map<string, AgentSession>;
  queues: Map<string, Queue>;
  stateFile: string;
  state: BridgeState;
  constructor({ root, config, send, sendMarkdown, sendCard, workingReaction, usageReader = readUsage, loadConfig, botId, agentFactory = connectRuntime, modelDiscovery = discoverModels }: BridgeOptions) {
    this.root = root; this.config = config; this.send = send; this.sendCard = sendCard;
    this.sendMarkdown = sendMarkdown;
    this.workingReaction = workingReaction;
    this.usageReader = usageReader;
    this.loadConfig = loadConfig;
    this.inbox = new GroupInbox(root);
    this.botId = botId; this.agentFactory = agentFactory; this.modelDiscovery = modelDiscovery;
    this.modelCards = new ModelCards();
    this.broker = new ApprovalBroker();
    this.active = new Map();
    this.queues = new Map();
    this.stateFile = path.join(root, 'sessions.json');
    this.state = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : { sessions: {}, seen: {} };
  }
  persist() { saveJson(this.stateFile, this.state); }
  refreshAccess() {
    if (!this.loadConfig) return true;
    try {
      const latest = this.loadConfig();
      if (!Array.isArray(latest.feishu?.allowedUsers) || latest.feishu.allowedUsers.some(id => typeof id !== 'string')) return false;
      if (latest.group?.listenChats !== undefined && (!Array.isArray(latest.group.listenChats) || latest.group.listenChats.some(id => typeof id !== 'string'))) return false;
      this.config = { ...this.config, feishu: { ...this.config.feishu, allowedUsers: latest.feishu.allowedUsers },
        group: { ...this.config.group, listenChats: latest.group?.listenChats || [] } };
      return true;
    } catch { console.error('用户与群监听配置读取失败，暂不接收新的消息或操作。'); return false; }
  }
  handle(data: FeishuMessageEvent) {
    if (!this.refreshAccess()) return;
    try { this.inbox.observe(data, this.config.group?.listenChats); }
    catch { console.error('群消息缓存写入失败，请检查本地目录权限。'); }
    const m = acceptedMessage(data, this.config, this.botId);
    if (!m || this.state.seen[m.id]) return;
    this.state.seen[m.id] = Date.now();
    const cutoff = Date.now() - 168 * 3600_000;
    this.state.seen = Object.fromEntries(Object.entries(this.state.seen).filter(([, date]) => date > cutoff).slice(-10000));
    this.persist(); // Persist before queuing: never automatically replay side effects.
    const reply = (text: string) => this.send(m.id, text);
    if (this.broker.answer(m.text, m.owner, m.chat)) return;
    const key = crypto.createHash('sha256').update(JSON.stringify([m.owner, m.chat, m.thread])).digest('hex');
    if (m.text === '/usage') {
      void this.showUsage(key, reply).catch(() => {});
      return;
    }
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
      if (!this.refreshAccess() || !this.config.feishu?.allowedUsers?.includes(m.owner)) return;
      if (m.text === '/new') {
        delete this.state.sessions[key]; this.persist();
        await reply('新会话已建立，下条消息将创建独立 worktree。'); return;
      }
      if (/^\/models?(?: (codex|claude))?$/.test(m.text)) {
        await this.showModels(key, m, reply); return;
      }
      await this.prompt(key, m, reply);
    }).catch(async () => { await reply('任务失败。请检查本机登录、连接及配置；可用 /new 开始新会话。').catch(() => {}); })
      .finally(() => { if (--queue.size === 0) this.queues.delete(key); });
    this.queues.set(key, queue);
  }
  async showUsage(key: string, reply: (text: string) => Promise<unknown>) {
    if (this.usagePending.has(key)) { await reply('用量正在查询，请稍候。'); return; }
    const saved = this.state.sessions[key];
    if (saved?.provider === 'claude') {
      await reply('当前会话使用 Claude，暂不提供其周额度和上下文占比。切换到 Codex 后可用 /usage 查询。');
      return;
    }
    const sessionId = saved?.engineSessions?.codex || saved?.sessionId;
    this.usagePending.add(key);
    try {
      const report = await this.usageReader({ sessionId });
      await reply(formatUsage(report, { hasSession: !!sessionId, running: this.queues.has(key) }));
    } catch { await reply('用量查询失败，请检查本机 Codex 登录和网络；当前任务不受影响。').catch(() => {}); }
    finally { this.usagePending.delete(key); }
  }
  ensureSession(key: string): ActiveSession {
    let saved = this.state.sessions[key];
    if (!saved) {
      const projectPath = this.config.project?.path;
      if (!projectPath) throw new Error('会话缺少项目目录配置');
      const project = resolveProjectPath(projectPath);
      const cwd = path.join(this.root, 'worktrees', crypto.randomUUID());
      fs.mkdirSync(path.dirname(cwd), { recursive: true, mode: 0o700 });
      run('git', ['-C', project, 'worktree', 'add', '--detach', cwd, 'HEAD']);
      saved = this.state.sessions[key] = { cwd }; this.persist();
    }
    saved.provider ||= 'codex';
    saved.models ||= {};
    saved.reasoningEfforts ||= {};
    saved.engineSessions ||= {};
    if (saved.sessionId && !saved.engineSessions.codex) saved.engineSessions.codex = saved.sessionId;
    delete saved.sessionId;
    return saved as ActiveSession;
  }
  async openSession(saved: ActiveSession, m: ChatMessage, reply: (text: string) => Promise<unknown>, provider: Provider = saved.provider, override?: string | null) {
    const model = override !== undefined ? override : saved.models[provider] || (provider === 'codex' && process.env.CODEX_CONFIG ? JSON.parse(process.env.CODEX_CONFIG).model : undefined);
    return this.agentFactory({ cwd: saved.cwd, provider, model: model ?? undefined, sessionId: saved.engineSessions[provider],
      reasoningEffort: provider === 'codex' && override === undefined ? saved.reasoningEfforts?.codex : undefined,
      onText: m.onText || (() => {}),
      requestPermission: p => this.refreshAccess() && this.config.feishu?.allowedUsers?.includes(m.owner)
        ? this.broker.request({ owner: m.owner, chat: m.chat, options: p.options, title: p.toolCall?.title, send: reply })
        : Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
    });
  }
  async showModels(key: string, m: ChatMessage, reply: (text: string) => Promise<unknown>) {
    if (!this.sendCard) throw new Error('Card transport unavailable');
    const providers = (m.text.split(' ')[1] ? [m.text.split(' ')[1]] : ['codex', 'claude']) as Provider[];
    const results = await Promise.allSettled(providers.map(provider => this.modelDiscovery(provider)));
    for (const [index, result] of results.entries()) {
      const provider = providers[index];
      if (result.status === 'rejected' || !Array.isArray(result.value) || !result.value.length) {
        await reply(`${provider} 模型读取失败，请检查该 CLI 是否已安装、登录及网络配置。`); continue;
      }
      const models = [...new Map<string, Model>(result.value.filter(v => v && typeof v.id === 'string' && v.id && v.id.length <= 256).map(v => [v.id, v])).values()];
      if (!models.length || models.length > 1000) { await reply(`${provider} 模型列表格式无效。`); continue; }
      const saved = this.state.sessions[key];
      const { card, entry, token } = this.modelCards.create({ owner: m.owner, chat: m.chat, key, provider, models,
        current: saved?.models?.[provider] ? `${saved.models[provider]}${provider === 'codex' && saved.reasoningEfforts?.codex ? ` / ${effortLabel(saved.reasoningEfforts.codex)}` : ''}` : undefined });
      try { entry.messageId = await this.sendCard(m.id, card); entry.message = m; }
      catch (error) { this.modelCards.entries.delete(token); throw error; }
    }
  }
  handleCard(data: CardCallback) {
    if (!this.refreshAccess()) return { toast: { type: 'error', content: '配置暂不可用，请稍后重试。' } };
    const entry = this.modelCards.consume(data, this.config.feishu?.allowedUsers);
    if (!entry || !entry.message) return { toast: { type: 'error', content: '无权操作或卡片已失效，请重新发送 /models。' } };
    const { key, provider, model, message: m } = entry;
    const queue = this.queues.get(key) || { chain: Promise.resolve(), size: 0 };
    if (queue.size >= 3 || (!this.queues.has(key) && this.queues.size >= 4)) return { toast: { type: 'error', content: '任务队列已满，请稍后重新发送 /models。' } };
    const reply = (text: string) => this.send(m.id, text);
    queue.size++;
    queue.chain = queue.chain.then(async () => {
      if (!this.refreshAccess() || !this.config.feishu?.allowedUsers?.includes(m.owner)) return;
      const saved = this.ensureSession(key);
      let agent: AgentSession | undefined;
      try {
        agent = await this.openSession(saved, m, reply, provider, null);
        await agent.setModel(model.id);
        if (provider === 'codex' && model.effort) await agent.setReasoningEffort!(model.effort);
        const next = structuredClone(saved);
        // Model discovery/selection does not send a prompt. Some CLIs only
        // create a resumable conversation after the first actual turn.
        if (saved.engineSessions[provider]) next.engineSessions[provider] = agent.sessionId;
        next.provider = provider; next.models[provider] = model.id;
        if (provider === 'codex') {
          if (model.effort) next.reasoningEfforts.codex = model.effort;
          else delete next.reasoningEfforts.codex;
        }
        this.state.sessions[key] = next;
        try { this.persist(); } catch (error) { this.state.sessions[key] = saved; throw error; }
        await reply(`已切换到 ${provider} / ${model.name || model.id}，下一条消息使用此模型。`).catch(() => {});
      } finally { agent?.close(); }
    }).catch(() => reply('模型切换失败，原来的模型设置已保留。请检查 CLI 登录和模型权限后重新发送 /models。').catch(() => {}))
      .finally(() => { if (--queue.size === 0) this.queues.delete(key); });
    this.queues.set(key, queue);
    return { toast: { type: 'info', content: '已接收，将按会话顺序切换模型；完成后发送确认。' } };
  }
  async prompt(key: string, m: ChatMessage, reply: (text: string) => Promise<unknown>) {
    let reactionId: string | undefined;
    let agent: AgentSession | undefined;
    let text = '';
    let timer: NodeJS.Timeout | undefined;
    try {
      try { reactionId = await this.workingReaction?.add(m.id); }
      catch { console.error('无法添加执行状态表情，请检查 im:message.reactions:write_only 权限及网络。'); }
      const saved = this.ensureSession(key);
      agent = await this.openSession(saved, { ...m, onText: chunk => { if (text.length < 100_000) text += chunk; } }, reply);
      saved.engineSessions[saved.provider] = agent.sessionId; this.persist();
      this.active.set(key, agent);
      await Promise.race([agent.prompt(m.text), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { agent?.close(); reject(new Error('Turn timed out')); }, 30 * 60_000);
      })]);
      if (text.trim() && this.sendMarkdown) await this.sendMarkdown(m.id, text);
      else for (let offset = 0; offset < text.length; offset += 3000) await reply(text.slice(offset, offset + 3000));
      if (!text.trim()) await reply('任务结束，没有文本输出。');
    } finally {
      clearTimeout(timer);
      this.broker.cancel(m.owner, m.chat);
      this.active.delete(key);
      try { agent?.close(); }
      finally {
        if (reactionId) {
          try { await this.workingReaction?.remove(m.id, reactionId); }
          catch { console.error('无法移除执行状态表情，请检查 im:message.reactions:write_only 权限及网络。'); }
        }
      }
    }
  }
  close() { for (const agent of this.active.values()) agent.close(); for (const token of this.broker.pending.keys()) this.broker.finish(token); }
}

export async function startBridge(root: string, config: RuntimeConfig) {
  assertCredentials(config);
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
  const bridge = new Bridge({ root, config, botId, loadConfig: () => JSON.parse(fs.readFileSync(path.join(root, 'feishu-runtime.json'), 'utf8')),
    workingReaction: createWorkingReaction(client.im.v1.messageReaction),
    sendMarkdown: createMarkdownReply(client.im.v1.message), send: async (id, text) => {
    const result = await client.im.v1.message.reply({ path: { message_id: id }, data: {
      msg_type: 'text', content: JSON.stringify({ text }),
    } });
    if (result.code) throw new Error('飞书回复失败');
  } });
  bridge.sendCard = async (id, card) => {
    const result = await client.im.v1.message.reply({ path: { message_id: id }, data: {
      msg_type: 'interactive', content: JSON.stringify(card),
    } });
    if (result.code || !result.data?.message_id) throw new Error('飞书卡片发送失败');
    return result.data.message_id;
  };
  const ws = new lark.WSClient(options);
  await ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': data => { bridge.handle(data as FeishuMessageEvent); },
    'card.action.trigger': (data: CardCallback) => bridge.handleCard(data as CardCallback),
  }) });
  const cleanupTimer = setInterval(() => {
    try { bridge.inbox.cleanup(); } catch { console.error('群消息缓存清理失败，请检查本地目录权限。'); }
  }, 3600_000);
  cleanupTimer.unref();
  const close = () => { clearInterval(cleanupTimer); bridge.close(); ws.close({ force: true }); };
  try {
    const deadline = Date.now() + 30_000;
    while (ws.getConnectionStatus().state !== 'connected') {
      if (Date.now() > deadline || ws.getConnectionStatus().state === 'failed') throw new Error('飞书长连接失败');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) { close(); throw error; }
  return close;
}
