import { useState } from 'react';

export default function CustomModelForm({ initial, onApply, onCancel }) {
  const [url, setUrl] = useState(initial?.url || '');
  const [apiKey, setApiKey] = useState(initial?.api_key || '');
  const [model, setModel] = useState(initial?.model || '');
  const [reasoningEnabled, setReasoningEnabled] = useState(initial?.reasoning_effort != null);
  const [effort, setEffort] = useState(initial?.reasoning_effort || 'medium');
  const [error, setError] = useState('');

  const submit = (event) => {
    event.preventDefault();
    let endpoint;
    try {
      endpoint = new URL(url.trim());
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash || /\s/.test(url.trim())) throw new Error();
    } catch {
      setError('Укажите HTTP(S) URL API без логина, пароля и параметров');
      return;
    }
    if (!model.trim()) {
      setError('Укажите название модели');
      return;
    }
    // getRandomValues also works when the app is opened over HTTP on the LAN.
    const id = initial?.id || `custom/${Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    onApply({ id, url: url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, ''),
      model: model.trim(), api_key: apiKey.trim() || null,
      key_configured: initial?.key_configured || false,
      reasoning_effort: reasoningEnabled ? effort : null });
  };

  return (
    <form className="settings-custom-form" onSubmit={submit} aria-label={initial ? 'Редактирование модели' : 'Новая модель'}>
      <label className="settings-field" htmlFor="custom-model-url">OpenAI compatible URL</label>
      <input id="custom-model-url" className="settings-chairman-select" type="url" required maxLength={2048}
        placeholder="https://api.example.com/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
      <p className="settings-search-hint">Базовый URL API, включая /v1, если он нужен провайдеру.</p>

      <label className="settings-field" htmlFor="custom-model-key">API key</label>
      <input id="custom-model-key" className="settings-chairman-select" type="password" autoComplete="new-password"
        maxLength={4096} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
        placeholder={initial?.key_configured ? 'Ключ сохранён. Введите новый для замены' : 'Необязательно для локального API'} />
      {initial?.key_configured && url.trim().replace(/\/+$/, '') !== initial.url && (
        <p className="settings-search-hint">Для нового URL введите новый ключ, если API требует авторизацию.</p>
      )}

      <label className="settings-field" htmlFor="custom-model-name">Модель</label>
      <input id="custom-model-name" className="settings-chairman-select" required maxLength={256}
        placeholder="Идентификатор модели у провайдера" value={model} onChange={(e) => setModel(e.target.value)} />

      <label className="settings-reasoning-toggle">
        <input type="checkbox" checked={reasoningEnabled} onChange={(e) => setReasoningEnabled(e.target.checked)} />
        Reasoning effort
      </label>
      {reasoningEnabled && <>
        <label className="settings-field" htmlFor="custom-reasoning-effort">Режим рассуждений</label>
        <select id="custom-reasoning-effort" className="settings-chairman-select" value={effort}
          onChange={(e) => setEffort(e.target.value)}>
          {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) =>
            <option key={value} value={value}>{value}</option>)}
        </select>
        <p className="settings-search-hint">Выберите значение, которое поддерживает ваша модель.</p>
      </>}
      {error && <div className="settings-error" role="alert">{error}</div>}
      <div className="settings-actions">
        <button className="settings-save-btn" type="submit">{initial ? 'Применить' : 'Добавить'}</button>
        <button className="settings-cancel-btn" type="button" onClick={onCancel}>Отменить ввод</button>
      </div>
      <p className="settings-search-hint">Изменения будут записаны после нажатия «Сохранить» в настройках.</p>
    </form>
  );
}
