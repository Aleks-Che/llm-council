import { useState, useEffect, useRef } from 'react';

import SettingsModal from './SettingsModal';
import UsersModal from './UsersModal';

import './Sidebar.css';

function plural(count, forms) {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

export default function Sidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
  activeSection,
  navVisible,
  researchVisible,
  onNavigate,
  user,
  onLogout,
}) {
  const [contextMenu, setContextMenu] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const editInputRef = useRef(null);
  const sidebarRef = useRef(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  useEffect(() => {
    const handleClick = (e) => {
      if (
        contextMenu &&
        !e.target.closest('.conversation-context-menu')
      ) {
        setContextMenu(null);
      }
    };
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setEditingId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [contextMenu]);

  const handleContextMenu = (e, conv) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      conversationId: conv.id,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const startRename = (conv) => {
    setEditingId(conv.id);
    setEditingTitle(conv.title || 'Новый диалог');
    setContextMenu(null);
  };

  const commitRename = () => {
    if (editingId && editingTitle.trim()) {
      onRenameConversation(editingId, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle('');
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingTitle('');
  };

  const handleDelete = (conv) => {
    const ok = window.confirm(
      `Удалить диалог «${conv.title || 'Новый диалог'}»? Это действие нельзя отменить.`
    );
    if (ok) {
      onDeleteConversation(conv.id);
    }
    setContextMenu(null);
  };

  const handleRenameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  return (
    <div className="sidebar" ref={sidebarRef}>
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <h1>LLM Совет</h1>
          <button
            className="settings-btn"
            title="Настройки совета"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙️
          </button>
        </div>
        <button className="new-conversation-btn" onClick={onNewConversation}>
          + Новый диалог
        </button>
      </div>

      <div className="conversation-list">
        {conversations.length === 0 ? (
          <div className="no-conversations">Пока нет диалогов</div>
        ) : (
          conversations.map((conv) => {
            const isEditing = editingId === conv.id;
            return (
              <div
                key={conv.id}
                className={`conversation-item ${
                  conv.id === currentConversationId ? 'active' : ''
                } ${isEditing ? 'editing' : ''}`}
                onClick={() => {
                  if (!isEditing) onSelectConversation(conv.id);
                }}
                onContextMenu={(e) => handleContextMenu(e, conv)}
              >
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    className="conversation-rename-input"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={handleRenameKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    maxLength={120}
                  />
                ) : (
                  <>
                    <div className="conversation-title">
                      {conv.title || 'Новый диалог'}
                    </div>
                    <div className="conversation-meta">
                      {conv.is_running ? (
                        <span className="conversation-running">
                          <span className="conversation-running-spinner" />
                          Выполняется...
                        </span>
                      ) : (
                        <>
                          {conv.message_count}{' '}
                          {plural(conv.message_count, [
                            'сообщение',
                            'сообщения',
                            'сообщений',
                          ])}
                        </>
                      )}
                    </div>
                    {conv.id === currentConversationId && navVisible && (
                      <div
                        className="conv-nav"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {[
                          { id: 'user', label: 'Запрос пользователя' },
                          ...(researchVisible ? [{ id: 'research', label: 'Поиск и источники' }] : []),
                          { id: 'stage1', label: 'Этап 1: Ответы' },
                          { id: 'stage2', label: 'Этап 2: Ранжирование' },
                          { id: 'stage3', label: 'Этап 3: Синтез' },
                        ].map((s) => (
                          <button
                            key={s.id}
                            className={`conv-nav-item ${
                              activeSection === s.id ? 'active' : ''
                            }`}
                            onClick={() => onNavigate?.(s.id)}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {contextMenu && (
        <div
          className="conversation-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              const conv = conversations.find(
                (c) => c.id === contextMenu.conversationId
              );
              if (conv) startRename(conv);
            }}
          >
            ✏️ Переименовать
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => {
              const conv = conversations.find(
                (c) => c.id === contextMenu.conversationId
              );
              if (conv) handleDelete(conv);
            }}
          >
            🗑️ Удалить
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        {user && (
          <div className="sidebar-user">
            <div className="sidebar-user-name">{user.username}</div>
            <div className="sidebar-user-role">{user.role}</div>
          </div>
        )}
        <div className="sidebar-footer-buttons">
          {user?.role === 'admin' && (
            <button
              className="sidebar-users-btn"
              onClick={() => setUsersOpen(true)}
              title="Управление пользователями"
            >
              Пользователи
            </button>
          )}
          <button
            className="sidebar-logout-btn"
            onClick={onLogout}
            title="Выйти"
          >
            Выйти
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}

      {usersOpen && user && (
        <UsersModal
          onClose={() => setUsersOpen(false)}
          currentUserId={user.id}
        />
      )}
    </div>
  );
}
