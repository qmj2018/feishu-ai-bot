import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

export type Environment = NodeJS.ProcessEnv;
export type Provider = 'codex' | 'claude';
export type CodexMode = 'read-only' | 'agent' | 'agent-full-access';
export type ServiceEnvironment = Record<string, string>;
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
}
export interface RunOptions {
  cwd?: string;
  env?: Environment;
  input?: string;
  inherit?: boolean;
  allowFailure?: boolean;
}
export type CommandRunner = (command: string, args?: string[], options?: RunOptions) => CommandResult;
export type InstallRunner = (command: string, args: string[], options: Pick<SpawnSyncOptionsWithStringEncoding, 'env' | 'timeout'>) => CommandResult;
export interface BotMetadata {
  slug: string;
  runtimeId: string;
  displayName?: string;
  workspaceMode?: string;
  archived?: boolean;
}
export interface RuntimeConfig {
  feishu?: { appId?: string; appSecret?: string; domain?: string; allowedUsers?: string[]; enabled?: boolean };
  project?: { path?: string; name?: string; workspaceMode?: 'per-session-worktree' | 'project-directory' };
  group?: { replyPolicy?: string; defaultMode?: string; listenChats?: string[] };
  weixin?: { enabled?: boolean };
  agents?: { defaultAgent?: string; enableAutoStart?: boolean; acpInitializeTimeoutMs?: number; codexMode?: CodexMode };
  sessions?: { maxQueueSize?: number; autoCleanup?: boolean; cleanupIntervalMinutes?: number };
  permissions?: { strategy?: string; allowedTools?: string[]; deniedTools?: string[]; timeoutSeconds?: number };
  deduplication?: { enabled?: boolean; maxRecords?: number; expireHours?: number };
  shell?: { enabled?: boolean };
  logging?: { level?: string };
  power?: { keepAwake?: boolean };
}
export interface RuntimeStatus {
  status: string;
  pid?: number;
  nobind?: boolean;
  state?: { nobind?: boolean };
  error?: string;
}
export interface RuntimePaths {
  dataRoot: string;
  root: string;
  config: string;
  metadata: string;
  log: string;
}
export interface PreflightCheck { name: string; ok: boolean; message: string }
export interface Model {
  id: string;
  name?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  effort?: string;
}
export interface PermissionOption { kind: string; optionId: string; name?: string }
export interface PermissionRequest { options: PermissionOption[]; toolCall: { title?: string | null } }
export type PermissionResult = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };
export interface AgentOptions {
  codexMode?: CodexMode;
  cwd?: string;
  provider?: Provider;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  onText?: (text: string) => void;
  requestPermission?: (request: PermissionRequest) => Promise<PermissionResult> | PermissionResult;
  command?: string;
  args?: string[];
  timeoutMs?: number;
  discovery?: boolean;
}
export interface AgentSession {
  sessionId: string;
  close: () => void;
  prompt: (text: string) => Promise<{ stopReason: string }>;
  cancel: () => Promise<unknown>;
  setModel: (model: string) => Promise<unknown>;
  setReasoningEffort?: (effort: string) => Promise<unknown>;
  models?: Model[];
}
export interface ChatMessage {
  owner: string;
  chat: string;
  id: string;
  text: string;
  thread: string;
  onText?: (text: string) => void;
}
export interface Session {
  cwd: string;
  scopeKey?: string;
  codexMode?: CodexMode;
  provider?: Provider;
  sessionId?: string;
  models?: Partial<Record<Provider, string>>;
  reasoningEfforts?: Partial<Record<Provider, string>>;
  engineSessions?: Partial<Record<Provider, string>>;
}
export type ActiveSession = Session & Required<Pick<Session, 'provider' | 'models' | 'reasoningEfforts' | 'engineSessions'>>;
export interface BridgeState { sessions: Record<string, Session>; seen: Record<string, number>; routes?: Record<string, string> }
export interface FeishuMessageEvent {
  sender?: { sender_type?: string; sender_id?: { open_id?: string } };
  message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string;
    thread_id?: string; root_id?: string; create_time?: string; mentions?: { key: string; id?: { open_id?: string } }[] };
}
export interface CardCallback {
  operator?: { open_id?: string };
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: { value?: { action?: string; token?: string }; option?: string };
}
export interface Card {
  config: { wide_screen_mode: boolean };
  header: { title: { tag: string; content: string }; template: string };
  elements: { tag: string; text?: { tag: string; content: string }; actions?: {
    tag: string; placeholder: { tag: string; content: string };
    options: { text: { tag: string; content: string }; value: string }[];
    value: { action: string; token: string };
  }[] }[];
}
