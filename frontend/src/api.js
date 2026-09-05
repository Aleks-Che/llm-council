const API_BASE = '';
const TOKEN_KEY = 'llmcouncil_token';

let onUnauthorized = null;

export function setOnUnauthorized(cb) {
  onUnauthorized = cb;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — сессия не сохранится
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage недоступен — игнорируем
  }
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error('Сервер недоступен');
  }

  // 401 эндпоинта логина — это «неверный логин/пароль», а не истёкшая
  // сессия: не сбрасываем токен и показываем detail от сервера.
  const isLogin = path === '/api/auth/login';
  if (response.status === 401 && !isLogin) {
    clearToken();
    if (onUnauthorized) onUnauthorized();
    throw new Error('Не авторизован');
  }

  const ct = response.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    try {
      data = { detail: await response.text() };
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`);
  }
  return data;
}

export const api = {
  login: (username, password) =>
    request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  me: () => request('/api/auth/me'),

  changePassword: (old_password, new_password) =>
    request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ old_password, new_password }),
    }),

  listUsers: () => request('/api/auth/users'),

  createUser: (data) =>
    request('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateUser: (id, data) =>
    request(`/api/auth/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteUser: (id) =>
    request(`/api/auth/users/${id}`, { method: 'DELETE' }),

  listConversations: () => request('/api/conversations'),

  createConversation: () =>
    request('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  getConversation: (id) => request(`/api/conversations/${id}`),

  renameConversation: (id, title) =>
    request(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteConversation: (id) =>
    request(`/api/conversations/${id}`, { method: 'DELETE' }),

  sendMessage: (id, content) =>
    request(`/api/conversations/${id}/message`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  getSettings: () => request('/api/settings'),

  saveSettings: (settings) =>
    request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  testModel: (model) =>
    request('/api/settings/test-model', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
};
