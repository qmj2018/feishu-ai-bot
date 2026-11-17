import type { Client } from '@larksuiteoapi/node-sdk';

interface Fence { marker: string; opening: string }
const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;

function nextFence(line: string, current?: Fence): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r?\n$/, ''));
  if (!match) return current;
  if (current) {
    return match[1][0] === current.marker[0] && match[1].length >= current.marker.length && !match[2].trim()
      ? undefined : current;
  }
  if (match[1][0] === '`' && match[2].includes('`')) return;
  return { marker: match[1], opening: line.replace(/\r?\n$/, '') };
}

// Budget JSON-escaped UTF-8 bytes, prefer line boundaries, and close/reopen
// fenced code blocks at message boundaries so every part renders on its own.
export function splitMarkdown(text: string, maxBytes = 18_000): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 256) throw new Error('Markdown 分段大小无效');
  const chunks: string[] = [];
  let body = '', bytes = 0, hasSource = false;
  let fence: Fence | undefined;
  const reserve = (value?: Fence) => value ? encodedBytes('\n' + value.marker) : 0;
  const append = (value: string) => { body += value; bytes += encodedBytes(value); hasSource = true; };
  const flush = () => {
    if (!hasSource) return;
    chunks.push(body + (fence ? (body.endsWith('\n') ? '' : '\n') + fence.marker : ''));
    body = fence ? fence.opening + '\n' : '';
    bytes = encodedBytes(body); hasSource = false;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    let after = nextFence(line, fence);
    // Extremely long fence markers/info strings cannot be repeated within the
    // budget. Treat them as an oversized literal line instead.
    if (after && encodedBytes(after.opening + '\n' + after.marker) > maxBytes / 2) after = fence;
    const lineBytes = encodedBytes(line);
    if (bytes + lineBytes + reserve(after) > maxBytes) flush();
    if (bytes + lineBytes + reserve(after) <= maxBytes) {
      append(line); fence = after; continue;
    }
    // A single oversized line must be split; iterate code points so UTF-16
    // surrogate pairs (such as emoji) are never broken.
    for (const character of line) {
      if (bytes + encodedBytes(character) + reserve(fence) > maxBytes) flush();
      append(character);
    }
  }
  flush();
  return chunks;
}

export function createMarkdownReply(api: Pick<Client['im']['v1']['message'], 'reply'>) {
  return async (messageId: string, markdown: string): Promise<void> => {
    for (const text of splitMarkdown(markdown)) {
      // Official post/md rendering supports headings, code blocks, and GFM tables.
      const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } });
      const result = await api.reply({ path: { message_id: messageId }, data: { msg_type: 'post', content } });
      if (result.code) throw new Error('飞书 Markdown 回复失败');
    }
  };
}
