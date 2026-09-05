import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import ErrorBoundary from './components/ErrorBoundary';
import { api } from './api';
import './App.css';

// Как часто опрашивать текущий диалог и список диалогов во время запусков
const CONVERSATION_POLL_MS = 2000;
const LIST_POLL_MS = 3000;

// Лёгкий отпечаток значимых изменений диалога (этапы пишутся на бэкенде
// атомарно и не меняются после записи). Поллинг неизменившегося диалога
// даёт тот же отпечаток — кэш не создаёт новую ссылку, и ChatInterface
// не дёргает автоскролл и не перерисовывает разметку без причины.
function conversationFingerprint(conv) {
  const messages = conv?.messages ?? [];
  const parts = [String(messages.length)];
  for (const m of messages) {
    if (m.role === 'assistant') {
      parts.push(
        [
          m.status ?? '',
          m.current_stage ?? '',
          m.error ?? '',
          m.stage1 ? m.stage1.length : 0,
          m.stage2 ? m.stage2.length : 0,
          m.stage3 ? 1 : 0,
        ].join(':')
      );
    } else {
      parts.push(`u:${(m.content ?? '').length}`);
    }
  }
  return parts.join('|');
}

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  // Кэш диалогов, ключ — id. Запусками управляет бэкенд, фронтенд только
  // наблюдает прогресс поллингом, поэтому перезагрузка страницы ничего
  // не прерывает и несколько диалогов могут выполняться одновременно.
  const [convCache, setConvCache] = useState({});
  // Навигация по зонам ответа: user / stage1 / stage2 / stage3.
  const [activeSection, setActiveSection] = useState('stage3');
  const chatScrollRef = useRef(null);
  // Отпечатки последнего загруженного состояния диалогов (см. conversationFingerprint)
  const fpRef = useRef({});

  const loadConversations = async () => {
    try {
      const convs = await api.listConversations();
      setConversations(convs);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  };

  const loadConversation = async (id) => {
    try {
      const conv = await api.getConversation(id);
      const fp = conversationFingerprint(conv);
      // Поллинг не должен создавать новый объект без реальных изменений:
      // новая ссылка на диалог дёргает автоскролл в ChatInterface.
      if (fpRef.current[id] === fp) return;
      fpRef.current[id] = fp;
      setConvCache((prev) => ({ ...prev, [id]: conv }));
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  // Load conversations on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    loadConversations();
  }, []);

  const anyRunning = conversations.some((c) => c.is_running);

  // Пока есть работающие диалоги, опрашиваем список: статусы в сайдбаре,
  // обновлённые заголовки, переходы running -> complete.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(loadConversations, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // Текущий диалог подгружаем при выборе и опрашиваем, пока он в работе.
  // Повторный запуск эффекта при каждом обновлении списка даёт финальную
  // подгрузку, когда запуск завершился.
  useEffect(() => {
    if (!currentConversationId) return;
    const running = conversations.some(
      (c) => c.id === currentConversationId && c.is_running
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on selection/run start
    loadConversation(currentConversationId);
    if (!running) return;
    const timer = setInterval(
      () => loadConversation(currentConversationId),
      CONVERSATION_POLL_MS
    );
    return () => clearInterval(timer);
  }, [currentConversationId, conversations]);

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation();
      setConversations((prev) => [
        {
          id: newConv.id,
          created_at: newConv.created_at,
          title: newConv.title,
          message_count: 0,
          is_running: false,
        },
        ...prev,
      ]);
      setConvCache((prev) => ({ ...prev, [newConv.id]: newConv }));
      setCurrentConversationId(newConv.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  // Последний доступный этап диалога — к нему скроллим при открытии.
  const getLastAvailableSection = (conv) => {
    const last = conv?.messages?.[conv.messages.length - 1];
    if (last?.role === 'assistant') {
      if (last.stage3) return 'stage3';
      if (last.stage2) return 'stage2';
      if (last.stage1) return 'stage1';
    }
    return 'user';
  };

  const handleSelectConversation = (id) => {
    setCurrentConversationId(id);
    // Подсветка навигации соответствует месту скролла (последний доступный этап)
    const conv = convCache[id];
    setActiveSection(conv ? getLastAvailableSection(conv) : 'stage3');
  };

  const handleRenameConversation = async (id, newTitle) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      const updated = await api.renameConversation(id, trimmed);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: updated.title } : c))
      );
      setConvCache((prev) =>
        prev[id] ? { ...prev, [id]: { ...prev[id], title: updated.title } } : prev
      );
    } catch (error) {
      console.error('Failed to rename conversation:', error);
    }
  };

  const handleDeleteConversation = async (id) => {
    try {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setConvCache((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete fpRef.current[id];
      if (currentConversationId === id) {
        setCurrentConversationId(null);
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  const handleSendMessage = async (content, attachments = []) => {
    const convId = currentConversationId;
    if (!convId) return;
    const base = convCache[convId];
    if (!base) return;
    // Один запуск на диалог; форма видна только в пустом диалоге, но
    // защищаемся и от повторного клика.
    if (base.messages.length > 0 || conversations.some((c) => c.id === convId && c.is_running)) {
      return;
    }

    // Оптимистично показываем сообщение пользователя и заглушку ответа,
    // реальный прогресс придёт поллингом с бэкенда.
    const userMessage = { role: 'user', content, attachments };
    const assistantMessage = {
      role: 'assistant',
      stage1: null,
      stage2: null,
      stage3: null,
      metadata: null,
      status: 'running',
      current_stage: 'stage1',
      error: null,
    };
    setConvCache((prev) => ({
      ...prev,
      [convId]: {
        ...base,
        messages: [...base.messages, userMessage, assistantMessage],
      },
    }));

    try {
      await api.sendMessage(convId, content);
      // Сразу обновляем список, чтобы сайдбар показал статус "в работе"
      await loadConversations();
    } catch (error) {
      console.error('Failed to send message:', error);
      // Откатываем оптимистичные сообщения при ошибке транспорта
      setConvCache((prev) => ({ ...prev, [convId]: base }));
    }
  };

  const displayedConversation = currentConversationId
    ? convCache[currentConversationId] ?? null
    : null;
  const lastMessage =
    displayedConversation?.messages?.[displayedConversation.messages.length - 1];
  const isCurrentRunning =
    lastMessage?.role === 'assistant' && lastMessage.status === 'running';

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        activeSection={activeSection}
        navVisible={Boolean(displayedConversation?.messages?.length)}
        onNavigate={(sectionId) => chatScrollRef.current?.(sectionId)}
      />
      <ErrorBoundary>
        <ChatInterface
          conversation={displayedConversation}
          onSendMessage={handleSendMessage}
          isLoading={isCurrentRunning}
          onActiveSectionChange={setActiveSection}
          scrollApiRef={chatScrollRef}
        />
      </ErrorBoundary>
    </div>
  );
}

export default App;
