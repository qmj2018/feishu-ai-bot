import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function saveJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

// Serialize configuration edits across CLI processes and detect stale locks.
export function updateJson<T>(file: string, change: (current: T) => T): T {
  const lock = file + '.edit.lock';
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (aliveError) {
          if (aliveError.code === 'ESRCH') { fs.unlinkSync(lock); continue; }
        }
      }
      throw new Error('配置正在被其他进程修改，请稍后重试');
    }
  }
  if (fd === undefined) throw new Error('无法取得配置编辑锁');
  try {
    fs.writeFileSync(fd, String(process.pid));
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    const next = change(current);
    if (JSON.stringify(next) !== JSON.stringify(current)) saveJson(file, next);
    return next;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
