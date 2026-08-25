import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import ErrorBoundary from './components/ErrorBoundary';
import { api } from './api';
import './App.css';

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  // Кэш сохранённых (persisted) диалогов, ключ — id.
  const [convCache, setConvCache] = useState({});
  // Живое состояние диалогов с активным запуском Совета, ключ — id.
  // Позволяет переключаться между диалогами, не прерывая поток,
  // и запускать несколько диалогов одновременно.
  const [activeRuns, setActiveRuns] = useState({});
  // Навигация по зонам ответа: user / stage1 / stage2 / stage3.
  // По умолчанию — stage3 (автопрокрутка вниз).
  const [activeSection, setActiveSection] = useState('stage3');
  const chatScrollRef = useRef(null);

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

  // Load conversation details when selected (если там нет активного запуска)
  useEffect(() => {
    if (currentConversationId && !activeRuns[currentConversationId]) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on selection
      loadConversation(currentConversationId);
    }
  }, [currentConversationId, activeRuns]);

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation();
      setConversations((prev) => [
        { id: newConv.id, created_at: newConv.created_at, message_count: 0 },
        ...prev,
      ]);
      setConvCache((prev) => ({ ...prev, [newConv.id]: newConv }));
      setCurrentConversationId(newConv.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  const handleSelectConversation = (id) => {
    setCurrentConversationId(id);
    setActiveSection('stage3'); // при открытии диалога навигация на финальный этап
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
      setActiveRuns((prev) =>
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
      setActiveRuns((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (currentConversationId === id) {
        setCurrentConversationId(null);
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  // Обновляет живое состояние конкретного запуска по id диалога.
  // Поток привязан к convId, поэтому переключение вкладок его не ломает.
  const updateRun = (convId, updater) => {
    setActiveRuns((prev) => {
      const conv = prev[convId];
      if (!conv) return prev;
      return { ...prev, [convId]: updater(conv) };
    });
  };

  const updateLastMessage = (convId, mutate) => {
    updateRun(convId, (conv) => {
      const messages = [...conv.messages];
      const lastIndex = messages.length - 1;
      if (lastIndex < 0) return conv;
      const last = {
        ...messages[lastIndex],
        loading: { ...messages[lastIndex].loading },
      };
      mutate(last);
      messages[lastIndex] = last;
      return { ...conv, messages };
    });
  };

  const handleSendMessage = async (content, attachments = []) => {
    const convId = currentConversationId;
    if (!convId) return;
    // Один активный запуск на диалог (форма одна, single-turn дизайн)
    if (activeRuns[convId]) return;
    const base = convCache[convId];
    if (!base) return;

    // Optimistically add user message to UI
    const userMessage = { role: 'user', content, attachments };

    // Create a partial assistant message that will be updated progressively
    const assistantMessage = {
      role: 'assistant',
      stage1: null,
      stage2: null,
      stage3: null,
      metadata: null,
      loading: {
        stage1: false,
        stage2: false,
        stage3: false,
      },
    };

    setActiveRuns((prev) => ({
      ...prev,
      [convId]: {
        ...base,
        messages: [...base.messages, userMessage, assistantMessage],
      },
    }));

    const finishRun = () => {
      setActiveRuns((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      // Подтянуть финальную сохранённую версию и список диалогов
      loadConversation(convId);
      loadConversations();
    };

    try {
      // Send message with streaming
      await api.sendMessageStream(convId, content, (eventType, event) => {
        switch (eventType) {
          case 'stage1_start':
            updateLastMessage(convId, (m) => {
              m.loading.stage1 = true;
            });
            break;

          case 'stage1_complete':
            updateLastMessage(convId, (m) => {
              m.stage1 = event.data;
              m.loading.stage1 = false;
            });
            break;

          case 'stage2_start':
            updateLastMessage(convId, (m) => {
              m.loading.stage2 = true;
            });
            break;

          case 'stage2_complete':
            updateLastMessage(convId, (m) => {
              m.stage2 = event.data;
              m.metadata = event.metadata;
              m.loading.stage2 = false;
            });
            break;

          case 'stage3_start':
            updateLastMessage(convId, (m) => {
              m.loading.stage3 = true;
            });
            break;

          case 'stage3_complete':
            updateLastMessage(convId, (m) => {
              m.stage3 = event.data;
              m.loading.stage3 = false;
            });
            break;

          case 'title_complete':
            // Reload conversations to get updated title
            loadConversations();
            break;

          case 'complete':
            finishRun();
            break;

          case 'error':
            console.error('Stream error:', event.message);
            finishRun();
            break;

          default:
            console.log('Unknown event type:', eventType);
        }
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      // Убираем оптимистичные сообщения при ошибке транспорта
      setActiveRuns((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      loadConversations();
    }
  };

  // Отображаемый диалог: живой запуск в приоритете над кэшем.
  const displayedConversation = currentConversationId
    ? activeRuns[currentConversationId] ?? convCache[currentConversationId] ?? null
    : null;
  const isCurrentRunning = Boolean(
    currentConversationId && activeRuns[currentConversationId]
  );

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
