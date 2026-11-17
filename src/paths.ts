import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate feishu-ai-bot package root');
    directory = parent;
  }
  return directory;
}

export const PROJECT_ROOT = packageRoot();
export const BUILD_ROOT = path.join(PROJECT_ROOT, 'dist');
