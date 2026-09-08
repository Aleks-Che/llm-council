import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import Research from './Research';
import ModelSelector from './ModelSelector';
import { modelName } from '../modelNames';
import { api } from '../api';
import CopyButton from './CopyButton';
import ErrorBoundary from './ErrorBoundary';
import AttachmentPreview from './AttachmentPreview';
import UserMessageContent from './UserMessageContent';
import { buildMessageContent, formatSize, parseMessageAttachments } from '../attachments';
import './ChatInterface.css';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB на файл
const MAX_FILES = 10;
// Вставка текста длиннее этого порога превращается во вложение .txt
const PASTE_AS_FILE_THRESHOLD = 2000;

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

// Какой этап сейчас генерируется — по статусу запуска, сохранённому бэкендом
// (переживает перезагрузку страницы).
function isStageLoading(msg, stage) {
  return msg?.status === 'running' && msg?.current_stage === stage;
}

function messageLoading(msg) {
  return {
    research: msg?.status === 'running' && msg?.current_stage === 'research',
    stage1: isStageLoading(msg, 'stage1'),
    stage2: isStageLoading(msg, 'stage2'),
    stage3: isStageLoading(msg, 'stage3'),
    chat: isStageLoading(msg, 'chat'),
  };
}

// Отпечаток значимых для скролла изменений: новые сообщения, статус/этап
// запуска, появление контента этапов. Поллинг без изменений даёт ту же
// сигнатуру и не дёргает автоскролл.
function conversationSignature(conversation) {
  const messages = conversation?.messages ?? [];
  const last = messages[messages.length - 1];
  return [
    messages.length,
    last?.status ?? '',
    last?.current_stage ?? '',
    last?.research?.phase ?? '',
    Boolean(last?.stage1),
    Boolean(last?.stage2),
    Boolean(last?.stage3),
    Boolean(last?.content),
    last?.error ?? '',
  ].join('|');
}

export default function ChatInterface({
  conversation,
  onSendMessage,
  onRetryRun,
  isLoading,
  onActiveSectionChange,
  scrollApiRef,
  settings,
  settingsError,
  savingModels,
  onModelSelection,
  onReloadSettings,
}) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [editSession, setEditSession] = useState(null);
  const inputRef = useRef(null);
  const [activeAttachment, setActiveAttachment] = useState(null);
  const attachmentTriggerRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const [searchEnabled, setSearchEnabled] = useState(() => Boolean(conversation?.messages?.findLast((m) => m.role === 'user')?.search_enabled));
  const [councilEnabled, setCouncilEnabled] = useState(() => {
    const last = conversation?.messages?.findLast((m) => m.role === 'assistant');
    return Boolean(last && last.mode !== 'chat');
  });
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const sectionRefs = useRef({});
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const prevConversationIdRef = useRef(null);
  const prevSignatureRef = useRef(null);

  const openAttachment = (attachment, key, event) => {
    attachmentTriggerRef.current = event.currentTarget;
    setActiveAttachment({ ...attachment, key });
  };

  const closeAttachment = useCallback(() => {
    setActiveAttachment(null);
    attachmentTriggerRef.current?.focus({ preventScroll: true });
  }, []);

  const beginEdit = (message, messageIndex) => {
    if (isLoading || submitting || retrying || cancelling) return;
    const parsed = parseMessageAttachments(message.content);
    setEditSession({
      messageIndex, originalContent: message.content, messageCount: conversation.messages.length,
      draft: editSession?.draft ?? { input, attachments, searchEnabled, councilEnabled },
    });
    setInput(parsed.text);
    setAttachments(parsed.attachments.map((attachment, index) => ({
      ...attachment, id: `edit-${messageIndex}-${index}`, size: new Blob([attachment.content]).size,
    })));
    setSearchEnabled(Boolean(message.search_enabled));
    const answer = conversation.messages[messageIndex + 1];
    if (answer?.role === 'assistant') setCouncilEnabled(answer.mode !== 'chat');
    setActiveAttachment(null);
    setSendError('');
    setAttachError(null);
    inputRef.current?.focus();
  };

  const restoreDraft = () => {
    const draft = editSession.draft;
    setInput(draft.input);
    setAttachments(draft.attachments);
    setSearchEnabled(draft.searchEnabled);
    setCouncilEnabled(draft.councilEnabled);
    setEditSession(null);
    setActiveAttachment(null);
    setSendError('');
    setAttachError(null);
    inputRef.current?.focus();
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Скролл к началу последнего доступного этапа последнего ответа
  const scrollToLastAvailableStage = () => {
    const messages = conversation?.messages ?? [];
    const last = messages[messages.length - 1];
    let target = 'user';
    if (last?.role === 'assistant') {
      if (last.mode === 'chat' && last.content) target = 'chat';
      else if (last.stage3) target = 'stage3';
      else if (last.stage2) target = 'stage2';
      else if (last.stage1) target = 'stage1';
      else if (last.research) target = 'research';
    }
    const el = sectionRefs.current[target];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      scrollToBottom();
    }
  };

  // При смене диалога — скролл к началу последнего доступного этапа.
  // При обновлениях того же диалога (завершение этапа, новое сообщение) —
  // вниз, но только если пользователь и так у низа: чтение истории выше
  // автоскролл не сбрасывает. Обновления без реальных изменений (поллинг)
  // дают прежнюю сигнатуру и вообще не трогают скролл.
  useEffect(() => {
    if (!conversation) {
      prevConversationIdRef.current = null;
      prevSignatureRef.current = null;
      return;
    }
    const signature = conversationSignature(conversation);
    const isNewConversation =
      conversation.id !== prevConversationIdRef.current;
    prevConversationIdRef.current = conversation.id;
    if (isNewConversation) {
      prevSignatureRef.current = signature;
      scrollToLastAvailableStage();
      return;
    }
    if (signature === prevSignatureRef.current) return;
    prevSignatureRef.current = signature;
    const container = messagesContainerRef.current;
    const nearBottom =
      !container ||
      container.scrollHeight - container.scrollTop - container.clientHeight <
        150;
    if (nearBottom) scrollToBottom();
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
    ['user', 'research', 'stage1', 'stage2', 'stage3', 'chat'].forEach((id) => {
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
    if (activeAttachment?.key === `draft-${id}`) setActiveAttachment(null);
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    const canSend = (input.trim() || attachments.length > 0) && !isLoading && !submitting && settings && !savingModels;
    if (canSend) {
      setSubmitting(true);
      setSendError('');
      try {
        const meta = attachments.map(({ name, size }) => ({ name, size }));
        await onSendMessage(buildMessageContent(input, attachments), meta, searchEnabled, {
          council_enabled: councilEnabled,
          chat_model: settings.chat_model || settings.chairman_model,
          council_models: settings.council_models,
          chairman_model: settings.chairman_model,
        }, editSession && {
          messageIndex: editSession.messageIndex, originalContent: editSession.originalContent,
          messageCount: editSession.messageCount,
        });
        if (editSession) restoreDraft();
        else {
          setInput('');
          setAttachments([]);
        }
        setActiveAttachment(null);
        setAttachError(null);
      } catch (error) {
        setSendError(error.message || 'Не удалось отправить запрос');
      } finally {
        setSubmitting(false);
      }
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    setSendError('');
    try { await api.cancelRun(conversation.id); }
    catch (error) { setSendError(error.message); }
    finally { setCancelling(false); }
  };

  const handleRetry = async () => {
    const chatRetry = conversation.messages.at(-1)?.mode === 'chat';
    if (editSession || retrying || isLoading || submitting || savingModels || (chatRetry && !settings)) return;
    setRetrying(true);
    setSendError('');
    try {
      await onRetryRun(conversation.id, chatRetry
        ? { chat_model: settings.chat_model || settings.chairman_model } : {});
    }
    catch (error) { setSendError(error.message || 'Не удалось повторить запуск'); }
    finally { setRetrying(false); }
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

  const canSend = (input.trim() || attachments.length > 0) && !isLoading && !submitting && settings && !savingModels;

  return (
    <div className="chat-workspace">
    <div
      className={`chat-interface${isDragging ? ' drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ModelSelector key={councilEnabled ? 'council' : 'chat'} councilEnabled={councilEnabled}
        settings={settings} disabled={isLoading || submitting || savingModels || retrying} error={settingsError}
        onChange={onModelSelection} onReload={onReloadSettings} />
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
            <p>{councilEnabled ? 'Задайте вопрос Совету LLM' : 'Задайте вопрос выбранной модели'}</p>
          </div>
        ) : (
          conversation.messages.map((msg, index) => {
            const isLastExchange =
              index >= conversation.messages.length - 2;
            const loading =
              msg.role === 'assistant' ? messageLoading(msg) : null;
            const setSectionRef = (id) => (el) => {
              if (el) sectionRefs.current[id] = el;
              else delete sectionRefs.current[id];
            };
            return (
            <ErrorBoundary key={index}>
            <div className="message-group">
              {msg.role === 'user' ? (
                <div
                  className={`user-message${editSession?.messageIndex === index ? ' is-editing' : ''}`}
                  ref={isLastExchange ? setSectionRef('user') : undefined}
                  data-section="user"
                >
                  <div className="message-label">Вы {msg.search_enabled && <span className="message-search-label">· Поиск включён</span>}</div>
                  <UserMessageContent content={msg.content} messageIndex={index}
                    activeAttachmentKey={activeAttachment?.key} onOpenAttachment={openAttachment}
                    onEdit={() => beginEdit(msg, index)} editDisabled={isLoading || submitting || retrying || cancelling} />
                </div>
              ) : (
                <div className="assistant-message">
                  <div className="message-label">{msg.mode === 'chat' ? modelName(msg.model, msg.model_labels) : 'LLM Council'}</div>

                  {/* Stage progress: ✓ done / spinner running / ○ pending */}
                  {(msg.research || loading.research || msg.stage1 ||
                    msg.stage2 ||
                    msg.stage3 ||
                    loading.stage1 ||
                    loading.stage2 ||
                    loading.stage3 || loading.chat || (msg.mode === 'chat' && msg.content && msg.research)) && (
                    <div className="stage-progress">
                      {[
                        ...(msg.research || loading.research ? [{ key: 'research', label: 'Поиск' }] : []),
                        ...(msg.mode === 'chat' ? [{ key: 'chat', label: 'Ответ модели' }] : [
                        { key: 'stage1', label: 'Этап 1: Ответы моделей' },
                        { key: 'stage2', label: 'Этап 2: Ранжирование' },
                        { key: 'stage3', label: 'Этап 3: Финальный синтез' }]),
                      ].map((s) => {
                        const done = s.key === 'research' ? Boolean(msg.research && msg.research.status !== 'running')
                          : msg.completed_stages ? msg.completed_stages.includes(s.key) : Boolean(msg[s.key]);
                        const warning = s.key === 'research' && done && msg.research.status !== 'complete';
                        const running = Boolean(loading[s.key]);
                        return (
                          <span
                            key={s.key}
                            className={`stage-chip ${
                              warning ? 'warning' : done ? 'done' : running ? 'running' : 'pending'
                            }`}
                          >
                            {done ? (
                              <span className="stage-chip-icon">{warning ? '!' : '✓'}</span>
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

                  {(msg.research || loading.research) && (
                    <div ref={isLastExchange ? setSectionRef('research') : undefined} data-section="research" className="stage-anchor">
                      <Research key={msg.research?.id || 'pending'} research={msg.research} conversationId={conversation.id} running={loading.research} />
                    </div>
                  )}

                  {msg.mode === 'chat' && msg.content && (
                    <div ref={isLastExchange ? setSectionRef('chat') : undefined} data-section="chat"
                      className="chat-answer stage-anchor">
                      <CopyButton className="chat-answer-copy" text={msg.content} />
                      <div className="markdown-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      </div>
                    </div>
                  )}

                  {/* Stage 1 */}
                  {loading.stage1 && (
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
                      <Stage1 responses={msg.stage1} modelLabels={msg.model_labels} />
                    </div>
                  )}

                  {/* Stage 2 */}
                  {loading.stage2 && (
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
                        modelLabels={msg.model_labels}
                      />
                    </div>
                  )}

                  {/* Stage 3 */}
                  {loading.stage3 && (
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
                      <Stage3 finalResponse={msg.stage3} modelLabels={msg.model_labels} />
                    </div>
                  )}

                  {/* Run failed or was interrupted by a server restart */}
                  {msg.status === 'cancelled' && <div className="research-notice">Запуск остановлен. Собранные материалы сохранены.</div>}
                  {(msg.status === 'error' || msg.status === 'interrupted') && (
                    <div className="stage-error" role="alert">
                      {msg.status === 'interrupted'
                        ? '⚠️ Запуск был прерван перезапуском сервера.'
                        : '⚠️ Ошибка при выполнении запуска.'}
                      {msg.error ? ` ${msg.error}` : ''}
                    </div>
                  )}
                  {isLastExchange && ['error', 'interrupted', 'cancelled'].includes(msg.status) && (
                    <div className="retry-run-actions">
                      <button type="button" className="retry-run-button" onClick={handleRetry}
                        disabled={Boolean(editSession) || retrying || isLoading || submitting || savingModels || (msg.mode === 'chat' && !settings)}>
                        {retrying ? 'Продолжаем…' : 'Повторить'}
                      </button>
                      <span>{msg.mode === 'chat' ? 'Повторить с выбранной моделью. Собранные источники сохранятся.' : 'Продолжить с незавершённого этапа. Полученные ответы сохранятся.'}</span>
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
                  if (last.current_stage === 'research') return 'Собираем информацию для ответа…';
                  if (isStageLoading(last, 'chat')) return 'Модель готовит ответ…';
                  if (isStageLoading(last, 'stage1'))
                    return 'Этап 1: Сбор индивидуальных ответов...';
                  if (isStageLoading(last, 'stage2'))
                    return 'Этап 2: Взаимное ранжирование...';
                  if (isStageLoading(last, 'stage3'))
                    return 'Этап 3: Финальный синтез...';
                }
                return last?.mode === 'chat' ? 'Модель готовит ответ…' : 'Совет рассматривает вопрос...';
              })()}
            </span>
            <button type="button" className="cancel-run-button" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? 'Останавливаем…' : 'Остановить'}
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

        <form className="input-form" onSubmit={handleSubmit}>
          {editSession && (
            <div className="composer-edit-banner">
              <div>
                <strong>Редактирование запроса</strong>
                <p>{editSession.messageIndex < editSession.messageCount - 2
                  ? 'После отправки этот запрос и все сообщения после него будут заменены.'
                  : 'Запрос будет обновлён, ответ — запущен заново.'}</p>
              </div>
              <button type="button" onClick={restoreDraft} disabled={submitting || isLoading}
                aria-label="Отменить редактирование">Отмена</button>
            </div>
          )}
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
                  <span key={a.id} className="attachment-chip draft-attachment-chip">
                    <button type="button" className="attachment-open"
                      aria-label={`Открыть файл ${a.name}`}
                      aria-expanded={activeAttachment?.key === `draft-${a.id}`}
                      aria-controls={activeAttachment?.key === `draft-${a.id}` ? 'attachment-preview' : undefined}
                      title={a.name} onClick={(event) => openAttachment(a, `draft-${a.id}`, event)}>
                      <span aria-hidden="true">📎</span>
                      <span className="attachment-name">{a.name}</span>
                      <span className="attachment-size">{formatSize(a.size)}</span>
                    </button>
                    <button
                      type="button"
                      className="attachment-remove"
                      onClick={() => removeAttachment(a.id)}
                      title="Убрать файл"
                      aria-label={`Убрать файл ${a.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachError && <div className="attach-error">{attachError}</div>}
            {sendError && <div role="alert" className="stage-error">{sendError}</div>}
            <textarea
              ref={inputRef}
              className="message-input"
              aria-label="Ваш вопрос"
              placeholder="Задайте ваш вопрос... (Enter — отправить, Shift+Enter — новая строка; файлы — скрепкой или drag&drop; вставка текста > 2000 символов прикрепит его как .txt)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={isLoading || submitting}
              rows={3}
            />
          </div>
          <div className="input-toolbar">
            <button type="button" className={`search-toggle${searchEnabled ? ' active' : ''}`}
              aria-pressed={searchEnabled} disabled={isLoading || submitting}
              onClick={() => setSearchEnabled((enabled) => !enabled)}
              title={searchEnabled ? 'Поиск включён: сначала собрать источники' : 'Найти источники в интернете перед ответом'}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5h14M5 17.5h14" />
              </svg>
              Поиск
              {searchEnabled && <span className="search-toggle-check" aria-hidden="true">✓</span>}
            </button>
            <button type="button" className={`search-toggle council-toggle${councilEnabled ? ' active' : ''}`}
              aria-pressed={councilEnabled} disabled={isLoading || submitting || savingModels}
              onClick={() => setCouncilEnabled((enabled) => !enabled)}
              title="Совет: ответы нескольких моделей, взаимная оценка и итог председателя">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <circle cx="12" cy="7" r="3" /><path d="M6 21v-3a6 6 0 0 1 12 0v3M5 5a3 3 0 0 0 0 6M19 5a3 3 0 0 1 0 6M2 20v-3a4 4 0 0 1 3-4M22 20v-3a4 4 0 0 0-3-4" />
              </svg>
              Совет
              {councilEnabled && <span className="search-toggle-check" aria-hidden="true">✓</span>}
            </button>
          <button
            type="button"
            className="attach-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || submitting}
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
            {editSession ? 'Сохранить и отправить' : 'Отправить'}
          </button>
          </div>
        </form>
    </div>
    {activeAttachment && (
      <AttachmentPreview key={activeAttachment.key} attachment={activeAttachment} onClose={closeAttachment} />
    )}
    </div>
  );
}
