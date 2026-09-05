import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import Login from './components/Login';
import ErrorBoundary from './components/ErrorBoundary';
import { api, setOnUnauthorized, clearToken, getToken } from './api';
import './App.css';

const CONVERSATION_POLL_MS = 2000;
const LIST_POLL_MS = 3000;

function conversationFingerprint(conv) {
  const messages = conv?.messages ?? [];
  const parts = [String(messages.length)];
  for (const m of messages) {
    if (m.role === 'assistant') {
      parts.push(
        [
          m.status ?? '',
          m.current_stage ?? '',
          m.research?.revision ?? 0,
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
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [convCache, setConvCache] = useState({});
  const [activeSection, setActiveSection] = useState('stage3');
  const chatScrollRef = useRef(null);
  const fpRef = useRef({});

  useEffect(() => {
    setOnUnauthorized(() => {
      clearToken();
      setUser(null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setAuthLoading(false);
      return;
    }
    (async () => {
      try {
        const u = await api.me();
        if (!cancelled) setUser(u);
      } catch {
        if (!cancelled) {
          clearToken();
          setUser(null);
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = () => {
    clearToken();
    setUser(null);
    setConversations([]);
    setConvCache({});
    setCurrentConversationId(null);
    fpRef.current = {};
  };

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
      if (fpRef.current[id] === fp) return;
      fpRef.current[id] = fp;
      setConvCache((prev) => ({ ...prev, [id]: conv }));
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  };

  useEffect(() => {
    if (!user) return;
    loadConversations();
  }, [user]);

  const anyRunning = conversations.some((c) => c.is_running);

  useEffect(() => {
    if (!user || !anyRunning) return;
    const timer = setInterval(loadConversations, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [user, anyRunning]);

  useEffect(() => {
    if (!user || !currentConversationId) return;
    const running = conversations.some(
      (c) => c.id === currentConversationId && c.is_running
    );
    loadConversation(currentConversationId);
    if (!running) return;
    const timer = setInterval(
      () => loadConversation(currentConversationId),
      CONVERSATION_POLL_MS
    );
    return () => clearInterval(timer);
  }, [user, currentConversationId, conversations]);

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

  const getLastAvailableSection = (conv) => {
    const last = conv?.messages?.[conv.messages.length - 1];
    if (last?.role === 'assistant') {
      if (last.stage3) return 'stage3';
      if (last.stage2) return 'stage2';
      if (last.stage1) return 'stage1';
      if (last.research) return 'research';
    }
    return 'user';
  };

  const handleSelectConversation = (id) => {
    setCurrentConversationId(id);
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

  const handleSendMessage = async (content, attachments = [], searchEnabled = false) => {
    const convId = currentConversationId;
    if (!convId) return;
    const base = convCache[convId];
    if (!base) return;
    if (
      base.messages.length > 0 ||
      conversations.some((c) => c.id === convId && c.is_running)
    ) {
      return;
    }

    const userMessage = { role: 'user', content, attachments, search_enabled: searchEnabled };
    const assistantMessage = {
      role: 'assistant',
      stage1: null,
      stage2: null,
      stage3: null,
      metadata: null,
      status: 'running',
      current_stage: searchEnabled ? 'research' : 'stage1',
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
      await api.sendMessage(convId, content, searchEnabled);
      await loadConversations();
    } catch (error) {
      console.error('Failed to send message:', error);
      setConvCache((prev) => ({ ...prev, [convId]: base }));
      delete fpRef.current[convId];
      throw error;
    }
  };

  if (authLoading) {
    return <div className="app-loading">Загрузка…</div>;
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

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
        researchVisible={Boolean(lastMessage?.research || lastMessage?.current_stage === 'research')}
        onNavigate={(sectionId) => chatScrollRef.current?.(sectionId)}
        user={user}
        onLogout={handleLogout}
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
