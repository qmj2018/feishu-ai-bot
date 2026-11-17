import { findBot, readRuntimeConfig, runtimePaths } from './core.js';
import { updateJson } from './storage.js';
import { GroupInbox } from './group-inbox.js';
import type { Environment, RuntimeConfig } from './types.js';

export function accessConfig(slug: string, env: Environment = process.env) {
  const bot = findBot(slug, { env });
  if (!bot) throw new Error(`机器人不存在: ${slug}；请先部署或 setup`);
  return { paths: runtimePaths(bot, env), config: readRuntimeConfig(bot, env) };
}
export function updateAccess(file: string, kind: 'users' | 'groups', action: 'add' | 'remove', ids: string[]) {
  const pattern = kind === 'users' ? /^ou_[a-zA-Z0-9_-]+$/ : /^oc_[a-zA-Z0-9_-]+$/;
  if (!ids.length || ids.some(id => !pattern.test(id))) throw new Error(kind === 'users' ? '用户必须使用 ou_ 开头的 open_id' : '群必须使用 oc_ 开头的 chat_id');
  return updateJson<RuntimeConfig>(file, current => {
    const existing = kind === 'users' ? current.feishu?.allowedUsers || [] : current.group?.listenChats || [];
    const next = action === 'add' ? [...new Set([...existing, ...ids])] : existing.filter(id => !ids.includes(id));
    if (kind === 'users') {
      if (!next.length) throw new Error('不能删除最后一个白名单用户；请先添加其他用户');
      return { ...current, feishu: { ...current.feishu, allowedUsers: next } };
    }
    return { ...current, group: { ...current.group, listenChats: next } };
  });
}
export function accessSummary(slug: string, config: RuntimeConfig, kind: 'users' | 'groups') {
  return kind === 'users' ? { slug, users: config.feishu?.allowedUsers || [] }
    : { slug, groups: config.group?.listenChats || [], requireMention: true, permission: 'im:message.group_msg' };
}
export function recentGroupMessages(root: string, chatId: string, limit: number) {
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId)) throw new Error('请提供 oc_ 开头的群 chat_id');
  return new GroupInbox(root).recent(chatId, limit);
}
