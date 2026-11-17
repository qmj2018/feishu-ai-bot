import type { AgentOptions, AgentSession, Model } from './types.js';
interface ControlResponse { models?: { value: string; displayName?: string }[] }
interface PendingControl { resolve: (value: ControlResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface PendingTurn { resolve: (value: { stopReason: string }) => void; reject: (error: Error) => void }
import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// Speak the installed Claude Code CLI's streaming control protocol directly.
// No Claude SDK npm package is installed or redistributed by this project.
export async function connectClaude({ cwd = os.tmpdir(), sessionId, model, onText = () => {},
  requestPermission = async () => ({ outcome: { outcome: 'cancelled' } }),
  command = 'claude', args = [], timeoutMs = 60_000, discovery = false }: AgentOptions = {}): Promise<AgentSession & { models: Model[] }> {
  const id = sessionId || crypto.randomUUID();
  const cliArgs = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--permission-mode', 'default', '--permission-prompt-tool', 'stdio', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: 'default', allow: [] } }),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(sessionId ? ['--resume', sessionId] : ['--session-id', id]),
    ...(model ? ['--model', model] : []), ...(discovery ? ['--tools', ''] : [])];
  const child = spawn(command, [...args, ...cliArgs], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stderr.resume();
  const pending = new Map<string, PendingControl>();
  let turn: PendingTurn | undefined;
  let closed = false;
  const fail = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Claude CLI control connection closed')); }
    pending.clear();
    turn?.reject(new Error('Claude CLI turn interrupted')); turn = undefined;
  };
  const close = () => {
    if (closed) return;
    closed = true; fail();
    const signal = (value: NodeJS.Signals) => { try { if (child.pid) { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); } } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 2000); timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
  const write = (data: unknown) => { if (!closed) child.stdin.write(JSON.stringify(data) + '\n'); };
  const control = (request: unknown) => new Promise<ControlResponse>((resolve, reject) => {
    if (closed) return reject(new Error('Claude CLI closed'));
    const request_id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(request_id); reject(new Error('Claude CLI control request timed out')); close(); }, timeoutMs);
    pending.set(request_id, { resolve, reject, timer });
    write({ type: 'control_request', request_id, request });
  });
  child.on('error', () => { closed = true; fail(); });
  child.on('close', () => { closed = true; fail(); });
  child.stdin.on('error', close);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'control_response') {
      const entry = pending.get(event.response?.request_id);
      if (!entry) return;
      pending.delete(event.response.request_id); clearTimeout(entry.timer);
      if (event.response.subtype === 'error') entry.reject(new Error('Claude CLI rejected control request'));
      else entry.resolve(event.response.response || {});
    } else if (event.type === 'control_request') {
      void (async () => {
        let response: { behavior: string; message?: string; updatedInput?: unknown } = { behavior: 'deny', message: 'Unsupported control request' };
        const req = event.request;
        if (req?.subtype === 'can_use_tool') {
          const result = await requestPermission({ toolCall: { title: `${req.tool_name}: ${JSON.stringify(req.input).slice(0, 1200)}` }, options: [
            { kind: 'allow_once', optionId: 'allow', name: 'Allow once' }, { kind: 'reject_once', optionId: 'deny', name: 'Deny' },
          ] });
          response = result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow' ? { behavior: 'allow', updatedInput: req.input } : { behavior: 'deny', message: 'Permission denied' };
        }
        write({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response } });
      })().catch(() => write({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: 'Permission unavailable' } }));
    } else if (event.type === 'assistant' && turn) {
      for (const content of event.message?.content || []) if (content.type === 'text') onText(content.text);
    } else if (event.type === 'result' && turn) {
      const current = turn; turn = undefined;
      if (event.is_error) current.reject(new Error('Claude CLI turn failed'));
      else current.resolve({ stopReason: 'end_turn' });
    }
  });
  try {
    const init = await control({ subtype: 'initialize' });
    const models = (Array.isArray(init.models) ? init.models : []).filter(v => v && typeof v.value === 'string').map(v => ({ id: v.value, name: v.displayName || v.value }));
    return {
      sessionId: id, models, close,
      setModel: async (value: string) => { if (turn) throw new Error('Claude turn is running'); await control({ subtype: 'set_model', model: value }); },
      prompt: (text: string) => new Promise<{ stopReason: string }>((resolve, reject) => {
        if (closed || turn) return reject(new Error('Claude is busy or disconnected'));
        turn = { resolve, reject };
        write({ type: 'user', session_id: id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
      }),
      cancel: () => control({ subtype: 'interrupt' }),
    };
  } catch (error) { close(); throw error; }
}

export async function listClaudeModels(options: AgentOptions = {}): Promise<Model[]> {
  const agent = await connectClaude({ ...options, discovery: true });
  try { if (!agent.models.length) throw new Error('Claude CLI returned no models'); return agent.models; }
  finally { agent.close(); }
}
