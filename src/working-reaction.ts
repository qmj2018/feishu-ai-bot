import type { Client } from '@larksuiteoapi/node-sdk';

export interface WorkingReaction {
  add(messageId: string): Promise<string | undefined>;
  remove(messageId: string, reactionId: string): Promise<void>;
}

// Use the bot's own reaction record so other people's reactions remain intact.
export function createWorkingReaction(api: Pick<Client['im']['v1']['messageReaction'], 'create' | 'delete'>): WorkingReaction {
  return {
    async add(messageId) {
      const result = await api.create({ path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'Typing' } } });
      if (result.code || !result.data?.reaction_id) {
        throw new Error(`添加执行状态表情失败 (${result.code ?? 'missing reaction_id'})`);
      }
      return result.data.reaction_id;
    },
    async remove(messageId, reactionId) {
      const result = await api.delete({ path: { message_id: messageId, reaction_id: reactionId } });
      if (result.code) throw new Error(`移除执行状态表情失败 (${result.code})`);
    },
  };
}
