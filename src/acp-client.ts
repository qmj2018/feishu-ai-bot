import type { AgentOptions, AgentSession, Environment } from "./types.js";
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { localCodexPath } from './local-codex.js';

// No file or terminal capabilities: Codex uses its own sandboxed tools.
export async function connectAgent({ cwd, sessionId, model, reasoningEffort, onText = () => {}, requestPermission = async () => ({ outcome: { outcome: 'cancelled' } }),
  command = 'codex-acp', args = [], timeoutMs = 120_000 }: AgentOptions & { cwd: string }): Promise<AgentSession> {
  const env: Environment = { ...process.env, INITIAL_AGENT_MODE: 'read-only' };
  env.CODEX_PATH = localCodexPath(env);
  if (model) env.CODEX_CONFIG = JSON.stringify({ ...JSON.parse(env.CODEX_CONFIG || '{}'), model });
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let connection: ClientSideConnection;
  let prompting = false;
  const ready = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.stderr.resume(); // Never forward provider stderr (may contain credentials).
  const close = () => {
    const signal = (value: NodeJS.Signals) => {
      try { if (child.pid) { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); } }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
  connection = new ClientSideConnection(() => ({
    requestPermission: async request => requestPermission(request),
    sessionUpdate: ({ update }) => {
      if (prompting && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') onText(update.content.text);
    },
  }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const deadline = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { close(); reject(new Error('ACP initialization timed out')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    await deadline(ready);
    const init = await deadline(connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }));
    if (sessionId && !init.agentCapabilities?.loadSession) throw new Error('Agent does not support restoring sessions; use /new');
    const session = sessionId
      ? await deadline(connection.loadSession({ sessionId, cwd, mcpServers: [] }))
      : await deadline(connection.newSession({ cwd, mcpServers: [] }));
    sessionId ||= 'sessionId' in session ? String(session.sessionId) : undefined;
    const id = sessionId;
    if (!id) throw new Error('ACP agent did not return a session ID');
    // Explicitly override user/global defaults, including full-access settings.
    await deadline(connection.setSessionMode({ sessionId: id, modeId: 'read-only' }));
    let configOptions = session.configOptions || [];
    const setModel = async (value: string) => {
      const option = configOptions.find(o => o.category === 'model' || o.id === 'model');
      if (!option) throw new Error('ACP agent does not advertise a model option');
      const result = await deadline(connection.setSessionConfigOption({ sessionId: id, configId: option.id, value }));
      configOptions = result.configOptions || configOptions;
    };
    const setReasoningEffort = async (value: string) => {
      const option = configOptions.find(o => o.id === 'reasoning_effort' || o.category === 'thought_level');
      if (!option) throw new Error('ACP agent does not advertise reasoning effort');
      const result = await deadline(connection.setSessionConfigOption({ sessionId: id, configId: option.id, value }));
      configOptions = result.configOptions || configOptions;
    };
    // Apply through ACP after loadSession too: environment defaults alone do not
    // reliably override the persisted model of a resumed thread.
    if (model) await setModel(model);
    if (reasoningEffort) await setReasoningEffort(reasoningEffort);
    return {
      sessionId: id, close, setModel, setReasoningEffort,
      prompt: async (text: string) => {
        prompting = true;
        try { return await connection.prompt({ sessionId: id, prompt: [{ type: 'text', text }] }); }
        finally { prompting = false; }
      },
      cancel: () => connection.cancel({ sessionId: id }),
    };
  } catch (error) { close(); throw error; }
}
