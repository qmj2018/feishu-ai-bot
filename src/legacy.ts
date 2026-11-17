// Read-only identifiers for installations created before the project rename.
// New commands, services and configuration always use APP_ID.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ID } from './identity.js';
import type { Environment } from './types.js';

export const LEGACY_APP_ID = 'devbox-codex-bot';
export const LEGACY_DEFAULT_SLUG = 'codex-devbox';

export function legacyServiceUnit(slug: string) {
  return `${LEGACY_APP_ID}-${slug}.service`;
}

export function managedSkill(content: string) {
  return content.split(/\r?\n/).some(line => {
    const marker = /^\s*managed-by:\s*(\S+)\s*$/.exec(line);
    return marker && [APP_ID, LEGACY_APP_ID].includes(marker[1]);
  });
}

// Keep an existing default bot addressable instead of silently creating a
// second bot with the new default name. Explicit --slug always takes priority.
export function defaultBotSlug(env: Environment = process.env) {
  const bots = path.join(env.HOME || os.homedir(), '.feishu-runtime', 'bots');
  if (!fs.existsSync(bots)) return APP_ID;
  const names: string[] = [];
  for (const entry of fs.readdirSync(bots, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(bots, entry.name, 'runtime.json');
    if (!fs.existsSync(file)) continue;
    const bot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!bot.archived) names.push(bot.slug);
  }
  return names.includes(APP_ID) ? APP_ID
    : names.includes(LEGACY_DEFAULT_SLUG) ? LEGACY_DEFAULT_SLUG : APP_ID;
}
