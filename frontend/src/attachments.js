export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const isMarkdownAttachment = (name) =>
  /\.(md|markdown)$/i.test(String(name)) || /^pasted(?:-\d+)?\.txt$/i.test(String(name));

export function buildMessageContent(input, attachments) {
  const text = input.trim();
  if (!attachments.length) return text;

  const parts = attachments.map((attachment) => {
    // Keep fences inside the file from closing its enclosing attachment block.
    let fenceLength = 4;
    for (const [run] of attachment.content.matchAll(/~+/g)) {
      fenceLength = Math.max(fenceLength, run.length + 1);
    }
    const fence = '~'.repeat(fenceLength);
    const language = isMarkdownAttachment(attachment.name) ? 'markdown' : 'text';
    return `**📎 ${attachment.name}** (${formatSize(attachment.size)}):\n\n${fence}${language}\n${attachment.content}\n${fence}`;
  });
  return `${text}${text ? '\n\n' : ''}---\n\n**Прикреплённые файлы:**\n\n${parts.join('\n\n')}`;
}

// Attachments are stored in the message text, including in older conversations
// where no separate attachment metadata survives a reload.
export function parseMessageAttachments(content) {
  const text = String(content ?? '');
  const section = /(?:^|\r?\n\r?\n)---\r?\n\r?\n\*\*Прикреплённые файлы:\*\*\r?\n\r?\n/g;
  for (const marker of text.matchAll(section)) {
    const block = /\*\*📎 ([^\r\n]+)\*\* \((\d+(?:\.\d+)? (?:B|KB|MB))\):\r?\n\r?\n(~{4,})(?:text|markdown)\r?\n([\s\S]*?)\r?\n\3(?=(?:\r?\n\r?\n\*\*📎 )|(?:\s*$))/y;
    const attachments = [];
    let position = marker.index + marker[0].length;
    while (position < text.length) {
      block.lastIndex = position;
      const match = block.exec(text);
      if (!match) break;
      attachments.push({ name: match[1], sizeLabel: match[2], content: match[4] });
      position = block.lastIndex;
      const remaining = text.slice(position);
      if (!remaining.trim()) return { text: text.slice(0, marker.index), attachments };
      const separator = /^(?:\r?\n){2}/.exec(remaining);
      if (!separator) break;
      position += separator[0].length;
    }
  }
  // Never hide ordinary text or incomplete blocks that cannot be recovered.
  return { text, attachments: [] };
}
