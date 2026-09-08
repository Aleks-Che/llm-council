import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseMessageAttachments } from '../attachments';
import CopyButton from './CopyButton';

export default function UserMessageContent({ content, messageIndex, activeAttachmentKey, onOpenAttachment, onEdit, editDisabled }) {
  const message = useMemo(() => parseMessageAttachments(content), [content]);

  return (
    <div className="message-content">
      <div className="user-message-actions">
        <button type="button" className="user-message-edit" aria-label="Редактировать запрос"
          title={editDisabled ? 'Редактирование доступно после остановки ответа' : 'Редактировать запрос'}
          disabled={editDisabled} onClick={onEdit}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m16 3 5 5M4 15 16 3a3.5 3.5 0 0 1 5 5L9 20l-6 1 1-6Z" />
          </svg>
        </button>
        <CopyButton text={content} />
      </div>
      {message.attachments.length > 0 && (
        <div className="message-attachments">
          {message.attachments.map((attachment, index) => {
            const key = `message-${messageIndex}-${index}`;
            return (
              <button
                key={key}
                type="button"
                className="attachment-chip attachment-open"
                aria-label={`Открыть файл ${attachment.name}`}
                aria-expanded={activeAttachmentKey === key}
                aria-controls={activeAttachmentKey === key ? 'attachment-preview' : undefined}
                title={attachment.name}
                onClick={(event) => onOpenAttachment(attachment, key, event)}
              >
                <span aria-hidden="true">📎</span>
                <span className="attachment-name">{attachment.name}</span>
                <span className="attachment-size">{attachment.sizeLabel}</span>
              </button>
            );
          })}
        </div>
      )}
      {message.text && (
        <div className="markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
