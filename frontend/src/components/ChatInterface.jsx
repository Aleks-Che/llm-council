import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import CopyButton from './CopyButton';
import ErrorBoundary from './ErrorBoundary';
import './ChatInterface.css';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB на файл
const MAX_FILES = 10;
// Вставка текста длиннее этого порога превращается во вложение .txt
const PASTE_AS_FILE_THRESHOLD = 2000;

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
  onActiveSectionChange,
  scrollApiRef,
}) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const sectionRefs = useRef({});
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const prevConversationIdRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Скролл к началу последнего доступного этапа последнего ответа
  const scrollToLastAvailableStage = () => {
    const messages = conversation?.messages ?? [];
    const last = messages[messages.length - 1];
    let target = 'user';
    if (last?.role === 'assistant') {
      if (last.stage3) target = 'stage3';
      else if (last.stage2) target = 'stage2';
      else if (last.stage1) target = 'stage1';
    }
    const el = sectionRefs.current[target];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      scrollToBottom();
    }
  };

  // При смене диалога — скролл к началу последнего доступного этапа;
  // при обновлениях того же диалога (новые сообщения, стриминг) — вниз.
  useEffect(() => {
    if (!conversation) {
      prevConversationIdRef.current = null;
      return;
    }
    const isNewConversation = conversation.id !== prevConversationIdRef.current;
    prevConversationIdRef.current = conversation.id;
    if (isNewConversation) {
      scrollToLastAvailableStage();
    } else {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем только на смену объекта диалога
  }, [conversation]);

  // Навигация: App вызывает scrollApiRef.current(sectionId) для скролла к зоне
  useEffect(() => {
    if (!scrollApiRef) return;
    scrollApiRef.current = (sectionId) => {
      sectionRefs.current[sectionId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    };
    return () => {
      scrollApiRef.current = null;
    };
  }, [scrollApiRef]);

  // Scroll-spy: какая зона сейчас видна → активная кнопка в навигации
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !onActiveSectionChange) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          );
        if (visible.length > 0) {
          onActiveSectionChange(visible[0].target.dataset.section);
        }
      },
      { root: container, rootMargin: '-10% 0px -65% 0px', threshold: 0 }
    );
    ['user', 'stage1', 'stage2', 'stage3'].forEach((id) => {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [conversation, onActiveSectionChange]);

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

  // Вставка длинного текста (> 2000 символов): прикрепляем как .txt,
  // чтобы не раздувать поле ввода. Имя уникализируем: pasted.txt, pasted-2.txt...
  const handlePaste = (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text || text.length <= PASTE_AS_FILE_THRESHOLD) return;

    e.preventDefault();
    setAttachError(null);

    const size = new Blob([text]).size;
    if (size > MAX_FILE_SIZE) {
      setAttachError(
        `Вставленный текст не прикреплён (${formatSize(size)} — больше 1 MB)`
      );
      return;
    }

    setAttachments((prev) => {
      if (prev.length >= MAX_FILES) {
        setAttachError(
          `Максимум ${MAX_FILES} файлов. Вставленный текст не прикреплён.`
        );
        return prev;
      }
      const names = new Set(prev.map((a) => a.name));
      let name = 'pasted.txt';
      let n = 1;
      while (names.has(name)) {
        n += 1;
        name = `pasted-${n}.txt`;
      }
      return [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name,
          size,
          content: text,
        },
      ];
    });
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

      <div className="messages-container" ref={messagesContainerRef}>
        {conversation.messages.length === 0 ? (
          <div className="empty-state">
            <h2>Начните диалог</h2>
            <p>Задайте вопрос Совету LLM</p>
          </div>
        ) : (
          conversation.messages.map((msg, index) => {
            const isLastExchange =
              index >= conversation.messages.length - 2;
            const setSectionRef = (id) => (el) => {
              if (el) sectionRefs.current[id] = el;
              else delete sectionRefs.current[id];
            };
            return (
            <ErrorBoundary key={index}>
            <div className="message-group">
              {msg.role === 'user' ? (
                <div
                  className="user-message"
                  ref={isLastExchange ? setSectionRef('user') : undefined}
                  data-section="user"
                >
                  <div className="message-label">Вы</div>
                  <div className="message-content">
                    <CopyButton
                      className="user-message-copy"
                      text={msg.content}
                    />
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="assistant-message">
                  <div className="message-label">LLM Council</div>

                  {/* Stage progress: ✓ done / spinner running / ○ pending */}
                  {(msg.stage1 ||
                    msg.stage2 ||
                    msg.stage3 ||
                    msg.loading?.stage1 ||
                    msg.loading?.stage2 ||
                    msg.loading?.stage3) && (
                    <div className="stage-progress">
                      {[
                        { key: 'stage1', label: 'Этап 1: Ответы моделей' },
                        { key: 'stage2', label: 'Этап 2: Ранжирование' },
                        { key: 'stage3', label: 'Этап 3: Финальный синтез' },
                      ].map((s) => {
                        const done = Boolean(msg[s.key]);
                        const running = Boolean(msg.loading?.[s.key]);
                        return (
                          <span
                            key={s.key}
                            className={`stage-chip ${
                              done ? 'done' : running ? 'running' : 'pending'
                            }`}
                          >
                            {done ? (
                              <span className="stage-chip-icon">✓</span>
                            ) : running ? (
                              <span className="stage-chip-spinner"></span>
                            ) : (
                              <span className="stage-chip-icon">○</span>
                            )}
                            {s.label}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* Stage 1 */}
                  {msg.loading?.stage1 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Этап 1: Сбор индивидуальных ответов...</span>
                    </div>
                  )}
                  {msg.stage1 && (
                    <div
                      ref={
                        isLastExchange ? setSectionRef('stage1') : undefined
                      }
                      data-section="stage1"
                      className="stage-anchor"
                    >
                      <Stage1 responses={msg.stage1} />
                    </div>
                  )}

                  {/* Stage 2 */}
                  {msg.loading?.stage2 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Этап 2: Взаимное ранжирование...</span>
                    </div>
                  )}
                  {msg.stage2 && (
                    <div
                      ref={
                        isLastExchange ? setSectionRef('stage2') : undefined
                      }
                      data-section="stage2"
                      className="stage-anchor"
                    >
                      <Stage2
                        rankings={msg.stage2}
                        labelToModel={msg.metadata?.label_to_model}
                        aggregateRankings={msg.metadata?.aggregate_rankings}
                      />
                    </div>
                  )}

                  {/* Stage 3 */}
                  {msg.loading?.stage3 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Этап 3: Финальный синтез...</span>
                    </div>
                  )}
                  {msg.stage3 && (
                    <div
                      ref={
                        isLastExchange ? setSectionRef('stage3') : undefined
                      }
                      data-section="stage3"
                      className="stage-anchor"
                    >
                      <Stage3 finalResponse={msg.stage3} />
                    </div>
                  )}
                </div>
              )}
            </div>
            </ErrorBoundary>
            );
          })
        )}

        {isLoading && (
          <div className="loading-indicator">
            <div className="spinner"></div>
            <span>
              {(() => {
                const last =
                  conversation.messages[conversation.messages.length - 1];
                if (last?.role === 'assistant') {
                  if (last.loading?.stage1)
                    return 'Этап 1: Сбор индивидуальных ответов...';
                  if (last.loading?.stage2)
                    return 'Этап 2: Взаимное ранжирование...';
                  if (last.loading?.stage3)
                    return 'Этап 3: Финальный синтез...';
                }
                return 'Совет рассматривает вопрос...';
              })()}
            </span>
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
              placeholder="Задайте ваш вопрос... (Enter — отправить, Shift+Enter — новая строка; файлы — скрепкой или drag&drop; вставка текста > 2000 символов прикрепит его как .txt)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
