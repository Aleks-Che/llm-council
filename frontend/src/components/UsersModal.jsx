import { useState, useEffect } from 'react';
import { api } from '../api';
import './UsersModal.css';

export default function UsersModal({ onClose, currentUserId }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [createError, setCreateError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState('user');
  const [editError, setEditError] = useState(null);
  const [editSaving, setEditSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setUsers(await api.listUsers());
      setError(null);
    } catch (e) {
      setError(e.message || 'Не удалось загрузить пользователей');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError(null);
    try {
      await api.createUser({
        username: newUsername,
        password: newPassword,
        role: newRole,
      });
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      setCreating(false);
      await load();
    } catch (err) {
      setCreateError(err.message || 'Ошибка создания');
    }
  };

  const handleDelete = async (u) => {
    if (u.id === currentUserId) return;
    if (!window.confirm(`Удалить пользователя «${u.username}»?`)) return;
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e) {
      window.alert(e.message || 'Не удалось удалить');
    }
  };

  const startEdit = (u) => {
    setEditingId(u.id);
    setEditUsername(u.username);
    setEditPassword('');
    setEditRole(u.role);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditError(null);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    setEditError(null);
    const payload = {};
    if (editUsername.trim()) payload.username = editUsername.trim();
    if (editPassword) payload.password = editPassword;
    payload.role = editRole;
    if (!editUsername.trim()) {
      setEditError('Имя пользователя не может быть пустым');
      return;
    }
    setEditSaving(true);
    try {
      await api.updateUser(editingId, payload);
      setEditingId(null);
      await load();
    } catch (err) {
      setEditError(err.message || 'Не удалось сохранить');
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="users-overlay" onClick={onClose}>
      <div
        className="users-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Пользователи"
      >
        <div className="users-header">
          <h2>Пользователи</h2>
          <button className="users-close" onClick={onClose} title="Закрыть">
            ×
          </button>
        </div>

        {loading ? (
          <div className="users-loading">Загрузка…</div>
        ) : error ? (
          <div className="users-error">{error}</div>
        ) : (
          <>
            <div className="users-list">
              {users.map((u) => {
                const isEditing = editingId === u.id;
                return (
                  <div
                    key={u.id}
                    className={`users-item ${isEditing ? 'editing' : ''}`}
                    onClick={isEditing ? (e) => e.stopPropagation() : undefined}
                  >
                    {isEditing ? (
                      <form
                        className="users-create-form"
                        onSubmit={submitEdit}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          className="users-input"
                          placeholder="Имя пользователя"
                          value={editUsername}
                          onChange={(e) => setEditUsername(e.target.value)}
                          required
                        />
                        <input
                          className="users-input"
                          type="password"
                          placeholder="Новый пароль (не менять — оставьте пустым)"
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          minLength={editPassword ? 6 : undefined}
                        />
                        <select
                          className="users-select"
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                        </select>
                        {editError && (
                          <div className="users-error">{editError}</div>
                        )}
                        <div className="users-actions">
                          <button
                            type="submit"
                            className="users-btn-primary"
                            disabled={editSaving}
                          >
                            {editSaving ? 'Сохранение…' : 'Сохранить'}
                          </button>
                          <button
                            type="button"
                            className="users-btn-secondary"
                            onClick={cancelEdit}
                          >
                            Отмена
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div>
                          <div className="users-name">
                            {u.username}
                            {u.id === currentUserId ? ' (вы)' : ''}
                          </div>
                          <div className="users-role">{u.role}</div>
                        </div>
                        <div className="users-actions">
                          <button
                            className="users-edit-btn"
                            onClick={() => startEdit(u)}
                            title="Редактировать"
                          >
                            ✏️
                          </button>
                          {u.id !== currentUserId && (
                            <button
                              className="users-delete-btn"
                              onClick={() => handleDelete(u)}
                            >
                              Удалить
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {creating ? (
              <form className="users-create-form" onSubmit={handleCreate}>
                <input
                  className="users-input"
                  placeholder="Имя пользователя"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                />
                <input
                  className="users-input"
                  type="password"
                  placeholder="Пароль (≥ 6 символов)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                />
                <select
                  className="users-select"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
                {createError && <div className="users-error">{createError}</div>}
                <div className="users-actions">
                  <button type="submit" className="users-btn-primary">
                    Создать
                  </button>
                  <button
                    type="button"
                    className="users-btn-secondary"
                    onClick={() => {
                      setCreating(false);
                      setCreateError(null);
                    }}
                  >
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="users-add-btn"
                onClick={() => setCreating(true)}
              >
                + Добавить пользователя
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
