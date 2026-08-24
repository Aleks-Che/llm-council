import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import './ChatInterface.css';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB на файл
const MAX_FILES = 10;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Читаем файл как текст. Сначала UTF-8; если видим U+FFFD (битая кодировка),
// повторно читаем как windows-1251 — частый случай для русских .txt.
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (text.includes('\uFFFD')) {
        const fallback = new FileReader();
        fallback.onload = () => resolve(fallback.result);
        fallback.onerror = () => resolve(text); // отдаём как есть
        fallback.readAsText(file, 'windows-1251');
      } else {
        resolve(text);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });
}

export default function ChatInterface({
  conversation,
  onSendMessage,
  isLoading,
}) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversation]);

  const addFiles = async (fileList) => {
    setAttachError(null);
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const accepted = [];
    const rejected = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        rejected.push(`${file.name} (${formatSize(file.size)} — больше 1 MB)`);
        continue;
      }
      try {
        const content = await readFileAsText(file);
        accepted.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          size: file.size,
          content,
        });
      } catch {
        rejected.push(`${file.name} (не удалось прочитать)`);
      }
    }

    setAttachments((prev) => {
      const room = MAX_FILES - prev.length;
      const extra = accepted.slice(room);
      const merged = [...prev, ...accepted.slice(0, room)];
      if (extra.length > 0) {
        setAttachError(
          `Максимум ${MAX_FILES} файлов. Не добавлены: ${extra.map((f) => f.name).join(', ')}`
        );
      }
      return merged;
    });

    if (rejected.length > 0) {
      setAttachError(`Не добавлены: ${rejected.join(', ')}`);
    }
  };

  const handleFilePick = (e) => {
    addFiles(e.target.files);
    e.target.value = ''; // позволяет выбрать тот же файл повторно
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // Drag & drop: счётчик depth, чтобы dragleave на дочерних элементах
  // не гасил подсветку раньше времени.
  const handleDragEnter = (e) => {
    e.preventDefault();
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (isLoading) return;
    addFiles(e.dataTransfer?.files);
  };

  const buildContent = () => {
    let content = input.trim();
    if (attachments.length > 0) {
      const parts = attachments.map(
        (a) =>
          `**📎 ${a.name}** (${formatSize(a.size)}):\n\n~~~~text\n${a.content}\n~~~~`
      );
      content += `${content ? '\n\n' : ''}---\n\n**Прикреплённые файлы:**\n\n${parts.join('\n\n')}`;
    }
    return content;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const canSend = (input.trim() || attachments.length > 0) && !isLoading;
    if (canSend) {
      const meta = attachments.map(({ name, size }) => ({ name, size }));
      onSendMessage(buildContent(), meta);
      setInput('');
      setAttachments([]);
      setAttachError(null);
    }
  };

  const handleKeyDown = (e) => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  if (!conversation) {
    return (
      <div className="chat-interface">
        <div className="empty-state">
          <h2>Добро пожаловать в LLM Council</h2>
          <p>Создайте новый диалог, чтобы начать</p>
        </div>
      </div>
    );
  }

  const canSend = (input.trim() || attachments.length > 0) && !isLoading;

  return (
    <div
      className={`chat-interface${isDragging ? ' drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            Отпустите файлы, чтобы прикрепить их к вопросу
          </div>
        </div>
      )}

      <div className="messages-container">
        {conversation.messages.length === 0 ? (
          <div className="empty-state">
            <h2>Начните диалог</h2>
            <p>Задайте вопрос Совету LLM</p>
          </div>
        ) : (
          conversation.messages.map((msg, index) => (
            <div key={index} className="message-group">
              {msg.role === 'user' ? (
                <div className="user-message">
                  <div className="message-label">Вы</div>
                  <div className="message-content">
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="message-attachments">
                        {msg.attachments.map((a, i) => (
                          <span key={i} className="attachment-chip">
                            📎 {a.name}
                            <span className="attachment-size">
                              {formatSize(a.size)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="markdown-content">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="assistant-message">
                  <div className="message-label">LLM Council</div>

                  {/* Stage 1 */}
                  {msg.loading?.stage1 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Этап 1: Сбор индивидуальных ответов...</span>
                    </div>
                  )}
                  {msg.stage1 && <Stage1 responses={msg.stage1} />}

                  {/* Stage 2 */}
                  {msg.loading?.stage2 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Этап 2: Взаимное ранжирование...</span>
                    </div>
                  )}
                  {msg.stage2 && (
                    <Stage2
                      rankings={msg.stage2}
                      labelToModel={msg.metadata?.label_to_model}
                      aggregateRankings={msg.metadata?.aggregate_rankings}
                    />
                  )}

                  {/* Stage 3 */}
                  {msg.loading?.stage3 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Этап 3: Финальный синтез...</span>
                    </div>
                  )}
                  {msg.stage3 && <Stage3 finalResponse={msg.stage3} />}
                </div>
              )}
            </div>
          ))
        )}

        {isLoading && (
          <div className="loading-indicator">
            <div className="spinner"></div>
            <span>Совет рассматривает вопрос...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {conversation.messages.length === 0 && (
        <form className="input-form" onSubmit={handleSubmit}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFilePick}
          />
          <div className="input-column">
            {attachments.length > 0 && (
              <div className="attachments-bar">
                {attachments.map((a) => (
                  <span key={a.id} className="attachment-chip">
                    📎 {a.name}
                    <span className="attachment-size">{formatSize(a.size)}</span>
                    <button
                      type="button"
                      className="attachment-remove"
                      onClick={() => removeAttachment(a.id)}
                      title="Убрать файл"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachError && <div className="attach-error">{attachError}</div>}
            <textarea
              className="message-input"
              placeholder="Задайте ваш вопрос... (Enter — отправить, Shift+Enter — новая строка; файлы — скрепкой или drag&drop)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              rows={3}
            />
          </div>
          <button
            type="button"
            className="attach-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            title="Прикрепить файлы"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            type="submit"
            className="send-button"
            disabled={!canSend}
          >
            Отправить
          </button>
        </form>
      )}
    </div>
  );
}
