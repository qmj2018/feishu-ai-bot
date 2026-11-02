import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// No file or terminal capabilities: Codex uses its own sandboxed tools.
export async function connectAgent({ cwd, sessionId, model, onText, requestPermission,
  command = 'codex-acp', args = [], timeoutMs = 120_000 }) {
  const env = { ...process.env, INITIAL_AGENT_MODE: 'read-only' };
  if (model) env.CODEX_CONFIG = JSON.stringify({ ...JSON.parse(env.CODEX_CONFIG || '{}'), model });
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let connection;
  let prompting = false;
  const ready = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.stderr.resume(); // Never forward provider stderr (may contain credentials).
  const close = () => {
    const signal = value => {
      try { if (child.pid) { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); } }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
  connection = new ClientSideConnection(() => ({
    requestPermission,
    sessionUpdate: ({ update }) => {
      if (prompting && update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') onText(update.content.text);
    },
  }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const deadline = async operation => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
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
    sessionId ||= session.sessionId;
    // Explicitly override user/global defaults, including full-access settings.
    await deadline(connection.setSessionMode({ sessionId, modeId: 'read-only' }));
    return {
      sessionId, close,
      prompt: async text => {
        prompting = true;
        try { return await connection.prompt({ sessionId, prompt: [{ type: 'text', text }] }); }
        finally { prompting = false; }
      },
      cancel: () => connection.cancel({ sessionId }),
    };
  } catch (error) { close(); throw error; }
}
